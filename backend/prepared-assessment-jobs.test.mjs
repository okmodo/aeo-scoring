import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createPreparedAssessmentJobs} from './prepared-assessment-jobs.mjs';
const auditId='d9428888-122b-4c77-8d11-666666666666',preparedHash='a'.repeat(64),policyVersion='v1';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 const db={prepare(sql){return {bind(...args){const s=sqlite.prepare(sql);return {first:async()=>s.get(...args)??null,all:async()=>({results:s.all(...args)}),run:async()=>({meta:{changes:Number(s.run(...args).changes)}})};}};}};
 sqlite.prepare("INSERT INTO audits(id,url,cache_key,status,created_at,expires_at) VALUES(?,?,?,'pending',0,86400000)").run(auditId,'https://example.com','key');
 sqlite.prepare("INSERT INTO retained_snapshots(audit_id,object_prefix,created_at,expires_at,state,prepared_state,prepared_hash) VALUES(?,?,0,86400000,'ready','ready',?)").run(auditId,'retained/x',preparedHash);
 let t=1;return {sqlite,jobs:createPreparedAssessmentJobs(db,{now:()=>t}),advance:n=>t+=n};
}
test('claims serialize and checkpoints hold uncertain calls after owner expiry',async()=>{
 const f=fixture(),request={auditId,preparedHash,policyVersion,leaseMs:10};
 const [a,b]=await Promise.all([f.jobs.claim(request),f.jobs.claim(request)]);assert.ok(a);assert.equal(b,null);
 assert.equal((await f.jobs.checkpointStart(a,'model','b'.repeat(64))).status,'started');
 f.advance(11);const c=await f.jobs.claim(request);assert.ok(c);assert.equal((await f.jobs.checkpointRead(c,'model')).status,'uncertain');
 await assert.rejects(f.jobs.checkpointComplete(a,'model',{}),{code:'job_lease_lost'});
 assert.equal((await f.jobs.checkpointStart(c,'model','b'.repeat(64))).status,'uncertain');
 await assert.rejects(f.jobs.checkpointStart(c,'model','c'.repeat(64)),{code:'checkpoint_mismatch'});
});
test('completed checkpoints resume, changed hashes and unready artifacts are denied',async()=>{
 const f=fixture(),request={auditId,preparedHash,policyVersion,leaseMs:10};const a=await f.jobs.claim(request);
 await f.jobs.checkpointStart(a,'profile','c'.repeat(64));await f.jobs.checkpointComplete(a,'profile',{ok:true});await f.jobs.release(a,{state:'waiting'});
 const b=await f.jobs.claim(request);assert.deepEqual((await f.jobs.checkpointRead(b,'profile')).output,{ok:true});
 f.sqlite.prepare("UPDATE retained_snapshots SET prepared_hash=? WHERE audit_id=?").run('d'.repeat(64),auditId);
 await assert.rejects(f.jobs.assertLease(b),{code:'job_lease_lost'});assert.equal(await f.jobs.claim(request),null);
 f.sqlite.prepare("UPDATE retained_snapshots SET prepared_state='pending' WHERE audit_id=?").run(auditId);
 assert.equal(await f.jobs.claim({...request,preparedHash:'d'.repeat(64)}),null);
});
test('safe yields do not exhaust crash retries and discovery preserves prior-policy audits',async()=>{
 const f=fixture(),request={auditId,preparedHash,policyVersion,leaseMs:10};
 for(let i=0;i<8;i++){const g=await f.jobs.claim(request);assert.ok(g);await f.jobs.release(g,{state:'waiting',code:'checkpoint_yield'});}
 const g=await f.jobs.claim(request);await f.jobs.release(g,{state:'complete'});
 assert.deepEqual(await f.jobs.discover({policyVersion}),[]);
 assert.deepEqual(await f.jobs.discover({policyVersion:'v2'}),[]);
});
test('known pre-call admission failures retain a failed diagnostic without replay',async()=>{
 const f=fixture(),g=await f.jobs.claim({auditId,preparedHash,policyVersion,leaseMs:10});
 await f.jobs.checkpointStart(g,'model','b'.repeat(64));
 const result=await f.jobs.checkpointFail(g,'model','admission_failed',{uncertain:false});
 assert.equal(result.status,'failed');assert.equal(result.code,'admission_failed');
 assert.equal((await f.jobs.checkpointStart(g,'model','b'.repeat(64))).created,false);
});
test('exhausted expired leases remain discoverable for finalization only',async()=>{
 const f=fixture(),request={auditId,preparedHash,policyVersion,leaseMs:10};
 for(let i=0;i<5;i++){const g=await f.jobs.claim(request);assert.equal(g.terminalOnly,false);f.advance(11);}
 assert.equal((await f.jobs.discover({policyVersion})).length,1);
 const terminal=await f.jobs.claim(request);assert.equal(terminal.terminalOnly,true);
 await assert.rejects(f.jobs.checkpointStart(terminal,'new','b'.repeat(64)),{code:'checkpoint_mismatch'});
 await f.jobs.release(terminal,{state:'failed',code:'job_retry_exhausted'});
 assert.deepEqual(await f.jobs.discover({policyVersion}),[]);
});
test('cleanup uses expiry indexes and bounded batches, including orphan checkpoints',async()=>{
 const f=fixture(),g=await f.jobs.claim({auditId,preparedHash,policyVersion});
 for(let i=0;i<101;i++) await f.jobs.checkpointStart(g,`key${i}`,'b'.repeat(64));
 const checkpointPlan=f.sqlite.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM prepared_assessment_checkpoints WHERE expires_at<=? ORDER BY expires_at LIMIT 100').all(86400000);
 const jobPlan=f.sqlite.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM prepared_assessment_jobs WHERE expires_at<=? ORDER BY expires_at LIMIT 25').all(86400000);
 assert.ok(checkpointPlan.some(r=>r.detail.includes('prepared_assessment_checkpoints_expiry')));assert.ok(jobPlan.some(r=>r.detail.includes('prepared_assessment_jobs_expiry')));
 f.advance(86400000);await f.jobs.cleanup();assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM prepared_assessment_checkpoints').get().n,1);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM prepared_assessment_jobs').get().n,0);
 await f.jobs.cleanup();assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM prepared_assessment_checkpoints').get().n,0);
});
