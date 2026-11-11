import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAuditService } from './service.mjs';

const read = name => JSON.parse(readFileSync(new URL('../contracts/v1/examples/' + name + '.json', import.meta.url), 'utf8'));
const pending = read('submission-pending');
const target = 'https://audit.example/api/v1/audits';
const time = Date.parse(pending.createdAt);
const address = '192.0.2.1';
const allowance = { reserve: async () => ({accepted:true, duplicate:false}) };
const post = (value) => new Request(target, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});
const poll = () => new Request('https://audit.example' + pending.statusUrl);
const fixtureAudit = {
  id: pending.id, url: pending.submittedUrl, status: 'pending', createdAt: time,
  expiresAt: Date.parse(pending.expiresAt), completedAt: null, report: null, error: null,
};
class Rewriter {
  handlers = new Map();
  on(selector, handler) { this.handlers.set(selector, handler); return this; }
  transform(response) {
    this.handlers.get('body p').text({ text: 'Road running shoe.', lastInTextNode: true });
    let endScript;
    this.handlers.get('script[type="application/ld+json"]').element({onEndTag: callback => {endScript = callback;}});
    this.handlers.get('script[type="application/ld+json"]').text({
      text: JSON.stringify({'@context':'https://schema.org','@type':'Product',url:pending.submittedUrl,name:'Example Road Shoe',description:'A running shoe for everyday training.',image:'https://shop.example/shoe.png'}),
      lastInTextNode: true,
    });
    endScript();
    return response;
  }
}

test('submission, polling, and cache reuse match the frozen service responses', async () => {
  let audit;
  let clock = time;
  let task;
  let fetches = 0;
  const store = {
    reserve: async input => {
      assert.equal(input.url, pending.submittedUrl);
      assert.match(input.rateKey, /^[a-f0-9]{64}$/);
      assert.match(input.cacheKey, /^[a-f0-9]{64}$/);
      assert.equal(input.limit, 5);
      assert.equal(input.globalLimit, 60);
      if (audit?.status === 'incomplete') return {kind:'cached', audit};
      audit = {...fixtureAudit};
      return {kind:'created', audit};
    },
    get: async () => audit,
    finish: async (_id, updates) => { audit = {...audit, ...updates}; },
  };
  const handle = createAuditService({ allowance,
    store, secret: 'x'.repeat(32), HTMLRewriter: Rewriter, now: () => clock,
    // This test freezes transport/storage behavior. Real scoring has dedicated extraction/report regressions.
    scorePage: () => read('assessment-incomplete').report,
    egress: { fetch: async url => {
      fetches++;
      if (new URL(url).pathname === '/robots.txt') return new Response(null, {status:404});
      return new Response('<body><p>Road running shoe.</p></body>', {headers:{'content-type':'text/html'}});
    }},
  });
  const context = {address, defer: promise => { clock += 2000; task = promise; }};
  const accepted = await handle(post({url:pending.submittedUrl+'#ignored'}), context);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get('location'), pending.statusUrl);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
  assert.equal(accepted.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.deepEqual(await accepted.json(), pending);
  assert.deepEqual(await (await handle(poll())).json(), read('status-pending'));
  await task;
  assert.deepEqual(await (await handle(poll())).json(), read('assessment-incomplete'));
  const cached = await handle(post({url:pending.submittedUrl}), context);
  assert.equal(cached.status, 200);
  assert.deepEqual(await cached.json(), read('cached-assessment'));
  assert.equal(fetches, 2);
});

test('retrieval failure is terminal without a report or score', async () => {
  let audit = {...fixtureAudit};
  let task;
  const handle = createAuditService({ allowance,
    store: {
      reserve: async () => ({kind:'created', audit}),
      finish: async (_id, updates) => {audit = {...audit, ...updates};},
      get: async () => audit,
    },
    egress: {fetch: async () => new Response('Service unavailable', { status: 503 })},
    secret: 'x'.repeat(32), HTMLRewriter: Rewriter, now: () => time + 2000,
  });
  await handle(post(read('submission-request')), {address,defer: promise => {task = promise;}});
  await task;
  const response = await handle(poll());
  assert.equal(response.status, 200);
  const expected = read('retrieval-failure');
  expected.error = { code: 'retrieval_failed', message: 'The page could not be retrieved or inspected.', retryAfterSeconds: null };
  assert.deepEqual(await response.json(), expected);
});

test('bad input and rate limits produce stable errors without retrieval', async () => {
  const handle = createAuditService({ allowance,
    store: {reserve: async () => ({kind:'limited',retryAfter:900})},
    egress: {fetch: async () => assert.fail('Unexpected fetch')},
    secret:'x'.repeat(32), HTMLRewriter: Rewriter,
  });
  for (const body of [{url:'http://127.0.0.1'},{url:pending.submittedUrl,email:'unused@example.com'},{url:'https://shop.example/'+ 'x'.repeat(4100)}]) {
    const invalid = await handle(post(body));
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), read('invalid-input'));
  }
  const limited = await handle(post(read('submission-request')), {address, defer: () => assert.fail('Unexpected background task')});
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '900');
  assert.deepEqual(await limited.json(), read('rate-limited'));
  assert.deepEqual(await (await handle(post(read('submission-request')))).json(), read('service-unavailable'));
});

test('full synthetic report reconciles its fixed scales, evidence and conditional fixes', () => {
  const { report } = read('assessment-complete');
  const {score,criteria,evidence,fixes} = report;
  assert.equal(score.total, score.structure + score.content);
  for (const [pillar, max] of [['structure',40], ['content',60]]) {
    const selected = criteria.filter(c => c.pillar === pillar);
    assert.equal(selected.reduce((sum,c) => sum+c.maxPoints,0), max);
    assert.equal(selected.reduce((sum,c) => sum+c.points,0), score[pillar]);
  }
  const ids = new Set(evidence.map(item => item.id));
  const checks = new Map(criteria.flatMap(c => c.subchecks).map(check => [check.id,check]));
  for (const item of [...checks.values(),...fixes]) assert.ok(item.evidenceIds.every(id => ids.has(id)));
  for (const fix of fixes) {
    assert.ok(fix.owner && fix.condition);
    assert.equal(fix.recoverablePoints, fix.checkIds.reduce((sum,id) => {
      const check = checks.get(id);
      return sum + check.maxPoints - check.points;
    },0));
  }
  const affected = fixes.flatMap(f => f.checkIds);
  assert.equal(new Set(affected).size, affected.length);
});

test('a limited stream returns an incomplete report even when no HTML is usable', async () => {
  for (const htmlLimited of ['bytes', 'time']) {
    let audit = {...fixtureAudit};
    let task;
    let consumed = false;
    const handle = createAuditService({ allowance,
      store: { reserve: async () => ({kind:'created', audit}),
        finish: async (_id, updates) => {audit = {...audit, ...updates};} },
      egress: {fetch: async () => assert.fail('injected retrieval')},
      secret: 'x'.repeat(32), HTMLRewriter: Rewriter, now: () => time + 2000,
      retrievePage: async (_url, {consumeHtml}) => {
        const extracted = await consumeHtml({body: new ReadableStream()});
        consumed = true;
        return {url: pending.submittedUrl, htmlLimited, extracted,
          sitemap: {usableSource:'https://shop.example/sitemap.xml',complete:true}};
      },
      extractPage: async () => ({jsonLd: [], coverage: {usable:false, jsonLdTruncated:false}}),
    });
    await handle(post(read('submission-request')), {address, defer: promise => {task = promise;}});
    await task;
    assert.equal(consumed, true);
    assert.equal(audit.status, 'incomplete');
    assert.equal(audit.report.score, null);
    assert.equal(audit.report.criteria.find(c => c.id === 'S6').subchecks[0].fraction, 1);
  }
});

test('an AI binding leaves the deterministic report intact until facts calibration is approved', async () => {
  let audit={...fixtureAudit}, task, cacheKey;
  let scores=0, reservations=0, modelCalls=0;
  const handle=createAuditService({ allowance,
    store:{reserve:async input=>{cacheKey=input.cacheKey;return {kind:'created',audit};},finish:async(_id,updates)=>{audit={...audit,...updates};},reserveSemantic:async()=>{reservations++;return true;}},
    AI:{run:async()=>{modelCalls++;throw new Error('Must remain disabled');}},
    egress:{fetch:async()=>assert.fail('Injected retrieval should be used')},secret:'x'.repeat(32),HTMLRewriter:Rewriter,now:()=>time,
    retrievePage:async()=>({url:pending.submittedUrl,extracted:{coverage:{usable:true},productHtml:{complete:true,identity:'Example Road Shoe',blocks:[]}}}),
    scorePage:(_snapshot,_extracted,options)=>{scores++;assert.equal(options,undefined);return {status:'incomplete',category:'running-shoes',coverage:{limitations:[]}};},
  });
  const response=await handle(post({url:pending.submittedUrl}),{address,defer:p=>{task=p;}});
  assert.equal(response.status,202);await task;
  assert.equal(audit.status,'incomplete');assert.equal(scores,1);assert.equal(reservations,0);assert.equal(modelCalls,0);
  assert.match(audit.report.coverage.limitations[0],/calibration/);
  const cryptoInput='audit-v1:rubric-1.0.0:categories-1.2:scoring-10:content-facts-1.0.0:ai-1:calibrated-0:'+pending.submittedUrl;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(cryptoInput));
  assert.equal(cacheKey,Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join(''));
});

test('missing, invalid, exhausted and duplicate allowance block submissions and polls before storage or egress', async () => {
  const store = { reserve: () => assert.fail('Unexpected admission'), get: () => assert.fail('Unexpected lookup') };
  const egress = { fetch: () => assert.fail('Unexpected retrieval') };
  for (const [guard, status] of [
    [undefined, 503],
    [{reserve: async () => ({accepted:false, reason:'invalid_evidence'})}, 503],
    [{reserve: async () => ({accepted:false, reason:'allowance_exhausted'})}, 429],
    [{reserve: async () => ({accepted:true, duplicate:true})}, 503],
    [{reserve: async () => {throw Error('unavailable');}}, 503],
  ]) {
    const handle = createAuditService({store, allowance:guard, egress, secret:'x'.repeat(32), HTMLRewriter:Rewriter, now:()=>time});
    assert.equal((await handle(post(read('submission-request')), {address, defer:()=>assert.fail('Unexpected task')})).status, status);
    assert.equal((await handle(poll())).status, status);
  }
});

test('oversized reports are not persisted and oversized cached reports are not returned', async () => {
  let updates, task;
  const audit = {...fixtureAudit};
  const store = {reserve:async()=>({kind:'created',audit}),finish:async(_id, value)=>{updates=value;}};
  const handle = createAuditService({allowance, store, egress:{fetch:()=>assert.fail('injected retrieval')}, secret:'x'.repeat(32), HTMLRewriter:Rewriter, now:()=>time,
    retrievePage:async()=>({url:pending.submittedUrl,extracted:{coverage:{usable:true}}}), scorePage:()=>({status:'incomplete', data:'x'.repeat(300000)})});
  assert.equal((await handle(post(read('submission-request')), {address,defer:p=>{task=p;}})).status,202);
  await task;
  assert.equal(updates.status,'unable_to_assess');
  assert.equal(updates.report,undefined);
  store.reserve = async()=>({kind:'cached',audit:{...audit,report:{data:'x'.repeat(300000)}}});
  assert.equal((await handle(post(read('submission-request')), {address,defer:()=>assert.fail('Unexpected task')})).status,503);
});

test('worker production entry and scheduled maintenance remain paused', async () => {
  const {handleAuditRequest, default: worker} = await import('./service.mjs');
  const env = {AUDIT_DB:{prepare:()=>assert.fail('Unexpected database access')}, AUDIT_EGRESS:{fetch:()=>assert.fail('Unexpected retrieval')}, AUDIT_RATE_SECRET:'x'.repeat(32)};
  const previous = globalThis.HTMLRewriter;
  globalThis.HTMLRewriter = Rewriter;
  try {
    const request = new Request(target, {method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':address},body:JSON.stringify(read('submission-request'))});
    assert.equal((await handleAuditRequest(request,env,{waitUntil:()=>assert.fail('Unexpected task')})).status,503);
    await worker.scheduled({},env);
  } finally { globalThis.HTMLRewriter = previous; }
});

test('service release flag controls inference and isolates calibrated cache entries', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const {handleAuditRequest}=await import('./service.mjs');
  const {CONTENT_FACTS_RELEASE_ID}=await import('./content-facts-runner.mjs');
  const {createTestAllowanceGuard}=await import('./allowance-store.test-helper.mjs');
  const {METRICS}=await import('./allowance-policy.mjs');
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  const db={prepare(sql){return {bind(...args){
    const stmt=sqlite.prepare(sql);
    return {query:/^\s*SELECT\b/i.test(sql),run:async()=>({meta:{changes:Number(stmt.run(...args).changes)}}),first:async()=>stmt.get(...args)??null,
      all:async()=>({results:stmt.all(...args)})};
  }};},async batch(items){const result=[];for(const item of items) result.push(item.query ? await item.all() : await item.run());return result;}};
  const now=Date.now(), account='a'.repeat(32), usage=Object.fromEntries(METRICS.map(key=>[key,0]));
  const evidence={verified:true,accountId:account,observedAt:now,cycleStart:now-1000,cycleEnd:now+3600000,aiDay:new Date(now).toISOString().slice(0,10),usage};
  await createTestAllowanceGuard(db,{accountId:account,evidence}).reserve({id:'seed',costs:{requests:1},now});
  let modelCalls=0, task;
  const env={AUDIT_DB:db,AUDIT_BILLING_ACCOUNT_ID:account,AUDIT_BILLING_SUBSCRIPTION_ID:'fixture-subscription',AUDIT_RATE_SECRET:'x'.repeat(32),AUDIT_AI:{run:async()=>{modelCalls++;throw new Error('offline stub');}}};
  const options={egress:{fetch:async()=>assert.fail('unexpected egress')},retrievePage:async url=>({url,extracted:{coverage:{usable:true},productHtml:{complete:true,identity:'Acme Road Running Shoes',blocks:[{text:'Upper: nylon.',location:'description'}],links:[]},jsonLd:[]}})};
  const submit=async body=>{task=null;const req=new Request(target,{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':address},body:JSON.stringify(body)});const response=await handleAuditRequest(req,env,{waitUntil:p=>{task=p;}},options);if(task) await task;return response;};
  const previous=globalThis.HTMLRewriter;globalThis.HTMLRewriter=Rewriter;
  try {
    const rejected=await submit({url:pending.submittedUrl,AUDIT_CONTENT_RELEASE:CONTENT_FACTS_RELEASE_ID});
    assert.equal(rejected.status,400);assert.equal(modelCalls,0);
    assert.equal((await submit({url:pending.submittedUrl})).status,202);
    assert.equal(modelCalls,0);
    env.AUDIT_CONTENT_RELEASE='wrong';
    assert.equal((await submit({url:pending.submittedUrl})).status,200);
    assert.equal(modelCalls,0);
    env.AUDIT_CONTENT_RELEASE=CONTENT_FACTS_RELEASE_ID;
    assert.equal((await submit({url:pending.submittedUrl})).status,202);
    assert.equal(modelCalls,1);
    const rows=sqlite.prepare('SELECT cache_key,status FROM audits ORDER BY created_at').all();
    assert.equal(rows.length,2);assert.notEqual(rows[0].cache_key,rows[1].cache_key);
    assert.ok(rows.every(row=>row.status==='incomplete'));
  } finally {globalThis.HTMLRewriter=previous;sqlite.close();}
});

test('invocation hold settles only after both response and background work finish', async () => {
  let task, release, reservedId;
  const settled=[];
  const handle=createAuditService({allowance:{reserve:async r=>{reservedId=r.id;return {accepted:true,duplicate:false};},settle:async r=>settled.push(r)},
    store:{reserve:async()=>({kind:'created',audit:fixtureAudit}),finish:async()=>{}},secret:'x'.repeat(32),HTMLRewriter:Rewriter,
    egress:{fetch:async()=>new Response()},retrievePage:()=>new Promise(resolve=>{release=resolve;}),
    extractPage:async()=>({coverage:{usable:true}}),scorePage:()=>read('assessment-incomplete').report});
  const response=await handle(post({url:pending.submittedUrl}),{address,defer:p=>{task=p;}});
  assert.equal(response.status,202);assert.deepEqual(settled,[]);
  release({url:pending.submittedUrl});await task;
  assert.deepEqual(settled,[{id:reservedId}]);
});
