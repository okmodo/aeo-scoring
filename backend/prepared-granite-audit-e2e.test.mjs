import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAuditService } from './service.mjs';
import { createStore } from './store.mjs';
import { createTestAllowanceGuard } from './allowance-store.test-helper.mjs';
import { INCLUDED_CEILINGS } from './allowance-policy.mjs';
import { createSnapshotStore } from './snapshot-store.mjs';
import { runPreparedAudit } from './prepared-assessment-consumer.mjs';
import { derivePreparedObservations } from './prepared-derived.mjs';
import { HtmlTestRewriter } from './html-product-test-helper.mjs';
import { OPEN_RUBRIC_RELEASE_ID } from './ai-rubric-assessment.mjs';
import { CONTENT_FACTS_RELEASE_ID } from './content-facts-runner.mjs';
import { PIPELINE_VERSION } from './pipeline-state.mjs';
import { preparedAssessmentPolicy } from './prepared-assessment-policy.mjs';
import { preparedHtml, originalHtml, mixedProvider } from './fixtures/prepared-consumer/provider.mjs';

const time = Date.UTC(2026, 10, 20), url = 'https://example.com/kettle', encoder = new TextEncoder();
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');

test('submitted audit reaches a polled report through Granite and retained prepared assessment', async t => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    const db = {
      prepare(query) { return { bind(...args) {
        const statement = sql.prepare(query);
        return { query, first: async () => statement.get(...args) ?? null,
          all: async () => ({results: statement.all(...args)}),
          run: async () => ({meta: {changes: Number(statement.run(...args).changes)}}) };
      } }; },
      async batch(statements) { const results = []; for (const statement of statements) {
        results.push(/^\s*SELECT/i.test(statement.query) ? await statement.all() : await statement.run());
      } return results; },
    };
    const evidence = {verified:true, accountId:'fixture', observedAt:time, cycleStart:time-1000, cycleEnd:time+86400000,
      aiDay:'2026-11-20', usage:Object.fromEntries(Object.keys(INCLUDED_CEILINGS).map(k => [k,0]))};
    const allowance = createTestAllowanceGuard(db, {accountId:'fixture', evidence});
    const objects = new Map();
    const snapshots = createSnapshotStore({db, now:()=>time, allowance:{reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>({accepted:true})}, bucket:{
      put:async (key,value)=>objects.set(key,value.slice()),
      get:async key=>{const value=objects.get(key); return value && {size:value.length,body:new Response(value).body};},
      delete:async key=>objects.delete(key),
    }});
    const browserFlow = {prepare:async()=>({accepted:true}), capture:async audit=>{
      await snapshots.preserve({auditId:audit.id,snapshot:{url,status:200,contentType:'text/html',retrievalMethod:'browser_api_content',captureVersion:'browser-content-v2'},extracted:{pending:true},rawHtml:encoder.encode(originalHtml)});
      const row=sql.prepare('SELECT * FROM retained_snapshots WHERE audit_id=?').get(audit.id), clean=encoder.encode(preparedHtml), original=encoder.encode(originalHtml);
      await snapshots.saveAssessment({auditId:audit.id,kind:'prepared',artifact:{version:'1',html:preparedHtml,preprocessing:{version:'simplified-html-v1',representation:'cleaned_rendered_html',originalCapturePreserved:true,sourceObjectKey:row.object_prefix+'/html',sourceSha256:await hash(original),sourceBytes:original.length,expiresAt:row.expires_at,preparedAt:time,outputBytes:clean.length,outputSha256:await hash(clean)}}});
    }};
    let background;
    const policyVersion=preparedAssessmentPolicy('granite');
    const handle=createAuditService({store:createStore(db,{policyVersion}),policyVersion,allowance,egress:{fetch(){}},secret:'x'.repeat(32),normalizeUrl:x=>x,now:()=>time,browserFlow,requireBrowser:true,snapshotStore:snapshots,pipelineDb:db,dispatchPreparation:async()=>{}});
    const options={address:'192.0.2.1',defer:p=>{background=p;}};
    const post=await handle(new Request('https://worker/api/v1/audits',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})}),options);
    assert.equal(post.status,202); const submitted=await post.json(); assert.equal(submitted.status,'pending');
    await background;
    const pending=await handle(new Request('https://worker'+submitted.statusUrl),options);
    assert.equal((await pending.json()).status,'pending');
    const env={AUDIT_DB:db,AUDIT_AI_PROVIDER:'granite',AUDIT_AI_GATEWAY_TOKEN:'fixture',AUDIT_RUBRIC_RELEASE:OPEN_RUBRIC_RELEASE_ID,AUDIT_CONTENT_RELEASE:CONTENT_FACTS_RELEASE_ID,AUDIT_PIPELINE_RELEASE:PIPELINE_VERSION};
    const calls=[];
    let billingChecks=0;
    const fetchImpl=async (endpoint,options)=>{
      if (options.method === 'GET') {
        assert.match(String(endpoint), /\/ai-gateway\/gateways\/default$/);
        billingChecks++;
        return Response.json({success:true,result:{id:'default',workers_ai_billing_mode:'postpaid'}});
      }
      assert.match(String(endpoint),/\/ai\/run\/@cf\/ibm-granite\/granite-4\.0-h-micro$/);
      const body=JSON.parse(options.body); assert.equal(new Headers(options.headers).get('cf-aig-gateway-id'),'default');
      assert.equal(body.stream,false); assert.equal(body.max_tokens,8192); assert.ok(Array.isArray(body.messages));
      const output=mixedProvider({messages:body.messages}); calls.push(body.messages[0].content);
      return Response.json({success:true,result:{response:JSON.stringify(output.response),usage:{prompt_tokens:100,completion_tokens:100,neurons:5}}});
    };
    let result;
    for(let step=0;step<20;step++) {
      const before=calls.length;
      result=await runPreparedAudit({env,auditId:submitted.id,now:()=>time,allowance,snapshots,derive:input=>derivePreparedObservations(input,{HTMLRewriter:HtmlTestRewriter}),fetch:fetchImpl});
      assert.ok(calls.length-before<=1);
      if(result.status!=='yield') break;
    }
    assert.equal(result.status,'completed',JSON.stringify(result)); assert.ok(calls.length>=5 && calls.length<=20);
    assert.ok(calls.some(s=>s.includes('Identify only the primary')));
    assert.ok(calls.some(s=>s.includes('Inspect this entire source')));
    const polled=await handle(new Request('https://worker'+submitted.statusUrl),options);
    assert.equal(polled.status,200); const completed=await polled.json();
    assert.equal(completed.version,'1'); assert.equal(completed.id,submitted.id); assert.equal(completed.status,'incomplete');
    assert.equal(completed.report.score,null); assert.ok(Array.isArray(completed.report.evidence));
    const checks=completed.report.criteria.flatMap(c=>c.subchecks);
    assert.equal(checks.find(c=>c.id==='S4.title').fraction,1);
    const identity=checks.find(c=>c.id==='C1.identity');
    assert.equal(identity.points,3);
    assert.ok(identity.evidenceIds.length>0 && identity.evidenceIds.every(id=>completed.report.evidence.some(e=>e.id===id)));
    assert.equal(checks.find(c=>c.id==='C1.explanation').status,'not_measured');
    const facts=await snapshots.readAssessment(submitted.id,'facts');
    assert.equal(facts.judgments.judgments.find(x=>x.id==='C1.identity').fraction,1);
    assert.ok(facts.diagnostics.some(x=>x.context==='judgment:C1.explanation'));
    assert.ok(completed.report.evidence.some(e=>e.excerpt.includes('Solar kettle')));
    assert.equal(sql.prepare('SELECT state FROM prepared_assessment_jobs WHERE audit_id=?').get(submitted.id).state,'complete');
    const day=sql.prepare("SELECT amount FROM allowance_settled_v2 WHERE account_id=? AND metric='aiNeurons'").get('fixture');
    assert.equal(day.amount,calls.length*5);
    assert.equal(billingChecks,calls.length);
    assert.equal(sql.prepare("SELECT amount FROM allowance_pending_v2 WHERE account_id=? AND metric='aiNeurons'").get('fixture').amount,0);
    assert.equal((await allowance.reserve({id:'over-limit',costs:{aiNeurons:6000},now:time})).reason,'allowance_exhausted');
    t.diagnostic(JSON.stringify({submission:202,preparedState:'ready',gateway:'default',billingChecks,modelCalls:calls.length,polled:200,status:completed.status,score:completed.report.score,identityPoints:identity.points,verifiedExcerpt:'Solar kettle',unverifiedCheck:'C1.explanation',fixtureNeurons:day.amount,dailyCeiling:6000}));
  } finally { sql.close(); }
});
