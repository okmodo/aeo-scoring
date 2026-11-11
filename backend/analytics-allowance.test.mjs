import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAnalyticsAllowanceGuard } from './analytics-allowance.mjs';
import { INCLUDED_CEILINGS } from './allowance-policy.mjs';

const now = Date.UTC(2026, 10, 10, 23, 59);
const zero = Object.fromEntries(Object.keys(INCLUDED_CEILINGS).map(k => [k, 0]));
const config = { accountId: 'account', subscriptionId: 'subscription', allocations: { ...INCLUDED_CEILINGS, requests: 10, d1StorageBytes: 10 } };
function snapshot(at, usage = {}, cycleStart = now - 1000, cycleEnd = now + 86400000) {
  return { cycleStart, cycleEnd, observedAt: at, aiDay: new Date(at).toISOString().slice(0, 10), usage: { ...zero, ...usage }, mode: 'estimated' };
}
function setup(collect) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) { return { bind(...args) { const stmt = sqlite.prepare(sql); return { run: async () => stmt.run(...args), first: async () => stmt.get(...args) ?? null }; } }; } };
  return { sqlite, guard: createAnalyticsAllowanceGuard(db, config, { collect }) };
}
const reserve = (guard, id, at = now, costs = { requests: 1 }) => guard.reserve({ id, now: at, costs });

test('activates and caches an estimate until it expires', async () => {
  let calls = 0;
  const { sqlite, guard } = setup(async ({ now: at }) => { calls++; return snapshot(at); });
  assert.equal((await reserve(guard, 'a')).accepted, true);
  assert.equal((await reserve(guard, 'b', now + 1)).accepted, true);
  assert.equal(calls, 1);
  assert.equal(sqlite.prepare('SELECT diagnostic_status FROM allowance_receipts').get().diagnostic_status, 'analytics_estimate');
  assert.equal((await reserve(guard, 'c', now + 300000)).accepted, true);
  assert.equal(calls, 2);
});

test('collection failure denies and retries only after backoff', async () => {
  let calls = 0;
  const { sqlite, guard } = setup(async ({ now: at }) => { if (++calls === 1) throw Error('unavailable'); return snapshot(at); });
  assert.equal((await reserve(guard, 'a')).reason, 'invalid_evidence');
  assert.equal(sqlite.prepare('SELECT diagnostic_status FROM allowance_receipts').get().diagnostic_status, 'analytics_unavailable');
  assert.equal((await reserve(guard, 'b', now + 29999)).reason, 'invalid_evidence');
  assert.equal(calls, 1);
  assert.equal((await reserve(guard, 'c', now + 30000)).accepted, true);
  assert.equal(calls, 2);
});

test('persists only allowlisted failure codes without credentials or raw provider content', async () => {
  const { guard, sqlite } = setup(async () => { throw Error('subscriptions_http_403'); });
  await reserve(guard, 'a');
  assert.deepEqual(JSON.parse(sqlite.prepare('SELECT diagnostic_highwater_json FROM allowance_receipts').get().diagnostic_highwater_json), { failure: 'subscriptions_http_403', stage: 'collect_snapshot' });
  const raw = setup(async () => { throw Error('secret-token and raw provider data'); });
  await reserve(raw.guard, 'b');
  assert.deepEqual(JSON.parse(raw.sqlite.prepare('SELECT diagnostic_highwater_json FROM allowance_receipts').get().diagnostic_highwater_json), { failure: 'analytics_collection_failed', stage: 'collect_snapshot' });
  const invalid = setup(async () => { throw Error('invalid subscription response'); });
  await reserve(invalid.guard, 'c');
  assert.deepEqual(JSON.parse(invalid.sqlite.prepare('SELECT diagnostic_highwater_json FROM allowance_receipts').get().diagnostic_highwater_json), { failure: 'invalid_subscription_response', stage: 'collect_snapshot' });
  const malformed = setup(async () => { throw new SyntaxError('raw provider payload'); });
  await reserve(malformed.guard, 'd');
  assert.deepEqual(JSON.parse(malformed.sqlite.prepare('SELECT diagnostic_highwater_json FROM allowance_receipts').get().diagnostic_highwater_json), { failure: 'analytics_parse_error', stage: 'collect_snapshot' });
});

test('observed usage and reservations enforce limits', async () => {
  const { guard } = setup(async ({ now: at }) => snapshot(at, { requests: 9 }));
  assert.equal((await reserve(guard, 'a')).accepted, true);
  assert.equal((await reserve(guard, 'b')).reason, 'allowance_exhausted');
});

test('day and billing cycle rollover reset usage and preserve storage reservations', async () => {
  const end = now + 120000;
  const { guard } = setup(async ({ now: at }) => at < end ? snapshot(at, {}, now - 1000, end) : snapshot(at, {}, end, end + 86400000));
  assert.equal((await reserve(guard, 'a', now, { requests: 10, aiNeurons: 6000, d1StorageBytes: 9 })).accepted, true);
  const next = end;
  assert.equal((await reserve(guard, 'b', next, { requests: 10, aiNeurons: 6000, d1StorageBytes: 2 })).reason, 'allowance_exhausted');
  assert.equal((await reserve(guard, 'c', next, { requests: 10, aiNeurons: 6000, d1StorageBytes: 1 })).accepted, true);
});

test('interleaved refreshes retain cumulative high-water estimates', async () => {
  const pending = [];
  const { guard, sqlite } = setup(({ now: at }) => new Promise(resolve => pending.push(value => resolve(snapshot(at, { requests: value })) )));
  const first = reserve(guard, 'a');
  const second = reserve(guard, 'b');
  while (pending.length < 2) await new Promise(resolve => setImmediate(resolve));
  pending[0](8);
  await first;
  pending[1](3);
  await second;
  const stored = JSON.parse(sqlite.prepare('SELECT usage_json FROM allowance_receipts').get().usage_json);
  assert.equal(stored.requests, 8);
});
