import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {HtmlTestRewriter} from '../../../backend/html-product-test-helper.mjs';
import {createSnapshotStore} from '../../../backend/snapshot-store.mjs';
import {runPreparedAudit} from '../../../backend/prepared-assessment-consumer.mjs';
import {runPreparedAssessmentStep} from '../../../backend/prepared-assessment-engine.mjs';
import {OPEN_RUBRIC_RELEASE_ID} from '../../../backend/ai-rubric-assessment.mjs';
import {CONTENT_FACTS_RELEASE_ID} from '../../../backend/content-facts-runner.mjs';
import {PIPELINE_VERSION} from '../../../backend/pipeline-state.mjs';
import {mixedProvider} from '../../../backend/fixtures/prepared-consumer/provider.mjs';
globalThis.HTMLRewriter=HtmlTestRewriter;
const e=JSON.parse(readFileSync(new URL('./exit-export.json',import.meta.url))),dir=mkdtempSync(join(tmpdir(),'aeo-fresh-'));
try {
 copyFileSync(e.dbPath,join(dir,'retained.sqlite')); const sql=new DatabaseSync(join(dir,'retained.sqlite'));
 const db={prepare(q){return{bind(...a){const s=sql.prepare(q);return{first:async()=>s.get(...a)??null,all:async()=>({results:s.all(...a)}),run:async()=>({meta:{changes:Number(s.run(...a).changes)}})}}}}};
 const objects=new Map(JSON.parse(readFileSync(e.objectsPath)).map(([k,v])=>[k,Buffer.from(v,'base64')])), reads=[],reservations=[],calls=[],engineKeys=[];
 const allowance={reserve:async r=>{reservations.push(r);return{accepted:true,duplicate:false}},settle:async()=>({accepted:true})};
 const snapshots=createSnapshotStore({db,now:()=>e.now,allowance,bucket:{put:async(k,v)=>objects.set(k,v.slice()),get:async k=>{reads.push(k);if(k.endsWith('/html')||k.endsWith('/inputs'))throw Error('Forbidden read');const v=objects.get(k);return v&&{size:v.length,body:new Response(v).body}},delete:async()=>{}}});
 const env={AUDIT_DB:db,AUDIT_AI:{run:async(_m,input)=>{calls.push(input.messages[0].content);return mixedProvider(input)}},AUDIT_RUBRIC_RELEASE:OPEN_RUBRIC_RELEASE_ID,AUDIT_CONTENT_RELEASE:CONTENT_FACTS_RELEASE_ID,AUDIT_PIPELINE_RELEASE:PIPELINE_VERSION};
 const ready=sql.prepare('SELECT state,prepared_state FROM retained_snapshots WHERE audit_id=?').get(e.auditId);assert.equal(ready.state,'ready');assert.equal(ready.prepared_state,'ready');
 const original=sql.prepare('SELECT * FROM prepared_assessment_checkpoints ORDER BY checkpoint_key').all(); assert.equal(original.length,1);assert.equal(original[0].status,'completed');
 const steps=[];for(let i=0;i<30;i++){const before=calls.length,aiBefore=reservations.filter(x=>x.costs.aiNeurons!==undefined).length;const result=await runPreparedAudit({env,auditId:e.auditId,now:()=>e.now,allowance,snapshots,engine:async args=>{engineKeys.push(Object.keys(args));return runPreparedAssessmentStep(args)}});const newCalls=calls.length-before,newReservations=reservations.filter(x=>x.costs.aiNeurons!==undefined).length-aiBefore;steps.push({result,newCalls,newReservations});assert.ok(newCalls<=1);assert.equal(newCalls,newReservations);assert.deepEqual(sql.prepare('SELECT * FROM prepared_assessment_checkpoints WHERE checkpoint_key=?').get(original[0].checkpoint_key),original[0]);if(result.status==='completed')break;assert.equal(result.status,'yield');}
 assert.equal(steps.at(-1).result.status,'completed');assert.ok(engineKeys.every(keys=>!keys.some(k=>/deadline|timeout|budget/i.test(k))));assert.ok(!reads.some(k=>/\/(html|inputs)$/.test(k)));
 const report=JSON.parse(sql.prepare('SELECT report_json FROM audits WHERE id=?').get(e.auditId).report_json),facts=await snapshots.readAssessment(e.auditId,'facts'),profile=await snapshots.readAssessment(e.auditId,'profile');
 const checks=report.criteria.flatMap(c=>c.subchecks);const identity=checks.find(x=>x.id==='C1.identity'),title=checks.find(x=>x.id==='S4.title'),explanation=checks.find(x=>x.id==='C1.explanation');
 assert.equal(identity.status,'measured');assert.equal(identity.points,3);assert.equal(title.status,'measured');assert.ok(title.points>0);assert.equal(explanation.status,'not_measured');assert.equal(explanation.points,null);assert.ok(facts.diagnostics.some(x=>x.context==='judgment:C1.explanation'&&x.reason==='quote_not_found_or_ambiguous'));assert.equal(report.status,'incomplete');assert.equal(report.score,null);assert.ok(profile&&facts&&report);
 const observations={preparedState:ready,firstCheckpointKey:original[0].checkpoint_key,firstCheckpointUnchanged:true,completedCheckpoints:sql.prepare('SELECT checkpoint_key,status FROM prepared_assessment_checkpoints ORDER BY checkpoint_key').all(),steps,modelCalls:calls.length,aiReservations:reservations.filter(x=>x.costs.aiNeurons!==undefined).length,readObjectTypes:[...new Set(reads.map(k=>k.split('/').at(-1)))],forbiddenReads:0,engineArgumentKeys:engineKeys[0],identity,title,explanation,diagnostics:facts.diagnostics,reportStatus:report.status,score:report.score,retained:{profile:!!profile,facts:!!facts,report:!!report}};
 const result={version:1,changeId:'prepared-independent-scoring',kind:'fresh-agent',priorConversationProvided:false,agentId:'/root/prepared_independent_exit',interruptionPoint:e.interruptionPoint,status:'passed',observedContinuation:'Four invocations resumed the persisted first checkpoint and completed, with one new model call and AI reservation per invocation.',limitations:'Offline synthetic provider and retained fixture only; no live provider, network, production mutation, or model quality claim.',detailedObservations:observations};
 writeFileSync(new URL('./exit-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));sql.close();
} finally {rmSync(dir,{recursive:true,force:true})}
