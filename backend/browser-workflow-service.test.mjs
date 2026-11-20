import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditService } from './service.mjs';

const id = 'd9428888-122b-4c77-8d11-666666666666';
const url = 'https://example.test/product', now = Date.UTC(2026,10,17);
function fixture({failCapture=false, browser=true}={}) {
  let audit={id,url,status:'pending',createdAt:now,expiresAt:now+86400000}, ready=false, claimed=false, captures=0, scores=0, reads=0, task;
  const events=[];
  const initial={coverage:{usable:false},productHtml:null}, rendered={coverage:{usable:true},productHtml:{identity:'Product'}};
  const flow={prepare:async()=>({accepted:true,id:'grant'}),capture:async()=>{captures++;events.push('capture');if(failCapture)throw Error('private');ready=true;events.push('closed');},claim:async()=>{if(!ready||claimed)return false;claimed=true;return true;},read:async()=>{reads++;return{snapshot:{url,browser:{initialExtracted:initial}},extracted:rendered};},finish:async()=>events.push('finished')};
  const handle=createAuditService({store:{reserve:async args=>{assert.equal(args.leaseMs,120000);return{kind:'created',audit};},get:async()=>audit,finish:async(_id,result)=>{audit={...audit,...result};}},allowance:{reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>{}},browserFlow:browser?flow:undefined,requireBrowser:true,snapshotStore:{},egress:{fetch:()=>assert.fail('no HTTP retrieval')},retrievePage:()=>assert.fail('no fallback'),secret:'x'.repeat(32),normalizeUrl:x=>x,now:()=>now,scorePage:(snapshot,extracted,options)=>{scores++;assert.deepEqual(options.initialExtracted,initial);assert.deepEqual(extracted,rendered);return{status:'incomplete',score:null,coverage:{notMeasured:0,limitations:[]}};}});
  const call=async(method,path,body)=>handle(new Request('https://audit.test'+path,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})}),{address:'192.0.2.1',defer:p=>{task=p;}});
  return {call,wait:async()=>{const p=task;task=undefined;if(p)await p;},get audit(){return audit;},get counts(){return{captures,scores,reads};},events};
}
test('capture is separate from one poll-claimed assessment and uses retained source split',async()=>{
  const f=fixture();assert.equal((await f.call('POST','/api/v1/audits',{url})).status,202);await f.wait();assert.deepEqual(f.counts,{captures:1,scores:0,reads:0});
  await Promise.all([f.call('GET','/api/v1/audits/'+id),f.call('GET','/api/v1/audits/'+id)]);await f.wait();assert.deepEqual(f.counts,{captures:1,scores:1,reads:1});assert.deepEqual(f.events,['capture','closed','finished']);assert.equal(f.audit.status,'incomplete');
});
test('capture failure is terminal without fallback or assessment',async()=>{
  const f=fixture({failCapture:true});await f.call('POST','/api/v1/audits',{url});await f.wait();assert.equal(f.audit.status,'unable_to_assess');assert.equal(f.audit.error,'retrieval_failed');assert.deepEqual(f.counts,{captures:1,scores:0,reads:0});
});
test('required browser absence blocks admission without HTTP fallback',async()=>{
  const f=fixture({browser:false});assert.equal((await f.call('POST','/api/v1/audits',{url})).status,503);assert.deepEqual(f.counts,{captures:0,scores:0,reads:0});
});

test('browser workflow retains initial bytes and rendered DTO before an atomic claim',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {createBrowserWorkflow}=await import('./browser-workflow.mjs');
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec("CREATE TABLE browser_audit_work (audit_id TEXT PRIMARY KEY,state TEXT,created_at INTEGER,expires_at INTEGER)");
  const db={prepare(sql){return{bind(...args){const stmt=sqlite.prepare(sql);return{run:async()=>({meta:{changes:Number(stmt.run(...args).changes)}}),first:async()=>stmt.get(...args)??null};}};}};
  let retained;const initial={productHtml:null},extracted={productHtml:{identity:'rendered'}};
  const flow=createBrowserWorkflow({db,now:()=>now,provider:{},guard:{reserve:async request=>{assert.equal(request.maxDurationMs,3_720_000);return{accepted:true,duplicate:false};}},snapshots:{preserve:async value=>{retained=value;},read:async()=>retained},capture:async()=>({url,observedAt:new Date(now).toISOString(),initialHtml:new TextEncoder().encode('<div id="app"></div>'),renderedHtml:'<h1>Product</h1>',initialExtracted:initial,extracted,selectedVariant:{id:'one'},support:{crawlerPolicy:{version:'1'},sitemap:{complete:true},guides:{llms:null},policies:{complete:false}},coverage:{}})});
  const audit={id,url,createdAt:now,expiresAt:now+86400000},grant=await flow.prepare(audit);await flow.capture(audit,grant);
  assert.equal(new TextDecoder().decode(retained.rawHtml),'<div id="app"></div>');assert.equal(retained.snapshot.browser.renderedHtml,'<h1>Product</h1>');assert.deepEqual(retained.snapshot.browser.initialExtracted,initial);assert.deepEqual(retained.extracted,extracted);assert.deepEqual(retained.snapshot.crawlerPolicy,{version:'1'});assert.deepEqual(retained.snapshot.sitemap,{complete:true});assert.deepEqual(retained.snapshot.guides,{llms:null});assert.deepEqual(retained.snapshot.policies,{complete:false});
  assert.deepEqual(await Promise.all([flow.claim(id),flow.claim(id)]),[true,false]);sqlite.close();
});

test('scheduled watchdog reserves usage and limits hourly pruning to 100 expired work records',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {runScheduledMaintenance}=await import('./service.mjs');
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE browser_audit_work (audit_id TEXT PRIMARY KEY,state TEXT,created_at INTEGER,expires_at INTEGER); CREATE TABLE audit_pipeline_state (audit_id TEXT PRIMARY KEY,expires_at INTEGER)');
  const insert=sqlite.prepare('INSERT INTO browser_audit_work VALUES (?, ?, ?, ?)');
  for(let i=0;i<101;i++) insert.run(String(i),'finished',now-1000,now-1);
  insert.run('active','capturing',now,now+1000);
  const db={prepare(sql){return{bind(...args){const stmt=sqlite.prepare(sql);return{run:async()=>({meta:{changes:Number(stmt.run(...args).changes)}})};}};}};
  const events=[];let allow=true;
  const allowance={reserve:async({costs})=>{events.push('reserve');assert.ok(costs.d1Writes>=100);return{accepted:allow,duplicate:false};},settle:async()=>events.push('settle')};
  const options={now,allowance,makeWorkflow:()=>({watchdog:async()=>events.push('watchdog')}),makeSnapshots:()=>({cleanup:async()=>{events.push('cleanup');return{deleted:0};}})};
  const env={AUDIT_DB:db,AUDIT_USAGE_READ_TOKEN:'fixture',AUDIT_BROWSER:{},AUDIT_SNAPSHOTS:{}};
  const hour=Date.UTC(2026,10,17,10,0);
  await runScheduledMaintenance({scheduledTime:hour+60000},env,options);
  assert.deepEqual(events,['reserve','watchdog','settle']);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM browser_audit_work').get().n,102);
  events.length=0;allow=false;await runScheduledMaintenance({scheduledTime:hour},env,options);assert.deepEqual(events,['reserve']);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM browser_audit_work').get().n,102);
  events.length=0;allow=true;await runScheduledMaintenance({scheduledTime:hour},env,options);assert.deepEqual(events,['reserve','watchdog','settle','reserve','cleanup','settle']);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM browser_audit_work').get().n,2);assert.equal(sqlite.prepare("SELECT state FROM browser_audit_work WHERE audit_id='active'").get().state,'capturing');sqlite.close();
});

test('browser open rubric assessment reads retained initial bytes and rendered extraction after capture',async()=>{
  const rawHtml=new TextEncoder().encode('<div id="app"></div>'), initial={productHtml:null}, rendered={productHtml:{identity:'Rendered product'}};
  let audit={id,url,status:'pending',createdAt:now,expiresAt:now+86400000}, ready=false, task, assessCalls=0, scoreCalls=0;
  const flow={prepare:async()=>({accepted:true}),capture:async()=>{ready=true;},claim:async()=>{if(!ready)return false;ready=false;return true;},read:async()=>({snapshot:{url,browser:{initialExtracted:initial}},extracted:rendered,rawHtml}),finish:async()=>{}};
  const handle=createAuditService({store:{reserve:async()=>({kind:'created',audit}),get:async()=>audit,finish:async(_id,result)=>{audit={...audit,...result};}},allowance:{reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>{}},browserFlow:flow,requireBrowser:true,openRubricEnabled:true,AI:{},snapshotStore:{saveAssessment:async()=>{}},egress:{fetch:()=>assert.fail('no HTTP fallback')},secret:'x'.repeat(32),normalizeUrl:x=>x,now:()=>now,
    scorePage:(_snapshot,extracted,options)=>{scoreCalls++;assert.deepEqual(extracted,rendered);assert.deepEqual(options.initialExtracted,initial);if(scoreCalls===1)assert.equal(options.requireAiAssessment,true);else assert.deepEqual(options.aiAssessment,{verified:true});return{status:'incomplete',score:null,coverage:{notMeasured:1,limitations:[]}};},
    assessRubric:async args=>{assessCalls++;assert.deepEqual(args.snapshot.rawHtml,rawHtml);assert.deepEqual(args.extracted,rendered);await args.onProfile({version:'1'});return{status:'assessed',assessment:{verified:true},replayArtifact:{version:'1'}};}});
  const call=async(method,path,body)=>handle(new Request('https://audit.test'+path,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})}),{address:'192.0.2.1',defer:p=>{task=p;}});
  await call('POST','/api/v1/audits',{url});await task;assert.equal(assessCalls,0);await call('GET','/api/v1/audits/'+id);await task;assert.equal(assessCalls,1);assert.equal(scoreCalls,2);assert.equal(audit.status,'incomplete');
});


test('stored capture with preprocessing failure remains incomplete without AI or numerical score',async()=>{
 let audit={id,url,status:'pending',createdAt:now,expiresAt:now+86400000},ready=false,task;
 const flow={prepare:async()=>({accepted:true}),capture:async()=>{ready=true;},claim:async()=>{if(!ready)return false;ready=false;return true;},read:async()=>{throw Object.assign(new Error('private content'),{code:'preprocessing_oversize'});},finish:async()=>{}};
 const handle=createAuditService({store:{reserve:async()=>({kind:'created',audit}),get:async()=>audit,finish:async(_id,result)=>{audit={...audit,...result};}},allowance:{reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>{}},browserFlow:flow,requireBrowser:true,openRubricEnabled:true,AI:{},snapshotStore:{},egress:{fetch:()=>assert.fail()},secret:'x'.repeat(32),normalizeUrl:x=>x,now:()=>now,assessRubric:async()=>assert.fail('AI must not run before prepared R2 verifies')});
 const call=(method,path,body)=>handle(new Request('https://audit.test'+path,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})}),{address:'192.0.2.1',defer:p=>{task=p;}});
 await call('POST','/api/v1/audits',{url});await task;await call('GET','/api/v1/audits/'+id);await task;
 assert.equal(audit.status,'incomplete');assert.equal(audit.report.score,null);assert.equal(audit.report.coverage.measured,0);assert.equal(audit.report.coverage.notMeasured,40);assert.doesNotMatch(JSON.stringify(audit),/private content/);
});
