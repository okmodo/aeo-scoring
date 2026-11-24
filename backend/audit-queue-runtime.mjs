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
import {readStructureFindings,scorePreparedFindings} from './prepared-structure-checkpoint.mjs';
import {scorePreparedDomainStructure} from './browser-support.mjs';
import {createAuditResultStore} from './audit-check-results.mjs';

export const AUDIT_QUEUE_NAME = 'aeo-audit-checkpoints';
export const AUDIT_DEAD_QUEUE_NAME = 'aeo-audit-checkpoints-dead';
const INVOCATION_COSTS = {requests:1,cpuMs:RESERVED_INVOCATION_CPU_MS,d1Reads:10_000,d1Writes:200,d1StorageBytes:512*1024};
const encoder = new TextEncoder();
const publicErrors = new Set(['retrieval_failed','retrieval_timeout','response_too_large','unsupported_content','assessment_timeout']);
const unavailable = () => ({accepted:false,reason:'invalid_evidence'});

export function createAuditQueueRuntime(env, {now=Date.now,allowance:givenAllowance,queueAllowance:givenQueueAllowance,
  workflow:givenWorkflow,snapshots:givenSnapshots,prepare=runPreparation,assess=runPreparedAudit,derive=derivePreparedObservations,inspectDomain=scorePreparedDomainStructure,inspectPolicies}={}) {
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

  const results = createAuditResultStore(db);

  async function runStep({auditId,phase,owner,sequence}) {
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
      try {
        const pipeline = createPipelineState({db,auditId,now});
        await pipeline.load();
        if (!pipeline.summary().stages.some(x=>x.code==='preparation_started') && pipeline.summary().stages.length<15) await pipeline.record('preparation','running','preparation_started',{owner,sequence,state:'running'});
      } catch { /* Diagnostics must not block preparation. */ }
      const result = await prepare({env,auditId,now,allowance,workflow:workflow()});
      if(result.status!=='ready') throw Error('queue_preparation_unavailable');
      return {next:'assess'};
    }
    const pending = await results.pending(auditId);
    if (pending) {
      if (pending.sequence === sequence) {
        if (!await results.publish(auditId,{now:now(),sequence,owner})) throw Error('queue_publish_lease_lost');
        return {next:null};
      }
      if (pending.sequence === sequence+1) return {next:'assess'};
      throw Error('queue_result_sequence_mismatch');
    }
    if(retained?.prepared_state!=='ready') return {next:null,code:'assessment_timeout'};
    const result = await assess({env,auditId,now,allowance,snapshots:snapshots(),derive,inspectDomain,inspectPolicies,queueLease:{owner,sequence}});
    if (await results.pending(auditId)) return {next:'assess'};
    if(result.status==='yield') return {next:'assess'};
    if(result.status==='completed') return {next:null};
    if(result.status==='waiting' || result.code==='assessment_not_claimed' || (keyed && result.code==='job_lease_lost')) throw Error('queue_assessment_unavailable');
    return {next:null,code:result.code??'assessment_timeout'};
  }

  async function finalize({auditId,phase,code,owner,sequence}) {
    const audit = await readAudit(auditId);
    if(!audit || audit.status!=='pending') return;
    const pending = await results.pending(auditId);
    if (pending) {
      if (!await results.publish(auditId,{now:now(),sequence,owner,terminalizing:true})) throw Error('queue_terminal_lease_lost');
      return;
    }
    const retained = await readSnapshot(auditId);
    const hasUsableCapture = retained?.state==='ready' && (phase!=='capture' || code!=='retrieval_failed');
    let report = null, assessedUrl = null, error = null;
    if(hasUsableCapture) {
      const store = snapshots();
      const input = retained.prepared_state==='ready' ? await store.readPrepared(auditId).catch(()=>null) : null;
      let derived, assessment, programmaticStructure;
      if(input) {
        programmaticStructure = await readStructureFindings(db,auditId,input.source.preparedHash,now());
        const hasSavedModelReply = keyed && await db.prepare(`SELECT 1 FROM model_attempts
          WHERE audit_id=?1 AND prepared_hash=?2 AND response_body_base64 IS NOT NULL AND http_status BETWEEN 200 AND 299 LIMIT 1`)
          .bind(auditId,input.source.preparedHash).first();
        if (!programmaticStructure || hasSavedModelReply || retained.facts_state==='ready') {
          derived = await derive(input,{keyed}).catch(()=>undefined);
        }
        if (!programmaticStructure && derived) {
          programmaticStructure = scorePreparedFindings(input.snapshot,derived);
        }
        if (keyed && derived && hasSavedModelReply) {
          assessment = await recoverKeyedAuditAssessment({ db, auditId, input, derived }).catch(()=>undefined);
        } else if(retained.facts_state==='ready') {
          try {
            const facts = await store.readAssessment(auditId,'facts');
            if(facts) assessment = await restoreRubricAssessment(input.snapshot,input.extracted,facts);
          } catch { /* Unverified model output earns no credit. */ }
        }
      }
      // Recovery can validate retained judgments even after the original worker stopped.
      try {
        const pipeline = createPipelineState({db,auditId,now});
        await pipeline.load();
        const record = async (stage,status,code) => {
          if (!pipeline.summary().stages.some(x=>x.code===code) && pipeline.summary().stages.length<16) await pipeline.record(stage,status,code,{owner,sequence,state:'terminalizing'});
        };
        await record('content',assessment ? 'completed' : 'failed',assessment ? 'judgments_recovered' : 'assessment_interrupted');
        await record('scoring','running','report_building');
      } catch { /* Publication remains authoritative. */ }
      report = input
        ? scoreAudit(input.snapshot,input.extracted,{initialExtracted:input.snapshot.browser.initialExtracted,deterministicExtracted:derived,programmaticStructure,requireAiAssessment:true,aiAssessment:keyed ? null : assessment,graniteAssessment:keyed ? assessment : null})
        : scoreAudit({url:audit.url},{coverage:{html:false,usable:false}},{requireAiAssessment:true});
      assessedUrl = input?.snapshot.url ?? audit.url;
      report.status = 'incomplete';
      report.score = null;
      report.coverage.limitations.push('The queued assessment did not finish. Unresolved checks remain unmeasured.');
      if(encoder.encode(JSON.stringify(report)).length>256*1024) throw Error('queue_report_size_limit');
    } else error = publicErrors.has(code) ? code : 'assessment_timeout';
    const at = now();
    if (report) {
      if (!await results.stage(auditId,{report,assessedUrl,now:at,sequence,owner,terminalizing:true}) ||
          !await results.publish(auditId,{now:now(),sequence,owner,terminalizing:true})) throw Error('queue_terminal_lease_lost');
      return;
    }
    const result = await db.prepare(`UPDATE audits SET status='unable_to_assess',report_json=NULL,error_json=?2,
      completed_at=?3,cache_until=NULL,assessed_url=NULL
      WHERE id=?1 AND status='pending' AND expires_at>?3 AND EXISTS (
        SELECT 1 FROM audit_queue_jobs WHERE audit_id=?1 AND state='terminalizing' AND owner=?4 AND sequence=?5 AND lease_until>?3
      )`).bind(auditId,JSON.stringify(error),at,owner,sequence).run();
    if(result.meta.changes!==1 && (await readAudit(auditId))?.status==='pending') throw Error('queue_terminal_lease_lost');
  }

  const queue = createAuditQueue({db,queue:env.AUDIT_QUEUE,reserveSend:()=>queueAllowance.reserve({now:now()}),runStep,finalize,messageFor:async row=>{
    const pending=await results.pending(row.audit_id);
    return pending?.sequence===row.sequence
      ? {auditId:row.audit_id,sequence:row.sequence,kind:'finalize_report',rubricVersion:pending.rubricVersion}
      : {auditId:row.audit_id,sequence:row.sequence};
  },now});
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
