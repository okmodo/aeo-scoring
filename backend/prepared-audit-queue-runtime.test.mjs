import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createAuditService} from './service.mjs';
import {createStore} from './store.mjs';
import {createTestAllowanceGuard} from './allowance-store.test-helper.mjs';
import {INCLUDED_CEILINGS} from './allowance-policy.mjs';
import {createSnapshotStore} from './snapshot-store.mjs';
import {createBrowserContentWorkflow} from './browser-content-workflow.mjs';
import {createAuditQueueRuntime} from './audit-queue-runtime.mjs';
import {runPreparedAudit} from './prepared-assessment-consumer.mjs';
import {derivePreparedObservations} from './prepared-derived.mjs';
import {HtmlTestRewriter} from './html-product-test-helper.mjs';
import {OPEN_RUBRIC_RELEASE_ID} from './ai-rubric-assessment.mjs';
import {CONTENT_FACTS_RELEASE_ID} from './content-facts-runner.mjs';
import {PIPELINE_VERSION} from './pipeline-state.mjs';
import {preparedAssessmentPolicy} from './prepared-assessment-policy.mjs';
import {preparedHtml, originalHtml, mixedProvider} from './fixtures/prepared-consumer/provider.mjs';

const start=Date.UTC(2026,10,20), url='https://example.com/kettle', encoder=new TextEncoder();
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');

test('queued audit progresses through durable model checkpoints without an open client', async t => {
  const sql=new DatabaseSync(':memory:');
  try {
    sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
    const db={prepare(query){return{bind(...args){const statement=sql.prepare(query);return{query,
      first:async()=>statement.get(...args)??null,all:async()=>({results:statement.all(...args)}),
      run:async()=>({meta:{changes:Number(statement.run(...args).changes)}})};}};},
      async batch(statements){const results=[];for(const statement of statements) results.push(/^\s*SELECT/i.test(statement.query)?await statement.all():await statement.run());return results;}};
    let time=start, browserCalls=0, billingChecks=0;
    const now=()=>time, calls=[], messages=[], objects=new Map();
    const evidence={verified:true,accountId:'fixture',observedAt:start,cycleStart:start-1000,cycleEnd:start+86400000,
      aiDay:'2026-11-20',usage:Object.fromEntries(Object.keys(INCLUDED_CEILINGS).map(k=>[k,0]))};
    const allowance=createTestAllowanceGuard(db,{accountId:'fixture',evidence});
    const snapshots=createSnapshotStore({db,now,allowance:{reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>({accepted:true})},bucket:{
      put:async(key,value)=>objects.set(key,value.slice()),get:async key=>{const value=objects.get(key);return value&&{size:value.length,body:new Response(value).body};},delete:async key=>objects.delete(key)}});
    const guard={reserve:async()=>({accepted:true,duplicate:false}),start:async()=>({accepted:true,duplicate:false}),settle:async()=>({accepted:true}),cancelUnstarted:async()=>{}};
    const workflow=createBrowserContentWorkflow({db,snapshots,guard,now,binding:{quickAction:async()=>{browserCalls++;return Response.json({success:true,result:originalHtml,meta:{finalUrl:url,status:200}},{headers:{'X-Browser-Ms-Used':'100'}});}},
      preprocess:async({rawHtml,sourceObjectKey,expiresAt})=>{const html=encoder.encode(preparedHtml);return{html,preprocessing:{version:'simplified-html-v1',representation:'cleaned_rendered_html',originalCapturePreserved:true,sourceObjectKey,sourceSha256:await hash(rawHtml),sourceBytes:rawHtml.length,expiresAt,preparedAt:now(),outputBytes:html.length,outputSha256:await hash(html)}};}});
    const fetchImpl=async(endpoint,options)=>{
      if(options.method==='GET'){billingChecks++;return Response.json({success:true,result:{id:'default',workers_ai_billing_mode:'postpaid'}});}
      assert.match(String(endpoint),/\/ai\/run\/@cf\/ibm-granite\/granite-4\.0-h-micro$/);
      const body=JSON.parse(options.body);calls.push(body.messages[0].content);time+=7000;
      const output=mixedProvider({messages:body.messages});
      return Response.json({success:true,result:{response:JSON.stringify(output.response),usage:{prompt_tokens:100,completion_tokens:100,neurons:5}}});
    };
    const env={AUDIT_DB:db,AUDIT_USAGE_READ_TOKEN:'fixture',AUDIT_SNAPSHOTS:{},AUDIT_BROWSER:{},AUDIT_QUEUE_MODE:'enabled',AUDIT_QUEUE:{send:async body=>messages.push(structuredClone(body))},AUDIT_AI_PROVIDER:'granite',AUDIT_AI_GATEWAY_TOKEN:'fixture',AUDIT_RUBRIC_RELEASE:OPEN_RUBRIC_RELEASE_ID,AUDIT_CONTENT_RELEASE:CONTENT_FACTS_RELEASE_ID,AUDIT_PIPELINE_RELEASE:PIPELINE_VERSION};
    const runtime=createAuditQueueRuntime(env,{now,allowance,queueAllowance:{reserve:async()=>({accepted:true,duplicate:false})},workflow,snapshots,
      derive:input=>derivePreparedObservations(input,{HTMLRewriter:HtmlTestRewriter}),
      assess:options=>runPreparedAudit({...options,fetch:fetchImpl})});
    const policyVersion=preparedAssessmentPolicy('granite');
    const handle=createAuditService({store:createStore(db,{policyVersion,queueEnabled:true}),policyVersion,allowance,egress:{fetch(){}},secret:'x'.repeat(32),normalizeUrl:x=>x,now,browserFlow:workflow,requireBrowser:true,snapshotStore:snapshots,pipelineDb:db,enqueueAudit:id=>runtime.start(id)});
    const options={address:'192.0.2.1',defer:()=>assert.fail('queue mode must not schedule request work')};
    const response=await handle(new Request('https://worker/api/v1/audits',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})}),options);
    assert.equal(response.status,202);const submitted=await response.json();assert.equal(submitted.status,'pending');assert.equal(messages.length,1);assert.equal(browserCalls,0);
    const poll=await handle(new Request('https://worker'+submitted.statusUrl),options);assert.equal((await poll.json()).status,'pending');assert.equal(browserCalls,0);assert.equal(calls.length,0);
    const deliver=async body=>{let acked=false,retried=false;await runtime.consume({queue:'aeo-audit-checkpoints',messages:[{body,ack(){acked=true;},retry(){retried=true;}}]});assert.equal(retried,false,JSON.stringify({body,row:sql.prepare('SELECT * FROM audit_queue_jobs WHERE audit_id=?').get(body.auditId)}));assert.equal(acked,true);};
    // After this point the client is closed: only queue deliveries advance the audit.
    let firstAssessment;
    for(let steps=0;messages.length&&steps<40;steps++){
      const body=messages.shift(),before=calls.length;await deliver(body);
      assert.ok(calls.length-before<=1);
      if(calls.length>before&&!firstAssessment){firstAssessment=body;const count=calls.length;await deliver(body);assert.equal(calls.length,count);}
    }
    assert.equal(messages.length,0);assert.ok(firstAssessment);assert.ok(time-start>30000);assert.ok(calls.length>=5);assert.equal(browserCalls,1);
    assert.equal(sql.prepare('SELECT state FROM audit_queue_jobs WHERE audit_id=?').get(submitted.id).state,'complete');
    assert.equal(sql.prepare('SELECT state FROM prepared_assessment_jobs WHERE audit_id=?').get(submitted.id).state,'complete');
    const completedResponse=await handle(new Request('https://worker'+submitted.statusUrl),options);assert.equal(completedResponse.status,200);const completed=await completedResponse.json();
    assert.equal(completed.status,'incomplete');const checks=completed.report.criteria.flatMap(c=>c.subchecks),identity=checks.find(c=>c.id==='C1.identity');
    assert.equal(identity.points,3);assert.ok(identity.evidenceIds.length>0&&identity.evidenceIds.every(id=>completed.report.evidence.some(e=>e.id===id)));
    assert.equal(checks.find(c=>c.id==='C1.explanation').status,'not_measured');assert.ok(completed.report.evidence.some(e=>e.excerpt.includes('Solar kettle')));
    assert.equal(sql.prepare("SELECT amount FROM allowance_settled_v2 WHERE account_id=? AND metric='aiNeurons'").get('fixture').amount,calls.length*5);assert.equal(billingChecks,calls.length);
    t.diagnostic(`Model calls: ${calls.length}; simulated elapsed time: ${time-start} ms`);

    // A failed initial dispatch must close admission before any Browser work.
    const failedRuntime=createAuditQueueRuntime({...env,AUDIT_QUEUE:{send:async()=>{throw Error('queue unavailable');}}},{now,allowance,queueAllowance:{reserve:async()=>({accepted:true,duplicate:false})},workflow,snapshots});
    const failingHandle=createAuditService({store:createStore(db,{policyVersion,queueEnabled:true}),policyVersion,allowance,egress:{fetch(){}},secret:'x'.repeat(32),normalizeUrl:x=>x,now,browserFlow:workflow,requireBrowser:true,snapshotStore:snapshots,pipelineDb:db,enqueueAudit:id=>failedRuntime.start(id)});
    const failed=await failingHandle(new Request('https://worker/api/v1/audits',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://example.com/dispatch-failure'})}),options);
    assert.equal(failed.status,503);assert.equal(browserCalls,1);
    assert.equal(sql.prepare("SELECT status FROM audits WHERE url=?").get('https://example.com/dispatch-failure').status,'unable_to_assess');

    // A dead-letter delivery after preparation publishes an observable partial report.
    const deadPost=await handle(new Request('https://worker/api/v1/audits',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://example.com/dead-letter'})}),options);
    assert.equal(deadPost.status,202);const dead=await deadPost.json();
    await deliver(messages.shift());await deliver(messages.shift());
    const deadBody=messages.shift();let deadAck=false;
    await runtime.consume({queue:'aeo-audit-checkpoints-dead',messages:[{body:deadBody,ack(){deadAck=true;},retry(){assert.fail('dead-letter finalization retried');}}]});
    assert.equal(deadAck,true);const deadResponse=await handle(new Request('https://worker'+dead.statusUrl),options);
    const partial=await deadResponse.json();assert.equal(deadResponse.status,200);assert.equal(partial.status,'incomplete');assert.equal(partial.report.score,null);
    assert.equal(sql.prepare('SELECT code FROM audit_queue_jobs WHERE audit_id=?').get(dead.id).code,'queue_delivery_exhausted');

    // Capture was persisted but the invocation stopped before the ready transition.
    const savedUrl='https://example.com/saved-capture';
    const savedPost=await handle(new Request('https://worker/api/v1/audits',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:savedUrl})}),options);
    assert.equal(savedPost.status,202);const saved=await savedPost.json();
    sql.prepare("INSERT INTO browser_audit_work VALUES (?,'capturing',?,?)").run(saved.id,time,time+120000);
    await snapshots.preserve({auditId:saved.id,snapshot:{url:savedUrl,status:200,retrievalMethod:'browser_api_content',contentType:'text/html'},extracted:{pending:true},rawHtml:encoder.encode(originalHtml)});
    const beforeCapture=browserCalls;
    await deliver(messages.shift());
    assert.equal(browserCalls,beforeCapture);
    assert.equal(sql.prepare('SELECT state FROM browser_audit_work WHERE audit_id=?').get(saved.id).state,'ready');
    await deliver(messages.shift());
    assert.equal(sql.prepare('SELECT prepared_state FROM retained_snapshots WHERE audit_id=?').get(saved.id).prepared_state,'ready');

  } finally {sql.close();}
});
