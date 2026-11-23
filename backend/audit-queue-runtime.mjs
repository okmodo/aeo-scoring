import {recoverKeyedAuditAssessment} from './granite-keyed-prepared.mjs';
import {keyedGraniteEnabled} from './prepared-assessment-policy.mjs';
import {createAuditQueue,AUDIT_QUEUE_MAX_BATCH_SIZE} from './audit-queue.mjs';
import {createAuditQueueAllowance} from './audit-queue-allowance.mjs';
import {createAnalyticsAllowanceGuard} from './analytics-allowance.mjs';
import {createR2AllowanceGuard} from './allowance-r2.mjs';
import {RESERVED_INVOCATION_CPU_MS} from './allowance-policy.mjs';
import {createBrowserContentWorkflow} from './browser-content-workflow.mjs';
import {createPipelineState} from './pipeline-state.mjs';
import {createSnapshotStore} from './snapshot-store.mjs';
import {runPreparation} from './service.mjs';
import {runPreparedAudit} from './prepared-assessment-consumer.mjs';
import {derivePreparedObservations} from './prepared-derived.mjs';
import {restoreRubricAssessment} from './ai-rubric-assessment.mjs';
import {scoreAudit} from './scoring.mjs';

export const AUDIT_QUEUE_NAME = 'aeo-audit-checkpoints';
export const AUDIT_DEAD_QUEUE_NAME = 'aeo-audit-checkpoints-dead';
const INVOCATION_COSTS = {requests:1,cpuMs:RESERVED_INVOCATION_CPU_MS,d1Reads:10_000,d1Writes:200,d1StorageBytes:512*1024};
const hour = 3_600_000;
const encoder = new TextEncoder();
const publicErrors = new Set(['retrieval_failed','retrieval_timeout','response_too_large','unsupported_content','assessment_timeout']);
const unavailable = () => ({accepted:false,reason:'invalid_evidence'});

export function createAuditQueueRuntime(env, {now=Date.now,allowance:givenAllowance,queueAllowance:givenQueueAllowance,
  workflow:givenWorkflow,snapshots:givenSnapshots,prepare=runPreparation,assess=runPreparedAudit,derive=derivePreparedObservations}={}) {
  const db = env?.AUDIT_DB;
  if(env?.AUDIT_QUEUE_MODE!=='enabled' || !db?.prepare || typeof env.AUDIT_QUEUE?.send!=='function') return {start:async()=>unavailable(),consume:async()=>{throw Error('audit_queue_disabled');}};
  const keyed = keyedGraniteEnabled(env);
  const scope = {accountId:env.AUDIT_BILLING_ACCOUNT_ID,subscriptionId:env.AUDIT_BILLING_SUBSCRIPTION_ID,token:env.AUDIT_USAGE_READ_TOKEN};
  const allowance = givenAllowance ?? createAnalyticsAllowanceGuard(db,scope);
  const queueAllowance = givenQueueAllowance ?? createAuditQueueAllowance(db,scope);
  const snapshots = () => givenSnapshots ?? createSnapshotStore({db,bucket:env.AUDIT_SNAPSHOTS,allowance:createR2AllowanceGuard(db,scope),now});
  const workflow = () => givenWorkflow ?? createBrowserContentWorkflow({db,binding:env.AUDIT_BROWSER,snapshots:snapshots(),...scope,now});
  const readAudit = id => db.prepare('SELECT id, url, status, created_at, expires_at FROM audits WHERE id=?1 AND expires_at>?2').bind(id,now()).first();
  const readSnapshot = id => db.prepare('SELECT state, prepared_state, facts_state FROM retained_snapshots WHERE audit_id=?1 AND expires_at>?2').bind(id,now()).first();

  async function runStep({auditId,phase}) {
    const audit = await readAudit(auditId);
    if(!audit || audit.status!=='pending') return {next:null};
    const retained = await readSnapshot(auditId);
    if(phase==='capture') {
      if(retained?.prepared_state==='ready') return {next:'prepare'};
      const work = await db.prepare('SELECT state FROM browser_audit_work WHERE audit_id=?1').bind(auditId).first();
      if(retained?.state==='ready') {
        if(['ready','assessing','finished'].includes(work?.state)) return {next:'prepare'};
        const saved = await snapshots().read(auditId);
        if(saved?.snapshot?.retrievalMethod!=='browser_api_content' || !Number.isInteger(saved.snapshot.status) ||
            saved.snapshot.status<200 || saved.snapshot.status>=300) return {next:null,code:'retrieval_failed'};
        // The provider reply was persisted before the original invocation
        // stopped. Restore the handoff without starting another Browser call.
        await db.prepare(`INSERT INTO browser_audit_work VALUES (?1,'ready',?2,?3)
          ON CONFLICT(audit_id) DO UPDATE SET state='ready',expires_at=excluded.expires_at WHERE browser_audit_work.state='capturing'`)
          .bind(auditId,now(),audit.expires_at).run();
        return {next:'prepare'};
      }
      const browser = workflow();
      const input = {id:auditId,url:audit.url,createdAt:audit.created_at,expiresAt:audit.expires_at};
      const grant = work?.state==='capturing' ? {id:'content-'+auditId,accepted:true} : await browser.prepare({...input,createdAt:now()});
      if(!grant?.accepted) return {next:null,code:'retrieval_failed'};
      const pipeline = createPipelineState({db,auditId,now});
      await pipeline.load();
      if(!pipeline.summary().stages.length) await pipeline.record('retrieval','running','browser_loading');
      try { await browser.capture(input,grant,pipeline); }
      catch(error) { return {next:null,code:publicErrors.has(error?.code)?error.code:'retrieval_failed'}; }
      return {next:'prepare'};
    }
    if(phase==='prepare') {
      if(retained?.prepared_state==='ready') return {next:'assess'};
      if(retained?.state!=='ready') return {next:null,code:'retrieval_failed'};
      const pipeline = createPipelineState({db,auditId,now});
      await pipeline.load();
      if (!pipeline.summary().stages.some(x=>x.stage==='preparation' && x.status==='running')) await pipeline.record('preparation','running','preparation_started');
      const result = await prepare({env,auditId,now,allowance,workflow:workflow()});
      if(result.status!=='ready') throw Error('queue_preparation_unavailable');
      if (!pipeline.summary().stages.some(x=>x.stage==='preparation' && x.status==='completed')) await pipeline.record('preparation','completed','preparation_ready');
      return {next:'assess'};
    }
    if(retained?.prepared_state!=='ready') return {next:null,code:'assessment_timeout'};
    const result = await assess({env,auditId,now,allowance,snapshots:snapshots(),derive});
    if(result.status==='yield') return {next:'assess'};
    if(result.status==='completed') return {next:null};
    if(result.status==='waiting' || result.code==='assessment_not_claimed' || (keyed && result.code==='job_lease_lost')) throw Error('queue_assessment_unavailable');
    return {next:null,code:result.code??'assessment_timeout'};
  }

  async function finalize({auditId,phase,code,owner,sequence}) {
    const audit = await readAudit(auditId);
    if(!audit || audit.status!=='pending') return;
    const retained = await readSnapshot(auditId);
    const hasUsableCapture = retained?.state==='ready' && (phase!=='capture' || code!=='retrieval_failed');
    let report = null, assessedUrl = null, error = null;
    if(hasUsableCapture) {
      // Progress is advisory; a diagnostics outage must not prevent a partial report.
      try {
        const pipeline = createPipelineState({db,auditId,now});
        await pipeline.load();
        if (!pipeline.summary().stages.some(x=>x.stage==='scoring' && x.status==='running') && pipeline.summary().stages.length<16) await pipeline.record('scoring','running','report_building');
      } catch { /* Terminal publication remains authoritative. */ }
      const store = snapshots();
      const input = retained.prepared_state==='ready' ? await store.readPrepared(auditId).catch(()=>null) : null;
      let derived, assessment;
      if(input) {
        derived = await derive(input,{keyed}).catch(()=>undefined);
        if (keyed && derived) {
          assessment = await recoverKeyedAuditAssessment({ db, auditId, input, derived }).catch(()=>undefined);
        } else if(retained.facts_state==='ready') {
          try {
            const facts = await store.readAssessment(auditId,'facts');
            if(facts) assessment = await restoreRubricAssessment(input.snapshot,input.extracted,facts);
          } catch { /* Unverified model output earns no credit. */ }
        }
      }
      report = input
        ? scoreAudit(input.snapshot,input.extracted,{initialExtracted:input.snapshot.browser.initialExtracted,deterministicExtracted:derived,requireAiAssessment:true,aiAssessment:assessment})
        : scoreAudit({url:audit.url},{coverage:{html:false,usable:false}},{requireAiAssessment:true});
      assessedUrl = input?.snapshot.url ?? audit.url;
      report.status = 'incomplete';
      report.score = null;
      report.coverage.limitations.push('The queued assessment did not finish. Unresolved checks remain unmeasured.');
      if(encoder.encode(JSON.stringify(report)).length>256*1024) throw Error('queue_report_size_limit');
    } else error = publicErrors.has(code) ? code : 'assessment_timeout';
    const at = now();
    const result = await db.prepare(`UPDATE audits SET status=?2,report_json=?3,error_json=?4,completed_at=?5,cache_until=?6,assessed_url=?7
      WHERE id=?1 AND status='pending' AND expires_at>?5 AND EXISTS (
        SELECT 1 FROM audit_queue_jobs WHERE audit_id=?1 AND state='terminalizing' AND owner=?8 AND sequence=?9 AND lease_until>?5
      )`).bind(auditId,report?'incomplete':'unable_to_assess',report?JSON.stringify(report):null,error?JSON.stringify(error):null,
        at,report?Math.min(at+hour,audit.expires_at):null,assessedUrl,owner,sequence).run();
    if(result.meta.changes!==1 && (await readAudit(auditId))?.status==='pending') throw Error('queue_terminal_lease_lost');
  }

  const queue = createAuditQueue({db,queue:env.AUDIT_QUEUE,reserveSend:()=>queueAllowance.reserve({now:now()}),runStep,finalize,now});
  return {
    start:queue.start,
    async consume(batch) {
      if(![AUDIT_QUEUE_NAME,AUDIT_DEAD_QUEUE_NAME].includes(batch.queue)) throw Error('unknown_audit_queue');
      if(batch.messages.length>AUDIT_QUEUE_MAX_BATCH_SIZE) throw Error('invalid_audit_queue_batch_size');
      const id = 'queue-'+crypto.randomUUID();
      const admitted = await allowance.reserve({id,now:now(),costs:INVOCATION_COSTS});
      if(!admitted?.accepted || admitted.duplicate!==false) throw Error('queue_invocation_admission_denied');
      try { await queue.handle(batch,{deadLetter:batch.queue===AUDIT_DEAD_QUEUE_NAME}); }
      finally { await allowance.settle({id,now:now()}).catch(()=>{}); }
    },
  };
}
