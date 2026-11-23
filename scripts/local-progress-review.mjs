// Offline review service: real queue, persistence, pipeline and scoring with frozen capture/model responses.
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAuditService} from '../backend/service.mjs';
import {createStore} from '../backend/store.mjs';
import {createTestAllowanceGuard} from '../backend/allowance-store.test-helper.mjs';
import {INCLUDED_CEILINGS} from '../backend/allowance-policy.mjs';
import {createSnapshotStore} from '../backend/snapshot-store.mjs';
import {createBrowserContentWorkflow} from '../backend/browser-content-workflow.mjs';
import {createAuditQueueRuntime} from '../backend/audit-queue-runtime.mjs';
import {runPreparedAudit} from '../backend/prepared-assessment-consumer.mjs';
import {derivePreparedObservations} from '../backend/prepared-derived.mjs';
import {HtmlTestRewriter} from '../backend/html-product-test-helper.mjs';
import {OPEN_RUBRIC_RELEASE_ID} from '../backend/ai-rubric-assessment.mjs';
import {CONTENT_FACTS_RELEASE_ID} from '../backend/content-facts-runner.mjs';
import {PIPELINE_VERSION} from '../backend/pipeline-state.mjs';
import {preparedAssessmentPolicy} from '../backend/prepared-assessment-policy.mjs';
const fixtureHtml = `<!doctype html><html><head><title>Solar kettle</title></head><body><main><article class="product-detail"><h1>Solar kettle</h1><h2>Description</h2><p>This insulated solar kettle warms six cups of water during outdoor trips.</p><h2>Details</h2><ul><li>Brand: Example Outfitters</li><li>Material: Steel</li><li>Care: Hand wash only.</li></ul></article></main></body></html>`;

export function createLocalReview({delayMs=1200,deliveryDelayMs=delayMs,autoConsume=true,dbPath=':memory:'}={}) {
  const sql=new DatabaseSync(dbPath);
  sql.exec(readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8'));
  const operations=[];
  const db={prepare(query){return {bind(...params){const statement=sql.prepare(query);const args=params.length&&/\?\d+/.test(query)?[Object.fromEntries(params.map((value,index)=>[String(index+1),value]).filter(([index])=>new RegExp('\\?'+index+'(?![0-9])').test(query)))]:params;return {query,
    first:async()=>{operations.push(query);return statement.get(...args)??null;},all:async()=>{operations.push(query);return {results:statement.all(...args)};},
    run:async()=>{operations.push(query);const changes=Number(statement.run(...args).changes);if(query.includes('INSERT INTO audit_pipeline_state')&&typeof params[2]==='string'){const stages=JSON.parse(params[2]);if(stages.at(-1)?.code==='report_building')await wait();}return {meta:{changes}};}};}};},
    async batch(statements){const results=[];for(const statement of statements) results.push(/^\s*SELECT/i.test(statement.query)?await statement.all():await statement.run());return results;}};
  const now=Date.now, start=now(), messages=[], objects=new Map(), encoder=new TextEncoder();
  const wait=()=>new Promise(resolve=>setTimeout(resolve,delayMs));
  const evidence={verified:true,accountId:'fixture',observedAt:start,cycleStart:start-1000,cycleEnd:start+86400000,
    aiDay:new Date(start).toISOString().slice(0,10),usage:Object.fromEntries(Object.keys(INCLUDED_CEILINGS).map(k=>[k,0]))};
  const allowance=createTestAllowanceGuard(db,{accountId:'fixture',evidence});
  const guard={reserve:async()=>({accepted:true,duplicate:false}),start:async()=>({accepted:true,duplicate:false}),settle:async()=>({accepted:true}),cancelUnstarted:async()=>{}};
  const snapshots=createSnapshotStore({db,now,allowance:guard,bucket:{put:async(key,value)=>objects.set(key,value.slice()),
    get:async key=>{const value=objects.get(key);return value&&{size:value.length,body:new Response(value).body};},delete:async key=>objects.delete(key)}});
  const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const workflow=createBrowserContentWorkflow({db,snapshots,guard,now,binding:{quickAction:async (_action,input)=>{await wait();return Response.json({success:true,result:fixtureHtml,meta:{finalUrl:input.url,status:200}},{headers:{'X-Browser-Ms-Used':'100'}});}},
    preprocess:async({rawHtml,sourceObjectKey,expiresAt})=>{await wait();const html=encoder.encode(fixtureHtml);return {html,preprocessing:{version:'simplified-html-v1',representation:'cleaned_rendered_html',originalCapturePreserved:true,sourceObjectKey,sourceSha256:await hash(rawHtml),sourceBytes:rawHtml.length,expiresAt,preparedAt:now(),outputBytes:html.length,outputSha256:await hash(html)}};}});
  const fixtureFetch=async(_endpoint,options)=>{if(options.method==='GET') return Response.json({success:true,result:{id:'default',workers_ai_billing_mode:'postpaid'}});
    await wait();const body=JSON.parse(options.body);
    const meta=JSON.parse(body.messages[0].content.split('\n\n').at(-1));
    const results=Object.fromEntries(meta.questions.map(question=>[question.id,{answer:'pass',reason:'The frozen product fixture supports the finding.',evidenceIds:question.passKinds.flatMap(kind=>{const hit=meta.evidence.find(item=>item.kind===kind&&question.eligibleEvidenceIds.includes(item.id));return hit?[hit.id]:[];})}]));
    const output={response:{results,category:{label:'Local fixture product',evidenceId:meta.categoryEvidenceIds[0]}}};return Response.json({success:true,result:{response:JSON.stringify(output.response),usage:{prompt_tokens:100,completion_tokens:100,neurons:5}}});};
  const env={AUDIT_DB:db,AUDIT_USAGE_READ_TOKEN:'fixture',AUDIT_SNAPSHOTS:{},AUDIT_BROWSER:{},AUDIT_QUEUE_MODE:'enabled',AUDIT_QUEUE:{send:async body=>messages.push(structuredClone(body))},AUDIT_AI_PROVIDER:'granite',AUDIT_GRANITE_KEYED:'enabled',AUDIT_AI_GATEWAY_TOKEN:'fixture',AUDIT_RUBRIC_RELEASE:OPEN_RUBRIC_RELEASE_ID,AUDIT_CONTENT_RELEASE:CONTENT_FACTS_RELEASE_ID,AUDIT_PIPELINE_RELEASE:PIPELINE_VERSION};
  const runtime=createAuditQueueRuntime(env,{now,allowance,queueAllowance:{reserve:async()=>({accepted:true,duplicate:false})},workflow,snapshots,
    derive:(input,options)=>derivePreparedObservations(input,{...options,HTMLRewriter:HtmlTestRewriter}),assess:options=>runPreparedAudit({...options,fetch:fixtureFetch})});
  const policyVersion=preparedAssessmentPolicy('granite',true);
  const handle=createAuditService({store:createStore(db,{policyVersion,queueEnabled:true}),policyVersion,allowance,egress:{fetch(){throw Error('network disabled');}},secret:'x'.repeat(32),normalizeUrl:x=>{const u=new URL(x);if(!['http:','https:'].includes(u.protocol)) throw Error('invalid');return u.href;},now,browserFlow:workflow,requireBrowser:true,snapshotStore:snapshots,pipelineDb:db,enqueueAudit:id=>runtime.start(id)});
  let processing=false,closed=false;
  async function deliver(body,{deadLetter=false}={}) {let acked=false,retried=false;await runtime.consume({queue:deadLetter?'aeo-audit-checkpoints-dead':'aeo-audit-checkpoints',messages:[{body,ack(){acked=true;},retry(){retried=true;}}]});return {acked,retried};}
  async function pump(){if(processing||closed)return;processing=true;try {while(messages.length&&!closed){await new Promise(resolve=>setTimeout(resolve,deliveryDelayMs));const body=messages.shift();const result=await deliver(body);if(result.retried) throw Error('fixture queue retry');}} catch { /* A failed fixture job remains observable through its persisted state. */ } finally {processing=false;}}
  async function request(request) {
    const path=new URL(request.url).pathname;
    if(request.headers.get('authorization')!=='Bearer review123') return Response.json({version:'1',error:{code:'preview_password_required',message:'Enter the shared testing password.',retryAfterSeconds:null}},{status:401});
    if(path==='/api/v1/preview-access') return new Response(null,{status:request.method==='POST'?204:405});
    const response=await handle(request,{address:'192.0.2.1',defer:()=>{throw Error('unexpected deferred work');}});
    if(autoConsume&&messages.length) void pump();
    return response;
  }
  return {request,deliver,messages,sql,operations,close(){closed=true;sql.close();}};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const review=createLocalReview({delayMs:8000,deliveryDelayMs:1200,dbPath:join(mkdtempSync(join(tmpdir(),'aeo-progress-review-')),'review.sqlite')});
  createServer(async(req,res)=>{try {const chunks=[];for await(const chunk of req){chunks.push(chunk);if(Buffer.concat(chunks).length>4096) throw Error('request too large');}
    const request=new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
    const response=await review.request(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  } catch {res.writeHead(500);res.end();}}).listen(4383,'127.0.0.1',()=>process.stdout.write('Local fixture review listening on 127.0.0.1:4383\n'));
}
