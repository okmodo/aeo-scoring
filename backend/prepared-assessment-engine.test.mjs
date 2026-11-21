import test from 'node:test';
import assert from 'node:assert/strict';
import {runPreparedAssessmentStep} from './prepared-assessment-engine.mjs';

function store() {
 const rows=new Map();
 return {rows,async checkpointRead(_g,k){return rows.get(k) || null;},async checkpointStart(_g,k,inputDigest){const row={status:'started',inputDigest,created:true};rows.set(k,row);return row;},async checkpointComplete(_g,k,output){Object.assign(rows.get(k),{status:'completed',output});},async checkpointFail(_g,k,code,{uncertain}){Object.assign(rows.get(k),{status:uncertain?'uncertain':'failed',code});}};
}
async function preparedFixture() {
 const html='<h1>Solar kettle</h1>', bytes=new TextEncoder().encode(html);
 const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
 return {snapshot:{url:'https://example.com',rawHtml:bytes,retrievalMethod:'browser_api_content',preprocessing:{version:'simplified-html-v1',representation:'cleaned_rendered_html',originalCapturePreserved:true,sourceSha256:'a'.repeat(64),sourceObjectKey:'retained/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000/html',sourceBytes:100,outputBytes:bytes.length,outputSha256:sha},browser:{renderedHtml:html,initialExtracted:{},coverage:{initialAvailable:false,renderedLimited:false,complete:false}}},extracted:{productHtml:{blocks:[]}}};
}
const grant={auditId:'a'}, accepted={reserve(){return {accepted:true,duplicate:false};}};
test('completed step replays without another reservation; one new call per invocation',async()=>{
 const input=await preparedFixture();const jobs=store();let calls=0,reserves=0;const allowance={reserve(){reserves++;return {accepted:true,duplicate:false};}};
 const AI={run(){calls++;return {response:{evidence:[],primaryEvidence:[]}};}};
 const args={grant,jobs,preparedInput:input,AI,allowance,calibrationApproved:true};
 assert.equal((await runPreparedAssessmentStep(args)).status,'yield');
 assert.equal(calls,1); assert.equal(reserves,0);
 // The second invocation replays the first, then executes the next call.
 await runPreparedAssessmentStep(args); assert.equal(calls,2);assert.equal(reserves,0);
});
test('unknown provider usage is never retried',async()=>{
 const input=await preparedFixture();const jobs=store();let calls=0;const args={grant,jobs,preparedInput:input,AI:{run(){calls++;throw Error('network');}},allowance:accepted,calibrationApproved:true};
 assert.equal((await runPreparedAssessmentStep(args)).code,'model_provider_failure');
 assert.equal((await runPreparedAssessmentStep(args)).code,'model_provider_failure');assert.equal(calls,1);

});
test('legacy input-only checkpoint cannot replay under the configured model',async()=>{
 const input=await preparedFixture(),jobs=store();let calls=0;
 jobs.rows.set('0001',{status:'completed',inputDigest:'legacy-input-only-digest',output:{evidence:[]}});
 const result=await runPreparedAssessmentStep({grant,jobs,preparedInput:input,AI:{run(){calls++;}},allowance:accepted,calibrationApproved:true});
 assert.equal(result.code,'checkpoint_input_mismatch');assert.equal(calls,0);
});
test('prepared batches resume through a sparse validated assessment using only cleaned bytes',async()=>{
 const html='<h1>Solar kettle</h1><p>Six cups</p>', bytes=new TextEncoder().encode(html);
 const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
 const snapshot={url:'https://example.com',rawHtml:bytes,retrievalMethod:'browser_api_content',preprocessing:{version:'simplified-html-v1',representation:'cleaned_rendered_html',originalCapturePreserved:true,sourceSha256:'a'.repeat(64),sourceObjectKey:'retained/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000/html',sourceBytes:100,outputBytes:bytes.length,outputSha256:sha},browser:{renderedHtml:html,initialExtracted:{},coverage:{initialAvailable:false,renderedLimited:false,complete:false}}};
 const extracted={productHtml:{complete:false,blocks:[{text:'ORIGINAL_SECRET'}]}};
 const groups=['C2.essential','C2.supporting','C4.intended-use','C4.compatibility','C4.limitations','C4.selection'];
 const slots=groups.map((group,i)=>({id:`slot-${i}`,group,label:`Need ${i}`,relevance:'Relevant for selection',full:'A complete value',partial:'A partial value',zero:'No useful value',missingExpectation:'State the value'}));
 const direct=['S1.delivery','S1.readability','S1.supporting-access','S1.scope','S1.configuration','S2.entity','S2.offer','S2.identifiers','S2.variants','S3.identity','S3.price','S3.availability','S3.optional-claims','S4.title','S4.organization','S4.image-alternatives','S7.identity','S7.links','S8.context','S8.guidance','C1.identity','C1.explanation','C1.configuration','C3.price','C3.availability','C3.shipping','C3.returns','C5.consistency','C5.claim-support'];
 let calls=0;const AI={run(_model,request){calls++;const system=request.messages[0].content,p=JSON.parse(request.messages[1].content);assert.ok(!JSON.stringify(p).includes('ORIGINAL_SECRET'));let response;
 if(system.includes('Extract relevant exact quotations')) {assert.equal(p.sources.map(s=>s.text).join(''),html);response={evidence:[{sourceId:p.sources[0].id,quote:'Solar kettle'}],primaryEvidence:[{sourceId:p.sources[0].id,quote:'Solar kettle'}]};}
 else if(system.includes('Identify only the primary')) response={status:'classified',category:'Solar kettle',evidence:[{sourceId:'s1',quote:'Solar kettle'}]};
 else if(system.includes('Independently of any individual')) response={slots};
 else if(system.includes('Inspect this entire source')) response={sections:p.sources.map(s=>({sourceId:s.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],checks:[...direct,...slots.map(x=>x.id)].map(id=>({id,status:'unknown',evidence:[]}))}))};
 else response={judgments:[...direct,...slots.map(x=>x.id)].map(id=>({id,status:'not_measured',fraction:null,reason:'Insufficient evidence',evidence:[]})),c5:{claims:[],comparisons:[]}};
 return {response};}};
 const args={grant,jobs:store(),preparedInput:{snapshot,extracted},AI,allowance:accepted,calibrationApproved:true};let result;
 for(let n=0;n<20;n++){const before=calls;result=await runPreparedAssessmentStep(args);assert.ok(calls-before<=1);if(result.status!=='yield')break;}
 assert.equal(result.status,'completed');assert.equal(result.assessment.findings['C1.identity'].status,'not_measured');assert.ok(result.replayArtifact);
});

test('unverified prepared input fails before model execution',async()=>{
 const preparedInput=await preparedFixture();
 preparedInput.snapshot.preprocessing=undefined;
 const result=await runPreparedAssessmentStep({grant,jobs:store(),preparedInput,AI:{run(){assert.fail('Unexpected inference');}}});
 assert.equal(result.code,'invalid_prepared_input');
});

test('timeout and invalid model JSON are distinct and are not retried',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const preparedInput=await preparedFixture();let started;const modelStarted=new Promise(resolve=>{started=resolve;});
 const jobs=store(),args={grant,jobs,preparedInput,AI:{run(){started();return new Promise(()=>{});}},allowance:accepted,deadlineAt:0,calibrationApproved:true};
 const pending=runPreparedAssessmentStep(args);await modelStarted;t.mock.timers.tick(29999);
 let done=false;pending.then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);
 t.mock.timers.tick(1);assert.equal((await pending).code,'model_timeout');
 assert.equal((await runPreparedAssessmentStep(args)).code,'model_timeout');assert.equal(jobs.rows.get('0001').status,'uncertain');
 const invalidJobs=store(),invalid={...args,jobs:invalidJobs,AI:{run(){return {response:'{broken'};}}};
 assert.equal((await runPreparedAssessmentStep(invalid)).code,'model_output_invalid');
 assert.equal((await runPreparedAssessmentStep(invalid)).code,'model_output_invalid');assert.equal(invalidJobs.rows.get('0001').status,'uncertain');
});
