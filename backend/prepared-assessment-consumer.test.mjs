import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {runPreparedAudit,recoverPreparedAudits,PREPARED_ASSESSMENT_POLICY} from './prepared-assessment-consumer.mjs';
import {createPreparedAssessmentJobs} from './prepared-assessment-jobs.mjs';
import {createStore} from './store.mjs';
import {OPEN_RUBRIC_RELEASE_ID} from './ai-rubric-assessment.mjs';
import {CONTENT_FACTS_RELEASE_ID} from './content-facts-runner.mjs';
import {PIPELINE_VERSION} from './pipeline-state.mjs';
const auditId='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64),url='https://example.com/product',time=Date.UTC(2026,10,20);
function fixture(state='ready'){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 sql.prepare("INSERT INTO audits(id,url,cache_key,status,created_at,expires_at,lease_ms) VALUES(?,?,?,'pending',?,?,120000)").run(auditId,url,'key',time-180000,time+86400000);
 sql.prepare("INSERT INTO retained_snapshots(audit_id,object_prefix,created_at,expires_at,state,prepared_state,prepared_hash) VALUES(?,?,?,?,'ready',?,?)").run(auditId,'retained/'+auditId+'/'+auditId,time-180000,time+86400000,state,hash);
 const db={prepare(query){return{bind(...args){const s=sql.prepare(query);return{first:async()=>s.get(...args)??null,all:async()=>({results:s.all(...args)}),run:async()=>({meta:{changes:Number(s.run(...args).changes)}})}}}}};
 const events=[],artifacts=new Map();const allowance={reserve:async()=>{events.push('admit');return{accepted:true,duplicate:false}},settle:async()=>{events.push('settle');return{accepted:true}}};
 const snapshot={url,status:200,rawHtml:new TextEncoder().encode('<h1>Prepared item</h1>'),preprocessing:{version:'simplified-html-v1'},browser:{initialExtracted:{},renderedHtml:'<h1>Prepared item</h1>'}};
 const snapshots={readPrepared:async()=>{events.push('read_prepared');return{snapshot,extracted:{},source:{preparedHash:hash}}},saveAssessment:async({kind,artifact})=>{if(artifacts.has(kind))throw Object.assign(Error(),{code:'snapshot_exists'});artifacts.set(kind,artifact)},readAssessment:async(_id,kind)=>artifacts.get(kind)};
 const env={AUDIT_DB:db,AUDIT_AI:{run:()=>{throw Error('Unexpected direct model call')}},AUDIT_RUBRIC_RELEASE:OPEN_RUBRIC_RELEASE_ID,AUDIT_CONTENT_RELEASE:CONTENT_FACTS_RELEASE_ID,AUDIT_PIPELINE_RELEASE:PIPELINE_VERSION};
 const scorePage=()=>({status:'incomplete',score:null,coverage:{limitations:[]}});
 return{sql,db,env,events,artifacts,snapshots,allowance,scorePage,now:()=>time};
}
test('ready prepared data resumes one job and publishes after its original audit lease',async()=>{
 const f=fixture();let calls=0;const engine=async()=>++calls===1?{status:'yield'}:{status:'completed',profile:{category:'item'},replayArtifact:{version:'1'},assessment:{}};
 const args={...f,auditId,engine};
 assert.equal((await runPreparedAudit(args)).status,'yield');
 assert.equal((await createStore(f.db).get(auditId,time)).status,'pending');
 assert.equal((await runPreparedAudit(args)).status,'completed');
 assert.deepEqual(f.events,['admit','read_prepared','settle','admit','read_prepared','settle']);
 assert.equal(f.sql.prepare('SELECT status FROM audits').get().status,'incomplete');
 assert.equal(f.sql.prepare('SELECT state FROM prepared_assessment_jobs').get().state,'complete');
 assert.deepEqual([...f.artifacts.keys()],['profile','facts']);
 assert.equal((await runPreparedAudit(args)).status,'skipped');assert.equal(calls,2);
});
test('not-ready data and denied usage cannot reach R2 or inference',async()=>{
 for(const state of [null,'pending']){const f=fixture(state);const result=await runPreparedAudit({...f,auditId,engine:()=>{throw Error('No model allowed')}});assert.equal(result.code,'prepared_not_ready');assert.deepEqual(f.events,['admit','settle']);}
 const f=fixture();const result=await runPreparedAudit({...f,auditId,allowance:{reserve:async()=>({accepted:false})}});assert.equal(result.code,'usage_admission_denied');assert.deepEqual(f.events,[]);
});
test('uncertain model usage gives an incomplete report and prevents another inference',async()=>{
 const f=fixture();let calls=0;const args={...f,auditId,engine:async()=>{calls++;return{status:'unavailable',code:'model_usage_uncertain'}}};
 assert.equal((await runPreparedAudit(args)).code,'model_usage_uncertain');assert.equal(f.sql.prepare('SELECT state FROM prepared_assessment_jobs').get().state,'uncertain');
 const report=JSON.parse(f.sql.prepare('SELECT report_json FROM audits').get().report_json);assert.equal(report.score,null);assert.match(report.coverage.limitations[0],/model_usage_uncertain/);
 assert.equal((await runPreparedAudit(args)).status,'skipped');assert.equal(calls,1);
});
test('publication rejects a replaced owner and recovery selects ready jobs without parsing',async()=>{
 const f=fixture();const jobs=createPreparedAssessmentJobs(f.db,{now:f.now});const grant=await jobs.claim({auditId,preparedHash:hash,policyVersion:PREPARED_ASSESSMENT_POLICY});
 assert.equal(await createStore(f.db).finishPrepared(auditId,{grant:{...grant,owner:'replaced'},status:'incomplete',report:{},completedAt:time,cacheUntil:time+1000,assessedUrl:url}),false);
 await jobs.release(grant,{state:'waiting',code:'checkpoint_yield',retryAt:time});
 const ready=await recoverPreparedAudits({...f});assert.deepEqual(ready.auditIds,[auditId]);assert.equal(f.events.includes('read_prepared'),false);
});
test('previous policy jobs and their retained artifacts are left untouched',async()=>{
 const f=fixture();const jobs=createPreparedAssessmentJobs(f.db,{now:f.now});
 const old=await jobs.claim({auditId,preparedHash:hash,policyVersion:'prepared-assessment-v1'});
 await jobs.release(old,{state:'failed',code:'model_output_invalid'});
 f.artifacts.set('profile',{old:true});
 const result=await runPreparedAudit({...f,auditId,engine:()=>assert.fail('old audit must not be reassessed')});
 assert.equal(result.code,'prior_assessment_policy');assert.deepEqual(f.artifacts.get('profile'),{old:true});
 assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM prepared_assessment_jobs').get().count,1);
 assert.deepEqual((await recoverPreparedAudits({...f})).auditIds,[]);
 assert.equal(f.events.includes('read_prepared'),false);
});

test('an unvalidated category still retains the replay and partial assessment',async()=>{
 const f=fixture();const assessment={findings:{'C1.identity':{status:'measured',fraction:1}}};
 const result=await runPreparedAudit({...f,auditId,engine:async()=>({status:'completed',profile:null,replayArtifact:{profile:null,diagnostics:[{reason:'invalid_identity'}]},assessment}),scorePage:(_s,_e,options)=>({status:'incomplete',score:null,coverage:{limitations:[]},finding:options?.aiAssessment?.findings['C1.identity']})});
 assert.equal(result.status,'completed');assert.equal(f.artifacts.has('profile'),false);assert.equal(f.artifacts.get('facts').profile,null);
 assert.equal(JSON.parse(f.sql.prepare('SELECT report_json FROM audits').get().report_json).finding.fraction,1);
});
