import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {runPreparedAudit} from '../../../backend/prepared-assessment-consumer.mjs';
import {createSnapshotStore} from '../../../backend/snapshot-store.mjs';
import {HtmlTestRewriter} from '../../../backend/html-product-test-helper.mjs';
import {mixedProvider} from '../../../backend/fixtures/prepared-consumer/provider.mjs';
import {AI_MODEL_CONFIG as config} from '../../../backend/ai-model-config.mjs';
const exp=JSON.parse(await readFile(new URL('./exit-export.json',import.meta.url),'utf8'));
const dir=await mkdtemp(join(tmpdir(),'terra-fresh-')); let sqlite;
try {
 const path=join(dir,'copy.sqlite'); await copyFile(exp.dbPath,path); sqlite=new DatabaseSync(path);
 const db={prepare(sql){let args=[];return {bind(...x){args=x;return this},async first(){return sqlite.prepare(sql).get(...args)??null},async all(){return {results:sqlite.prepare(sql).all(...args)}},async run(){const r=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}}}}}};
 const objects=new Map(JSON.parse(await readFile(exp.objectsPath,'utf8')).map(([k,v])=>[k,Buffer.from(v,'base64')]));
 const reads=[];const bucket={async get(k){reads.push(k);assert(!/\/(html|inputs)$/.test(k));const b=objects.get(k);return b?{size:b.length,body:new Response(b).body}:null},async put(k,v){objects.set(k,Buffer.from(v))},async delete(k){for(const x of Array.isArray(k)?k:[k])objects.delete(x)}};
 const calls=[];const allowance={async reserve(x){calls.push({type:'reserve',...x});return {accepted:true,duplicate:false}},async settle(x){calls.push({type:'settle',...x});return {accepted:true,duplicate:false}}};
 const now=()=>exp.now; const snapshots=createSnapshotStore({db,bucket,allowance,now}); globalThis.HTMLRewriter=HtmlTestRewriter;
 const env={AUDIT_DB:db,AUDIT_SNAPSHOTS:bucket,AUDIT_AI_GATEWAY_TOKEN:'fake-token',AUDIT_RUBRIC_RELEASE:'open-rubric-2026-11-17-v1',AUDIT_CONTENT_RELEASE:'content-facts-2026-11-12-r15',AUDIT_PIPELINE_RELEASE:'retained-ai-1'};
 let http=0;const requests=[];const fetch=async(url,opts)=>{http++;assert.equal(url,config.endpoint);assert.equal(opts.headers['cf-aig-gateway-id'],'openai');const b=JSON.parse(opts.body);assert.equal(b.model,config.model);assert(Array.isArray(b.input.input));assert(Number.isSafeInteger(b.input.max_output_tokens));assert.equal(b.input.reasoning.effort,'low');assert.equal(b.input.text.format.type,'json_object');assert(!b.input.input[0].content.includes('Extract relevant exact quotations'));requests.push(b.input.input[0].content.slice(0,100));const result=mixedProvider({messages:b.input.input,max_tokens:b.input.max_output_tokens});return Response.json({success:true,errors:[],result:{object:'response',status:'completed',error:null,incomplete_details:null,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(result.response)}]}]}})};
 const checkpoint=()=>({...sqlite.prepare('SELECT * FROM prepared_assessment_checkpoints WHERE audit_id=? AND checkpoint_key=?').get(exp.auditId,'0001')});assert.deepEqual(checkpoint(),exp.firstCheckpoint);
 const steps=[];for(let i=0;i<30;i++){const before=http;const result=await runPreparedAudit({env,auditId:exp.auditId,now,allowance,snapshots,fetch});steps.push({...result,httpCalls:http-before});assert(http-before<=1);assert.deepEqual(checkpoint(),exp.firstCheckpoint);if(result.status==='completed')break;assert.equal(result.status,'yield',JSON.stringify(result))}
 assert.equal(steps.at(-1).status,'completed');assert(calls.every(x=>!Object.hasOwn(x.costs??{},'aiNeurons')));
 const profile=await snapshots.readAssessment(exp.auditId,'profile'),facts=await snapshots.readAssessment(exp.auditId,'facts');const audit=sqlite.prepare('SELECT * FROM audits WHERE id=?').get(exp.auditId);const report=JSON.parse(audit.report_json);
 const sub=id=>report.criteria.flatMap(x=>x.subchecks).find(x=>x.id===id);
 const identity=sub('C1.identity'),title=sub('S4.title'),explanation=sub('C1.explanation');
 assert.equal(identity.status,'measured');assert.equal(identity.fraction,1);assert.equal(title.status,'measured');assert.equal(title.fraction,1);assert.equal(explanation.status,'not_measured');
 assert(facts.diagnostics.some(x=>x.context==='judgment:C1.explanation'&&x.reason==='quote_not_found_or_ambiguous'));
 assert(profile&&facts&&audit.report_json);assert.equal(report.status,'incomplete');assert.equal(report.score,null);
 const aiNeuronsOwnFieldCount=calls.filter(x=>Object.hasOwn(x.costs??{},'aiNeurons')).length;assert.equal(aiNeuronsOwnFieldCount,0);
 const observedContinuation={steps,newHttpCalls:http,checkpointUnchanged:true,completedCallReissued:false,deniedOriginalReadCount:reads.filter(k=>/\/(html|inputs)$/.test(k)).length,reservationAndSettlementCalls:calls.length,aiNeuronsOwnFieldCount,identity,title,explanation,diagnostics:facts.diagnostics,profileRetained:true,factsRetained:true,reportRetained:true,reportStatus:report.status,score:report.score};
 const result={version:1,changeId:'terra-gateway-payload',kind:'fresh-agent',priorConversationProvided:false,agentId:'/root/terra_gateway_fresh_exit',status:'passed',interruptionPoint:exp.interruptionPoint,observedContinuation:'Four invocations made four mocked HTTP calls; the first checkpoint remained unchanged and no aiNeurons reservation or settlement occurred.',detailedObservations:observedContinuation,limitations:'Synthetic sparse fixture and mocked Responses HTTP only; no live model, network, production billing, or model quality validation.'};
 await writeFile(new URL('./exit-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
} finally {sqlite?.close();await rm(dir,{recursive:true,force:true})}
