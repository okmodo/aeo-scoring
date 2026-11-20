import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createSnapshotStore} from './snapshot-store.mjs';
import {createBrowserContentWorkflow} from './browser-content-workflow.mjs';
const id='d9428888-122b-4c77-8d11-666666666666';
const url='https://shop.example.com/products/shorts',time=Date.UTC(2026,10,18);
const frozen=JSON.parse(readFileSync(new URL('../evals/changes/browser-api-content/fixtures/content-response.json',import.meta.url),'utf8'));
const html=frozen.body.result;
const defaults=JSON.parse(readFileSync(new URL('../evals/changes/browser-content-defaults/default-request.json',import.meta.url),'utf8'));
const response=(result=html,options={})=>Response.json({success:true,result,meta:{finalUrl:url,status:200,title:'Everyday Shorts'},...options},{headers:{'X-Browser-Ms-Used':'2500'}});
function fixture({provider=async()=>response(),failPut=false,failPrepare=false,preprocessOverride,onGet,onPut}={}) {
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 const db={prepare(sql){return{bind(...args){const s=sqlite.prepare(sql);return{first:async()=>s.get(...args)??null,all:async()=>({results:s.all(...args)}),run:async()=>{if(failPrepare&&sql.startsWith('INSERT INTO browser_audit_work'))throw Error('D1 unavailable');return{meta:{changes:Number(s.run(...args).changes)}};}};}};}};
 const objects=new Map(),events=[],calls=[],settlements=[];
 const snapshots=createSnapshotStore({db,now:()=>time,bucket:{put:async(k,v)=>{events.push('store');await onPut?.(k);if(failPut)throw Error('R2 unavailable');objects.set(k,v.slice());},get:async k=>{const v=objects.get(k);onGet?.(k);return v&&{size:v.length,body:new Response(v).body};},delete:async keys=>keys.forEach(k=>objects.delete(k))},allowance:{reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>({accepted:true})}});
 const guard={reserve:async()=>({accepted:true,duplicate:false}),start:async()=>({accepted:true}),cancelUnstarted:async()=>{events.push('cancel');return{accepted:true}},settle:async v=>{settlements.push(v.response.headers.get('X-Browser-Ms-Used'));return{accepted:true}}};
 let extracted=0;
 const preprocess=preprocessOverride ?? (async ({rawHtml,sourceObjectKey,expiresAt})=>{events.push('preprocess');const html=new TextEncoder().encode(new TextDecoder().decode(rawHtml).replace(/<!--[\s\S]*?-->/g,''));const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');return {html,preprocessing:{version:'simplified-html-v1',representation:'cleaned_rendered_html',originalCapturePreserved:true,sourceObjectKey,sourceSha256:await digest(rawHtml),sourceBytes:rawHtml.length,outputSha256:await digest(html),outputBytes:html.length,preparedAt:time,expiresAt}};});
 const flow=createBrowserContentWorkflow({db,snapshots,guard,preprocess,binding:{quickAction:async(...args)=>{events.push('provider');calls.push(args);return provider();}},now:()=>time,extractPage:async input=>{events.push('extract');extracted++;assert.ok(input.body instanceof Uint8Array);return{productHtml:{complete:true,blocks:[{text:'Soft cotton shorts with an adjustable waist.',location:'main/p'}]},jsonLd:[],coverage:{html:true,usable:true,jsonLdTruncated:false}};}});
 const audit={id,url,createdAt:time,expiresAt:time+86400000};
 return{flow,audit,snapshots,guard,db,sqlite,objects,events,calls,settlements,get extracted(){return extracted;}};
}
test('one native API call persists complete rendered HTML before any extraction and resumes from R2 inputs',async()=>{
 const large=html.replace('</main>','<!--'+'x'.repeat(1024*1024)+'--><p>LAST PRODUCT DETAIL</p></main>');
 const f=fixture({provider:async()=>response(large)}),grant=await f.flow.prepare(f.audit);
 await f.flow.capture(f.audit,grant);
 assert.deepEqual(f.calls,[['content',{url}]]);
 assert.deepEqual(Object.keys(f.calls[0][1]),defaults.expectation.optionsKeys);
 assert.equal(f.flow.version,'browser-content-v3');assert.equal(defaults.expectation.retrievalVersion,'browser-content-v2');
 assert.equal(f.extracted,0);assert.deepEqual(f.events,['provider','store','store']);
 const retained=await f.snapshots.read(id);assert.equal(new TextDecoder().decode(retained.rawHtml),large);
 assert.equal(retained.snapshot.representation,'rendered_html');assert.deepEqual(retained.extracted,{pending:true});
 assert.deepEqual(await Promise.all([f.flow.claim(id),f.flow.claim(id)]),[true,false]);
 const input=await f.flow.read(id);assert.equal(f.extracted,1);assert.equal(input.snapshot.browser.renderedHtml,large.replace(/<!--[\s\S]*?-->/g,''));assert.deepEqual(input.rawHtml,new TextEncoder().encode(input.snapshot.browser.renderedHtml));
 assert.equal(input.snapshot.browser.coverage.initialAvailable,false);assert.equal(input.snapshot.browser.initialExtracted.productHtml,null);
 assert.ok(input.snapshot.browser.renderedHtml.includes('LAST PRODUCT DETAIL'));assert.equal(f.settlements[0],'2500');
 assert.deepEqual((await f.flow.read(id)).extracted,input.extracted);assert.equal(f.extracted,1);
});
test('provider, invalid and origin-error responses remain safe and origin HTML is retained before refusal to score',async()=>{
 for(const provider of [async()=>Response.json({success:false,errors:[{code:422,message:'untrusted'}]},{status:422,headers:{'X-Browser-Ms-Used':'10'}}),async()=>new Response('invalid',{headers:{'X-Browser-Ms-Used':'10'}}),async()=>response('')]){
  const f=fixture({provider}),grant=await f.flow.prepare(f.audit);await assert.rejects(f.flow.capture(f.audit,grant),{code:'retrieval_failed'});assert.equal(f.objects.size,0);assert.equal(f.extracted,0);assert.equal(f.settlements.length,1);
 }
 const f=fixture({provider:async()=>response('<h1>Missing</h1>',{meta:{finalUrl:url,status:404}})}),grant=await f.flow.prepare(f.audit);
 await assert.rejects(f.flow.capture(f.audit,grant),{diagnosticCode:'browser_api_origin_http_error'});assert.equal(new TextDecoder().decode((await f.snapshots.read(id)).rawHtml),'<h1>Missing</h1>');assert.equal(f.extracted,0);
});
test('storage failure never starts parsing and prepare failure cancels only known unstarted work',async()=>{
 const f=fixture({failPut:true}),grant=await f.flow.prepare(f.audit);await assert.rejects(f.flow.capture(f.audit,grant));assert.equal(f.extracted,0);assert.equal(f.settlements.length,1);
 const stopped=fixture({failPrepare:true});await assert.rejects(stopped.flow.prepare(stopped.audit));assert.deepEqual(stopped.events,['cancel']);assert.equal(stopped.calls.length,0);
});
test('a provider response after deadline cannot trigger extraction or R2 writes',async()=>{
 let resolve;const f=fixture({provider:()=>new Promise(r=>{resolve=r})});
 const flow=createBrowserContentWorkflow({db:f.db,snapshots:f.snapshots,guard:f.guard,binding:{quickAction:()=>new Promise(r=>{resolve=r})},now:()=>time,captureTimeoutMs:5});
 const grant=await flow.prepare(f.audit);await assert.rejects(flow.capture(f.audit,grant),{code:'retrieval_timeout'});resolve(response());await new Promise(r=>setTimeout(r,10));assert.equal(f.objects.size,0);assert.equal(f.extracted,0);assert.deepEqual(f.settlements,['2500']);
});

test('oversize transport and HTML, invalid metadata and private final URLs fail without partial persistence',async()=>{
 for(const provider of [async()=>new Response(' '.repeat(16*1024*1024+1)),async()=>response('x'.repeat(8*1024*1024+1)),async()=>response(html,{meta:{status:200}}),async()=>response(html,{meta:{status:200,finalUrl:'http://127.0.0.1/private'}})]){
  const f=fixture({provider}),grant=await f.flow.prepare(f.audit);await assert.rejects(f.flow.capture(f.audit,grant));assert.equal(f.objects.size,0);assert.equal(f.extracted,0);
 }
});

test('prepared artifact is durable, bound to original, and reused after restart; tampering fails closed',async()=>{
 const f=fixture(),grant=await f.flow.prepare(f.audit);await f.flow.capture(f.audit,grant);
 const first=await f.flow.read(id);assert.equal(f.events.filter(e=>e==='preprocess').length,1);
 f.sqlite.prepare("UPDATE retained_snapshots SET inputs_state=NULL, inputs_size=NULL, inputs_hash=NULL WHERE audit_id=?").run(id);
 const resumed=createBrowserContentWorkflow({db:f.db,snapshots:f.snapshots,guard:f.guard,binding:{quickAction:async()=>assert.fail()},now:()=>time,preprocess:async()=>assert.fail('must reuse prepared'),extractPage:async()=>first.extracted});
 assert.deepEqual((await resumed.read(id)).rawHtml,first.rawHtml);
 const key=[...f.objects.keys()].find(k=>k.endsWith('/prepared'));f.objects.set(key,new TextEncoder().encode('{}'));
 await assert.rejects(resumed.read(id),{code:'snapshot_corrupt'});
});
test('pending prepared artifact blocks parsing and expiration prevents reuse',async()=>{
 const f=fixture(),grant=await f.flow.prepare(f.audit);await f.flow.capture(f.audit,grant);
 f.sqlite.prepare("UPDATE retained_snapshots SET prepared_state='pending' WHERE audit_id=?").run(id);
 await assert.rejects(f.flow.read(id),{code:'snapshot_unavailable'});assert.equal(f.extracted,0);
 f.sqlite.prepare("UPDATE retained_snapshots SET created_at=?, expires_at=? WHERE audit_id=?").run(time-86400000,time,id);
 await assert.rejects(f.flow.read(id),{code:'snapshot_expired'});
});

test('expired during prepared read cannot produce inputs',async()=>{
 let clock=time, expireOnRead=false;
 const f=fixture({onGet:key=>{if(expireOnRead&&key.endsWith('/prepared'))clock=time+86400000;}}),grant=await f.flow.prepare(f.audit);
 await f.flow.capture(f.audit,grant);
 const captured=await f.snapshots.read(id);
 const bytes=new TextEncoder().encode('<p>clean</p>');
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
 await f.snapshots.saveAssessment({auditId:id,kind:'prepared',artifact:{version:'1',html:'<p>clean</p>',preprocessing:{version:'simplified-html-v1',representation:'cleaned_rendered_html',originalCapturePreserved:true,sourceObjectKey:captured.source.objectKey,sourceSha256:captured.source.sha256,sourceBytes:captured.source.bytes,expiresAt:captured.source.expiresAt,preparedAt:time,outputBytes:bytes.length,outputSha256:hash}}});
 // A fresh store observes expiration while the object stream is being acquired.
 const bucket={get:async key=>{const value=f.objects.get(key);if(key.endsWith('/prepared'))clock=time+86400000;return value&&{size:value.length,body:new Response(value).body}},put:async()=>{},delete:async()=>{}};
 const snapshots=createSnapshotStore({db:f.db,bucket,now:()=>clock,allowance:{reserve:async()=>({accepted:true}),settle:async()=>({accepted:true})}});
 const resumed=createBrowserContentWorkflow({db:f.db,snapshots,guard:f.guard,binding:{quickAction:async()=>assert.fail()},now:()=>clock,preprocess:async()=>assert.fail(),extractPage:async()=>assert.fail()});
 expireOnRead=true;await assert.rejects(resumed.read(id),{code:'snapshot_expired'});assert.equal(f.extracted,0);
});

test('oversized escaped prepared JSON fails before R2 admission or publication',async()=>{
 const f=fixture(),grant=await f.flow.prepare(f.audit);await f.flow.capture(f.audit,grant);
 const before=f.objects.size;
 await assert.rejects(f.snapshots.saveAssessment({auditId:id,kind:'prepared',artifact:{version:'1',html:'\u0000'.repeat(2*1024*1024),preprocessing:{}}}),{code:'snapshot_oversize'});
 assert.equal(f.objects.size,before);assert.equal(f.sqlite.prepare('SELECT prepared_state FROM retained_snapshots').get().prepared_state,null);
});

test('concurrent prepared publication fails closed while pending and retries after completion',async()=>{
 let entered,release;const started=new Promise(r=>{entered=r}),hold=new Promise(r=>{release=r});
 const f=fixture({onPut:async key=>{if(key.endsWith('/prepared')){entered();await hold;}}}),grant=await f.flow.prepare(f.audit);
 await f.flow.capture(f.audit,grant);
 const writer=f.flow.read(id);await started;
 await assert.rejects(f.flow.read(id),{code:'snapshot_unavailable'});assert.equal(f.extracted,0);
 release();await writer;const result=await f.flow.read(id);assert.equal(f.extracted,1);assert.equal(result.snapshot.preprocessing.version,'simplified-html-v1');
});
