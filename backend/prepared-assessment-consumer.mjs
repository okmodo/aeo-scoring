import {createTerraByokProvider} from './terra-byok-provider.mjs';
import {createAnalyticsAllowanceGuard} from './analytics-allowance.mjs';
import {createR2AllowanceGuard} from './allowance-r2.mjs';
import {RESERVED_INVOCATION_CPU_MS} from './allowance-policy.mjs';
import {createSnapshotStore} from './snapshot-store.mjs';
import {createPreparedAssessmentJobs} from './prepared-assessment-jobs.mjs';
import {runPreparedAssessmentStep} from './prepared-assessment-engine.mjs';
import {createStore} from './store.mjs';
import {createPipelineState,PIPELINE_VERSION} from './pipeline-state.mjs';
import {scoreAudit} from './scoring.mjs';
import {derivePreparedObservations} from './prepared-derived.mjs';
import {OPEN_RUBRIC_RELEASE_ID} from './ai-rubric-assessment.mjs';
import {CONTENT_FACTS_RELEASE_ID} from './content-facts-runner.mjs';

import {PREPARED_ASSESSMENT_POLICY} from './prepared-assessment-policy.mjs';
export {PREPARED_ASSESSMENT_POLICY};
const COSTS={requests:1,cpuMs:RESERVED_INVOCATION_CPU_MS,d1Reads:10000,d1Writes:200,d1StorageBytes:512*1024};
const empty=()=>({productHtml:null,jsonLd:[],coverage:{html:false,usable:false,jsonLdTruncated:true}});
const validId=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
const scope=env=>({accountId:env.AUDIT_BILLING_ACCOUNT_ID,subscriptionId:env.AUDIT_BILLING_SUBSCRIPTION_ID,token:env.AUDIT_USAGE_READ_TOKEN});
const activated=env=>env.AUDIT_RUBRIC_RELEASE===OPEN_RUBRIC_RELEASE_ID&&env.AUDIT_CONTENT_RELEASE===CONTENT_FACTS_RELEASE_ID&&env.AUDIT_PIPELINE_RELEASE===PIPELINE_VERSION;
const safeCode=error=>/^[a-z][a-z0-9_]{0,63}$/.test(error?.code||'')?error.code:'assessment_failed';

// Only this consumer performs AI work. Preparation readiness is never changed.
// Dependencies are injectable for offline tests; production uses canonical guards.
export async function runPreparedAudit({env,auditId,now=Date.now,allowance:givenAllowance,snapshots:givenSnapshots,jobs:givenJobs,
  modelProvider,fetch:fetchImpl,engine=runPreparedAssessmentStep,scorePage=scoreAudit,derive=derivePreparedObservations}={}) {
  if(!validId(auditId)||!env?.AUDIT_DB)return{status:'skipped',code:'invalid_audit'};
  const db=env.AUDIT_DB,config=scope(env),allowance=givenAllowance??createAnalyticsAllowanceGuard(db,config);
  const reservation='prepared-worker-'+crypto.randomUUID();
  const admitted=await allowance.reserve({id:reservation,costs:COSTS,now:now()}).catch(()=>null);
  if(!admitted?.accepted||admitted.duplicate!==false)return{status:'waiting',code:'usage_admission_denied'};
  let grant,input,report,audit;const jobs=givenJobs??createPreparedAssessmentJobs(db,{now}),store=createStore(db),pipeline=createPipelineState({db,auditId,now});
  const snapshots=givenSnapshots??createSnapshotStore({db,bucket:env.AUDIT_SNAPSHOTS,allowance:createR2AllowanceGuard(db,config),now});
  const record=async(stage,status,code)=>{const items=pipeline.summary().stages;if(!items.some(x=>x.stage===stage&&x.code===code)&&items.length<11)await pipeline.record(stage,status,code);};
  const persist=async(kind,artifact)=>{try{await snapshots.saveAssessment({auditId,kind,artifact});}catch(error){if(error.code!=='snapshot_exists')throw error;const stored=await snapshots.readAssessment(auditId,kind);if(JSON.stringify(stored)!==JSON.stringify(artifact))throw Object.assign(Error('Conflicting retained assessment'),{code:'assessment_artifact_conflict'});}};
  const publish=async(code,complete=false)=>{
    await jobs.assertLease(grant);
    if(!report){
      const derived=input ? await derive(input).catch(()=>null) : null;
      report=input ? scorePage(input.snapshot,input.extracted,{initialExtracted:input.snapshot.browser.initialExtracted,deterministicExtracted:derived,requireAiAssessment:true}) : scorePage({url:audit.url,status:200,contentType:'text/html'},empty(),{requireAiAssessment:true});
    }
    if(!complete){report.status='incomplete';report.score=null;report.coverage.limitations.push('Prepared assessment did not finish ('+code+'); unresolved checks remain unmeasured.');await record('content','failed',code);}
    await record('scoring','completed',report.status==='complete'?'report_complete':'report_incomplete');
    report.coverage.pipeline=pipeline.summary();
    if(new TextEncoder().encode(JSON.stringify(report)).length>256*1024)throw Object.assign(Error('Report too large'),{code:'report_size_limit'});
    const completedAt=now();const stored=await store.finishPrepared(auditId,{grant,status:report.status,report,completedAt,cacheUntil:Math.min(completedAt+3600000,audit.expires_at),assessedUrl:input?.snapshot.url??audit.url});
    if(!stored)throw Object.assign(Error('Report publication lease lost'),{code:'job_lease_lost'});
  };
  try {
    const t=now();
    audit=await db.prepare('SELECT * FROM audits WHERE id=?1 AND expires_at>?2').bind(auditId,t).first();
    if(!audit||!['pending','incomplete'].includes(audit.status))return{status:'skipped',code:'audit_not_pending'};
    const ready=await db.prepare("SELECT prepared_hash FROM retained_snapshots WHERE audit_id=?1 AND prepared_state='ready' AND state='ready' AND created_at<=?2 AND expires_at>?2").bind(auditId,t).first();
    if(!ready)return{status:'waiting',code:'prepared_not_ready'};
    // Retained assessment artifacts are immutable and scoped to the audit, not
    // to the job policy. A fresh cache key creates a new audit for this policy;
    // never reuse an older audit's profile or facts for a different policy.
    const prior=await db.prepare('SELECT 1 FROM prepared_assessment_jobs WHERE audit_id=?1 AND policy_version<>?2 LIMIT 1').bind(auditId,PREPARED_ASSESSMENT_POLICY).first();
    if(prior)return{status:'skipped',code:'prior_assessment_policy'};
    grant=await jobs.claim({auditId,preparedHash:ready.prepared_hash,policyVersion:PREPARED_ASSESSMENT_POLICY,leaseMs:45000});
    if(!grant)return{status:'skipped',code:'assessment_not_claimed'};
    if(audit.status==='incomplete') {
      const reset=await db.prepare(`UPDATE audits SET status='pending',report_json=NULL,error_json=NULL,completed_at=NULL,cache_until=NULL WHERE id=?1 AND status='incomplete' AND expires_at>?2
        AND EXISTS(SELECT 1 FROM prepared_assessment_jobs j WHERE j.audit_id=?1 AND j.prepared_hash=?3 AND j.policy_version=?4 AND j.owner=?5 AND j.state='running' AND j.lease_until>?2)`)
        .bind(auditId,now(),grant.preparedHash,grant.policyVersion,grant.owner).run();
      if(reset.meta.changes!==1)throw Object.assign(Error('Reassessment lease lost'),{code:'job_lease_lost'});
    }
    await pipeline.load();
    input=await snapshots.readPrepared(auditId);
    if(input.source?.preparedHash!==grant.preparedHash)throw Object.assign(Error('Prepared input changed'),{code:'prepared_hash_changed'});
    await jobs.assertLease(grant);
    if(grant.terminalOnly){await publish('job_retry_exhausted');await jobs.release(grant,{state:'failed',code:'job_retry_exhausted'});return{status:'failed',code:'job_retry_exhausted'};}
    await record('category','running','classification_started');
    const result=await engine({grant,jobs,preparedInput:input,AI:modelProvider??createTerraByokProvider(env,{fetch:fetchImpl}),allowance,now,calibrationApproved:activated(env),onProfile:async profile=>{await persist('profile',profile);await record('category','completed','profile_retained');await record('content','running','facts_preparing');}});
    if(result.status==='yield') {await jobs.release(grant,{state:'waiting',code:'checkpoint_yield',retryAt:now()});return{status:'yield',code:'checkpoint_yield'};}
    if(result.status!=='completed') {
      const code=safeCode(result);await publish(code);
      await jobs.release(grant,{state:result.uncertain===true||['model_usage_uncertain','model_timeout','model_provider_failure','model_output_invalid','output_limit'].includes(code)?'uncertain':'failed',code});return{status:'failed',code};
    }
    if(result.profile)await persist('profile',result.profile);
    await persist('facts',result.replayArtifact);
    const derived=await derive(input).catch(()=>null);
    report=scorePage(input.snapshot,input.extracted,{initialExtracted:input.snapshot.browser.initialExtracted,deterministicExtracted:derived,requireAiAssessment:true,aiAssessment:result.assessment});
    await record('snapshot','completed','assessment_retained');await record('content','completed','judgments_validated');
    await publish('assessment_completed',true);
    await jobs.release(grant,{state:'complete',code:'assessment_completed'});
    return{status:'completed',code:'assessment_completed',reportStatus:report.status};
  }catch(error){
    const code=safeCode(error);
    if(grant&&code!=='job_lease_lost'){
      try{await publish(code);await jobs.release(grant,{state:'failed',code});}catch{/* Preserve ownership and uncertain work for bounded recovery. */}
    }
    return{status:'failed',code};
  }finally{await allowance.settle?.({id:reservation,now:now()}).catch(()=>{});}
}

// Existing hourly maintenance provides recovery without adding a new product.
export async function recoverPreparedAudits({env,now=Date.now,allowance:givenAllowance,jobs:givenJobs}={}) {
  if(!env?.AUDIT_DB)return{status:'skipped',auditIds:[]};
  const allowance=givenAllowance??createAnalyticsAllowanceGuard(env.AUDIT_DB,scope(env)),id='prepared-recovery-'+crypto.randomUUID();
  const admitted=await allowance.reserve({id,costs:{...COSTS,d1StorageBytes:4096},now:now()}).catch(()=>null);
  if(!admitted?.accepted||admitted.duplicate!==false)return{status:'waiting',auditIds:[]};
  try{const jobs=givenJobs??createPreparedAssessmentJobs(env.AUDIT_DB,{now});const ready=await jobs.discover({policyVersion:PREPARED_ASSESSMENT_POLICY,limit:3,now:now()});await jobs.cleanup();return{status:'ready',auditIds:ready.map(x=>x.auditId)};}
  finally{await allowance.settle?.({id,now:now()}).catch(()=>{});}
}
