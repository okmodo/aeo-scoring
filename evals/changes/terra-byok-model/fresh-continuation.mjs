import { DatabaseSync } from 'node:sqlite';
import { readFileSync, copyFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { HtmlTestRewriter } from '../../../backend/html-product-test-helper.mjs';
import { createSnapshotStore } from '../../../backend/snapshot-store.mjs';
import { runPreparedAudit } from '../../../backend/prepared-assessment-consumer.mjs';
import { mixedProvider } from '../../../backend/fixtures/prepared-consumer/provider.mjs';
import config from '../../../config/ai-model.json' with {type:'json'};
const exp=JSON.parse(readFileSync(new URL('./exit-export.json',import.meta.url)));
const dir=mkdtempSync(join(tmpdir(),'fresh-terra-')); copyFileSync(exp.dbPath,join(dir,'audit.sqlite'));
const sql=new DatabaseSync(join(dir,'audit.sqlite'));
const db={prepare(q){return {bind(...args){const s=sql.prepare(q);return {async first(){return s.get(...args)??null},async all(){return {results:s.all(...args)}},async run(){const r=s.run(...args);return {meta:{changes:Number(r.changes)}}}}}}}};
const objects=new Map(JSON.parse(readFileSync(exp.objectsPath)).map(([k,v])=>[k,Buffer.from(v,'base64')]));
const reads=[]; const bucket={async get(k){reads.push(k);assert(!/\/(html|inputs)$/.test(k),'Forbidden original read');const b=objects.get(k);return b?{size:b.length,body:new Response(b).body}:null},async put(k,v){objects.set(k,Buffer.from(v))},async delete(k){for(const x of [].concat(k))objects.delete(x)}};
const reservations=[],settlements=[];const allowance={async reserve(x){reservations.push(x);return {accepted:true,duplicate:false}},async settle(x){settlements.push(x);return {accepted:true}}};
const snapshots=createSnapshotStore({db,bucket,allowance,now:()=>exp.now});
globalThis.HTMLRewriter=HtmlTestRewriter;
let calls=0; const requests=[];
const fetch=async(url,opts)=>{assert.equal(url,config.endpoint);const envelope=JSON.parse(opts.body);assert.equal(envelope.model,config.model);calls++;requests.push({model:envelope.model,maxCompletionTokens:envelope.input.max_completion_tokens});const result=mixedProvider({...envelope.input,max_tokens:envelope.input.max_completion_tokens});return Response.json({success:true,errors:[],result:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(result.response)}}]}})};
const checkpoint=()=>sql.prepare("SELECT * FROM prepared_assessment_checkpoints WHERE audit_id=? AND checkpoint_key='0001'").get(exp.auditId);
const result={version:1,changeId:'terra-byok-model',kind:'fresh-agent',priorConversationProvided:false,agentId:'terra_byok_fresh_exit',interruptionPoint:exp.interruptionPoint,status:'failed',observedContinuation:'',limitations:'Offline mock HTTP and synthetic sparse evidence; no live provider or billing validation.'};
try {
 const before=checkpoint();assert.deepEqual({...before},exp.firstCheckpoint);const invocations=[];
 for(let i=0;i<128;i++){const start=calls;const step=await runPreparedAudit({env:{AUDIT_DB:db,AUDIT_AI_GATEWAY_TOKEN:'fake-token',AUDIT_RUBRIC_RELEASE:'open-rubric-2026-11-17-v1',AUDIT_CONTENT_RELEASE:'content-facts-2026-11-12-r15',AUDIT_PIPELINE_RELEASE:'retained-ai-1'},auditId:exp.auditId,now:()=>exp.now,allowance,snapshots,fetch});invocations.push({step,httpCalls:calls-start});assert(calls-start<=1);assert.deepEqual({...checkpoint()},exp.firstCheckpoint);if(step.status==='completed')break;assert.equal(step.status,'yield',JSON.stringify(step));}
 assert.equal(invocations.at(-1).step.status,'completed');
 const profile=await snapshots.readAssessment(exp.auditId,'profile');const facts=await snapshots.readAssessment(exp.auditId,'facts');const audit=sql.prepare('SELECT status,report_json FROM audits WHERE id=?').get(exp.auditId);const report=JSON.parse(audit.report_json);
 const neuronReservations=reservations.filter(x=>Object.hasOwn(x.costs??{},'aiNeurons'));assert.equal(neuronReservations.length,0);assert.equal(audit.status,'incomplete');assert.equal(report.score,null);
 const checks=report.criteria.flatMap(x=>x.subchecks);const identity=checks.find(x=>x.id==='C1.identity'),title=checks.find(x=>x.id==='S4.title'),explanation=checks.find(x=>x.id==='C1.explanation');assert.equal(identity.status,'measured');assert.equal(identity.fraction,1);assert.equal(title.status,'measured');assert.equal(title.fraction,1);assert.equal(explanation.status,'not_measured');assert.equal(explanation.fraction,null);assert(facts.diagnostics.some(x=>x.context==='judgment:C1.explanation' && x.reason==='quote_not_found_or_ambiguous'));assert(profile && facts && report);const neuronSettlements=settlements.filter(x=>Object.hasOwn(x.costs??{},'aiNeurons'));assert.equal(neuronSettlements.length,0); 
 result.observations={invocations,totalNewHttpCalls:calls,requests,reads,reservationCount:reservations.length,settlementCount:settlements.length,neuronReservations:neuronReservations.length,firstCheckpointUnchanged:true,findings:{identity,title,explanation,diagnostics:facts.diagnostics},neuronSettlements:neuronSettlements.length,auditStatus:audit.status,reportScore:report.score,profile,facts,report};
 result.observedContinuation=`Completed after ${invocations.length} invocations and ${calls} new mock Terra HTTP calls; first checkpoint unchanged.`;
 result.status='passed';
}catch(e){result.error={message:e.message,stack:e.stack};result.observedContinuation='Continuation failed before all checks completed.';}finally{sql.close();rmSync(dir,{recursive:true,force:true});}
writeFileSync(new URL('./exit-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,observedContinuation:result.observedContinuation,error:result.error,observations:result.observations&&{invocations:result.observations.invocations,reads:result.observations.reads}},null,2));
