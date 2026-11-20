// Authored and executed by the fresh agent. Replaying this script alone is not a fresh-agent test.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,copyFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {runPreparedAudit} from '../../../backend/prepared-assessment-consumer.mjs';
import {createSnapshotStore} from '../../../backend/snapshot-store.mjs';
import {createPreparedAssessmentJobs} from '../../../backend/prepared-assessment-jobs.mjs';
import {syntheticProvider} from '../../../backend/fixtures/prepared-consumer/provider.mjs';
import {OPEN_RUBRIC_RELEASE_ID} from '../../../backend/ai-rubric-assessment.mjs';
import {CONTENT_FACTS_RELEASE_ID} from '../../../backend/content-facts-runner.mjs';
import {PIPELINE_VERSION} from '../../../backend/pipeline-state.mjs';
const ex=JSON.parse(readFileSync('evals/changes/prepared-ai-consumer/exit-export.json'));
copyFileSync(ex.dbPath,'/private/tmp/aeo-fresh-exit.sqlite');
const sql=new DatabaseSync('/private/tmp/aeo-fresh-exit.sqlite');
const db={prepare(q){return {bind(...p){const s=sql.prepare(q);return {async first(){return s.get(...p)??null},async all(){return {results:s.all(...p)}},async run(){return {meta:{changes:Number(s.run(...p).changes)}}}}}}}};
const objects=new Map(JSON.parse(readFileSync(ex.objectsPath)).map(([k,v])=>[k,Buffer.from(v,'base64')]));
const reads=[];const bucket={async get(k){reads.push(k);assert(!/\/(html|inputs)$/.test(k),'forbidden read '+k);const b=objects.get(k);return b?{size:b.length,body:new Blob([b]).stream()}:null},async put(k,v){objects.set(k,Buffer.from(v))},async delete(keys){for(const k of [].concat(keys))objects.delete(k)}};
let calls=0, aiReservations=0;const allowance={async reserve({costs}){if(costs.aiNeurons)aiReservations++;return {accepted:true,duplicate:false}},async settle(){return {accepted:true}}};
const now=()=>ex.now;const snapshots=createSnapshotStore({db,bucket,allowance,now});const jobs=createPreparedAssessmentJobs(db,{now});
let starts=[];const orig=jobs.checkpointStart;jobs.checkpointStart=async(g,k,d)=>{starts.push(k);return orig(g,k,d)};
const env={AUDIT_DB:db,AUDIT_AI:{run:async(_m,input)=>{calls++;return syntheticProvider(input)}},AUDIT_RUBRIC_RELEASE:OPEN_RUBRIC_RELEASE_ID,AUDIT_CONTENT_RELEASE:CONTENT_FACTS_RELEASE_ID,AUDIT_PIPELINE_RELEASE:PIPELINE_VERSION};
const before=sql.prepare('SELECT * FROM prepared_assessment_checkpoints ORDER BY checkpoint_key').all();assert.equal(before.length,1);assert.equal(before[0].status,'completed');
const invocations=[];let result;for(let i=0;i<8;i++){const c=calls,a=aiReservations;result=await runPreparedAudit({env,auditId:ex.auditId,now,allowance,snapshots,jobs});invocations.push({result,newModelCalls:calls-c,newAiReservations:aiReservations-a});assert(calls-c<=1);if(result.status!=='yield')break}
const after=sql.prepare('SELECT * FROM prepared_assessment_checkpoints ORDER BY checkpoint_key').all();const audit=sql.prepare('SELECT * FROM audits WHERE id=?').get(ex.auditId);const row=sql.prepare('SELECT * FROM retained_snapshots WHERE audit_id=?').get(ex.auditId);const report=JSON.parse(audit.report_json);const profile=await snapshots.readAssessment(ex.auditId,'profile');const facts=await snapshots.readAssessment(ex.auditId,'facts');
assert.equal(result.status,'completed');assert.deepEqual(after[0],before[0]);assert(!starts.includes(before[0].checkpoint_key));assert.equal(aiReservations,calls);assert.equal(row.profile_state,'ready');assert.equal(row.facts_state,'ready');assert.equal(report.status,'incomplete');assert.equal(report.score,null);
const find=(v)=>{if(!v||typeof v!=='object')return [];return [...(v.id==='C1.identity'?[v]:[]),...Object.values(v).flatMap(find)]};const hits=find(report);assert(hits.some(x=>x.status==='measured'||x.fraction===1||x.score>0),JSON.stringify(hits));
const out={version:1,changeId:'prepared-ai-consumer',kind:'fresh-agent',priorConversationProvided:false,agentId:'/root/prepared_fresh_exit',status:'passed',interruptionPoint:ex.interruptionPoint,observedContinuation:{initialCheckpoint:{key:before[0].checkpoint_key,status:before[0].status,unchanged:true,restarted:false},invocations,newModelCalls:calls,newAiReservations:aiReservations,checkpointCount:after.length,reads,profileRetained:!!profile,factsRetained:!!facts,reportRetained:!!audit.report_json,reportStatus:report.status,score:report.score,c1Identity:hits},limitations:['Offline synthetic provider and injected allowance; no live model or billing validation.','SQLite and R2-compatible objects were restored to isolated copies.']};writeFileSync('evals/changes/prepared-ai-consumer/exit-result.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
