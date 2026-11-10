import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAuditService } from './service.mjs';

const read = name => JSON.parse(readFileSync(new URL('../contracts/v1/examples/' + name + '.json', import.meta.url), 'utf8'));
const pending = read('submission-pending');
const target = 'https://audit.example/api/v1/audits';
const time = Date.parse(pending.createdAt);
const address = '192.0.2.1';
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
  const handle = createAuditService({
    store, secret: 'x'.repeat(32), HTMLRewriter: Rewriter, now: () => clock,
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
  const handle = createAuditService({
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
  const handle = createAuditService({
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
    const handle = createAuditService({
      store: { reserve: async () => ({kind:'created', audit}),
        finish: async (_id, updates) => {audit = {...audit, ...updates};} },
      egress: {fetch: async () => assert.fail('injected retrieval')},
      secret: 'x'.repeat(32), HTMLRewriter: Rewriter, now: () => time + 2000,
      retrievePage: async (_url, {consumeHtml}) => {
        const extracted = await consumeHtml({body: new ReadableStream()});
        consumed = true;
        return {url: pending.submittedUrl, htmlLimited, extracted,
          sitemap: {usableSource:'https://shop.example/sitemap.xml'}};
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
