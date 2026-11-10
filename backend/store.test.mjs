import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createStore } from './store.mjs';

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  function prepare(sql) {
    return { bind(...args) {
      const stmt = sqlite.prepare(sql);
      return {
        run: async () => ({ meta: { changes: Number(stmt.run(...args).changes) } }),
        first: async () => stmt.get(...args) ?? null,
        all: () => ({ results: stmt.all(...args) }),
        execute: () => stmt.columns().length ? { results: stmt.all(...args) } : { meta: { changes: Number(stmt.run(...args).changes) } },
      };
    } };
  }
  return createStore({ prepare, async batch(stmts) {
    sqlite.exec('BEGIN');
    try { const results = stmts.map(s => s.execute()); sqlite.exec('COMMIT'); return results; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } });
}
const request = (id, overrides = {}) => ({ id, url: 'https://example.com/p', cacheKey: 'key', rateKey: 'hashed-client', now: 1000, expiresAt: 100000, windowStart: 0, windowEnd: 3600000, limit: 2, globalLimit: 3, ...overrides });

test('accepted records persist, cache reuses ID, and both requests count', async () => {
  const store = setup();
  const first = await store.reserve(request('a'));
  assert.equal(first.kind, 'created');
  assert.equal((await store.get('a', 1000)).status, 'pending');
  assert.equal(await store.finish('a', { status: 'complete', report: { score: 5 }, completedAt: 2000, cacheUntil: 90000 }), true);
  const hit = await store.reserve(request('b', { now: 3000 }));
  assert.equal(hit.kind, 'cached');
  assert.equal(hit.audit.id, 'a');
  assert.deepEqual(hit.audit.report, { score: 5 });
  assert.equal(hit.audit.cacheUntil, 90000);
  assert.equal((await store.reserve(request('c', { now: 4000 }))).kind, 'limited');
  assert.equal(await store.get('b', 4000), null);
});

test('global and client limits remain atomic for concurrent calls', async () => {
  const store = setup();
  const result = await Promise.all(Array.from({ length: 10 }, (_, i) => store.reserve(request(String(i), { rateKey: String(i), globalLimit: 3 }))));
  assert.equal(result.filter(r => r.kind === 'created').length, 3);
  assert.equal(result.filter(r => r.kind === 'limited').length, 7);
  assert.equal(result[3].retryAfter, 3599);
});

test('stale and expired records cannot be completed or cached', async () => {
  const store = setup();
  await store.reserve(request('a'));
  assert.equal((await store.get('a', 61000)).error, 'assessment_timeout');
  assert.equal(await store.finish('a', { status: 'complete', report: {}, completedAt: 61000, cacheUntil: 90000 }), false);
  assert.equal((await store.get('a', 100000)).status, 'unable_to_assess');
  assert.equal(await store.get('a', 100001), null);
  assert.equal((await store.reserve(request('b', { now: 61000 }))).kind, 'created');
});

test('failed and expired cached results are never reused; pruning is bounded', async () => {
  const store = setup();
  await store.reserve(request('a'));
  await store.finish('a', { status: 'unable_to_assess', error: 'unavailable', completedAt: 2000 });
  assert.equal((await store.reserve(request('b', { rateKey: 'other', now: 3000 }))).kind, 'created');
  await store.finish('b', { status: 'complete', report: {}, completedAt: 4000, cacheUntil: 5000 });
  assert.equal((await store.reserve(request('c', { rateKey: 'third', now: 5000, globalLimit: 4 }))).kind, 'created');
  await store.prune({ now: 100001, admissionBefore: 0, limit: 1 });
  assert.equal(await store.get('a', 2000), null);
  assert.notEqual(await store.get('b', 4000), null);
});


test('incomplete reports retain assessed URL and are cached until expiry', async () => {
  const store = setup();
  await store.reserve(request('a'));
  assert.equal(await store.finish('a', { status: 'incomplete', report: { partial: true }, assessedUrl: 'https://example.com/final', completedAt: 2000, cacheUntil: 5000 }), true);
  const cached = await store.reserve(request('b', { now: 3000 }));
  assert.equal(cached.kind, 'cached');
  assert.equal(cached.audit.id, 'a');
  assert.equal(cached.audit.status, 'incomplete');
  assert.equal(cached.audit.assessedUrl, 'https://example.com/final');
  assert.equal((await store.reserve(request('c', { rateKey: 'other', now: 5000 }))).kind, 'created');
});

test('pruning cannot remove current fixed-hour admissions', async () => {
  const store = setup();
  await store.reserve(request('a', { limit: 1 }));
  await assert.rejects(store.prune({ now: 3000, admissionBefore: 3000 }), TypeError);
  await store.prune({ now: 3000, admissionBefore: 0 });
  assert.equal((await store.reserve(request('b', { now: 3000, limit: 1 }))).kind, 'limited');
  await store.prune({ now: 3600000, admissionBefore: 3600000 });
  assert.equal((await store.reserve(request('c', { now: 3600000, expiresAt: 3700000, windowStart: 3600000, windowEnd: 7200000, limit: 1 }))).kind, 'created');
});

test('semantic reservations enforce a shared UTC-day ceiling atomically and never refund failures', async () => {
  const store = setup();
  const results = await Promise.all(Array.from({length:8},()=>store.reserveSemantic({day:1,neurons:1500})));
  assert.equal(results.filter(Boolean).length,5);
  assert.equal(await store.reserveSemantic({day:1,neurons:501}),false);
  assert.equal(await store.reserveSemantic({day:1,neurons:500}),true);
  assert.equal(await store.reserveSemantic({day:2,neurons:8000}),true);
  await assert.rejects(store.reserveSemantic({day:2,neurons:0}),TypeError);
});
