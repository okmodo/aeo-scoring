import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageReconciler, evaluateUsageTransition } from './usage-reconciliation.mjs';
import { createAllowanceGuard } from './allowance-store.mjs';
import { METRICS } from './allowance-policy.mjs';

// Synthetic protocol fixtures; they do not claim any provider supplies watermarks.
const now = Date.UTC(2026, 10, 10, 12), start = now - 1000000, day = Date.UTC(2026, 10, 10);
const receipt = (t = now) => ({ accountId: 'a', subscriptionId: 's', observedAt: t, cycleStart: start, cycleEnd: now + 10000000, aiDay: '2026-11-10',
  usage: Object.fromEntries(METRICS.map(k => [k, 10])),
  metrics: Object.fromEntries(METRICS.map(k => [k, { coverage: { start: k === 'aiNeurons' ? day : k === 'd1StorageBytes' ? null : start, end: t }, watermark: t }])) });
function wrap(sqlite) { return { prepare(sql) { return { bind(...args) { const stmt = sqlite.prepare(sql); return { run: async () => stmt.run(...args), first: async () => stmt.get(...args) ?? null }; } }; } }; }
function setup() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const db = wrap(sqlite);
  return { sqlite, db, rec: createUsageReconciler(db, { accountId: 'a', subscriptionId: 's' }), guard: createAllowanceGuard(db, { accountId: 'a', subscriptionId: 's', evidence: { ...receipt(), verified: true } }) };
}
const reserve = (guard, id, t = now) => guard.reserve({ id, costs: { requests: 1 }, now: t });
const finish = async (rec, r, t = now) => rec.finish(await rec.begin(), r, t);

test('production reconciles complete synthetic protocol while refusing authority', async () => {
  const { rec, guard, sqlite } = setup();
  assert.equal((await reserve(guard, 'before')).accepted, false);
  assert.deepEqual(await finish(rec, { ...receipt(), verified: true }), { accepted: false, reason: 'complete_untrusted' });
  assert.equal((await reserve(guard, 'after')).accepted, false);
  const state = sqlite.prepare('SELECT active, baseline_json FROM allowance_receipts').get();
  assert.equal(state.active, 0); assert.equal(JSON.parse(state.baseline_json).usage.requests, 10);
});

test('persistent transitions reject replay, decreases, period shifts, wrong identities and incomplete source watermarks', async () => {
  const changes = [
    [r => Object.assign(r, receipt()), 'replay_or_out_of_order'],
    [r => { r.usage.requests = 9; return r; }, 'cumulative_decrease'],
    [r => { r.usage.aiNeurons = 9; return r; }, 'daily_decrease'],
    [r => { r.cycleEnd++; return r; }, 'cycle_mismatch'],
    [r => { r.subscriptionId = 'other'; return r; }, 'identity_mismatch'],
    [r => { r.aiDay = '2026-11-09'; return r; }, 'invalid_period_or_usage'],
    [r => { r.metrics.requests.watermark -= 300001; return r; }, 'incomplete_watermark'],
  ];
  for (const [mutate, reason] of changes) {
    const { rec, sqlite } = setup(); await finish(rec, receipt());
    assert.equal((await finish(rec, mutate(receipt(now + 1000)), now + 1000)).reason, reason);
    assert.equal(JSON.parse(sqlite.prepare('SELECT baseline_json FROM allowance_receipts').get().baseline_json).usage.requests, 10);
  }
});

test('storage high water survives legitimate decreases; partial observations never imply a cumulative decrease', async () => {
  const { rec, sqlite } = setup(); await finish(rec, receipt());
  const later = receipt(now + 1000); later.usage.d1StorageBytes = 1;
  assert.equal((await finish(rec, later, now + 1000)).reason, 'complete_untrusted');
  const partial = { status: 'blocked', accountId: 'a', subscriptionId: 's', metrics: { requests: { observedQuantity: 2 } } };
  assert.equal((await finish(rec, partial, now + 2000)).reason, 'partial');
  const state = sqlite.prepare('SELECT baseline_json, diagnostic_highwater_json FROM allowance_receipts').get();
  assert.equal(JSON.parse(state.baseline_json).usage.d1StorageBytes, 10);
  assert.deepEqual(JSON.parse(state.diagnostic_highwater_json), { requests: 2 });
});

test('rollovers require adjacent cycle and day; stock carries across both', () => {
  const previous = evaluateUsageTransition(null, receipt(), { accountId: 'a', subscriptionId: 's', now }).baseline;
  const t = previous.cycleEnd, r = receipt(t); r.cycleStart = t; r.cycleEnd = t + 10000000;
  for (const key of ['requests', 'cpuMs', 'd1Reads', 'd1Writes']) { r.metrics[key].coverage.start = t; r.usage[key] = 0; }
  r.usage.d1StorageBytes = 0;
  const result = evaluateUsageTransition(previous, r, { accountId: 'a', subscriptionId: 's', now: t });
  assert.equal(result.status, 'complete_untrusted'); assert.equal(result.baseline.usage.d1StorageBytes, 10);
  r.cycleStart++; assert.equal(evaluateUsageTransition(previous, r, { accountId: 'a', subscriptionId: 's', now: t + 1 }).status, 'incomplete_watermark');
});

test('actual collection invalidates synthetic active baseline and partial billing stays blocked', async () => {
  const { collectUsage } = await import('./usage-collector.mjs');
  const accountId = '0123456789abcdef0123456789abcdef';
  const { sqlite, db } = setup();
  sqlite.prepare('INSERT INTO allowance_receipts (account_id, generation, active) VALUES (?, 1, 1)').run(accountId);
  const rec = createUsageReconciler(db, { accountId, subscriptionId: 's' });
  const generation = await rec.begin();
  const response = result => new Response(JSON.stringify({ success: true, errors: [], result }));
  const observed = await collectUsage({ accountId, subscriptionId: 's', token: 'test', now,
    fetch: async url => response(url.endsWith('/subscriptions') ? [{ id: 's', current_period_start: '2026-11-01T00:00:00Z', current_period_end: '2026-12-01T00:00:00Z' }] : url.endsWith('/info') ? { covered: true, subscriptions: [{ id: 's' }] } : []) });
  assert.equal((await rec.finish(generation, observed, now)).reason, 'partial');
  assert.equal((await reserve(createAllowanceGuard(db, { accountId, subscriptionId: 's' }), 'denied')).accepted, false);
  assert.equal(sqlite.prepare('SELECT active FROM allowance_receipts WHERE account_id = ?').get(accountId).active, 0);
});

test('separate SQLite connections serialize collection generations and one finish per generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-')), path = join(dir, 'ledger.sqlite');
  const one = new DatabaseSync(path), two = new DatabaseSync(path);
  try {
    one.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    const a = createUsageReconciler(wrap(one), { accountId: 'a', subscriptionId: 's' });
    const b = createUsageReconciler(wrap(two), { accountId: 'a', subscriptionId: 's' });
    const old = await a.begin(), newest = await b.begin();
    assert.equal((await a.finish(old, receipt(), now)).reason, 'superseded');
    const results = await Promise.all([a.finish(newest, receipt(), now), b.finish(newest, receipt(), now)]);
    assert.deepEqual(results.map(r => r.reason).sort(), ['complete_untrusted', 'superseded']);
    assert.equal(two.prepare('SELECT generation FROM allowance_receipts').get().generation, newest);
  } finally { one.close(); two.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('guard requires the pinned subscription and ignores direct verified evidence', async () => {
  const { sqlite, db } = setup();
  const r = receipt();
  sqlite.prepare(`INSERT INTO allowance_receipts
    (account_id, generation, active, subscription_id, cycle_start, cycle_end, ai_day, observed_at, usage_json, watermarks_json)
    VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`)
    .run('a', 's', r.cycleStart, r.cycleEnd, r.aiDay, r.observedAt, JSON.stringify(r.usage), JSON.stringify(Object.fromEntries(METRICS.map(k => [k, now]))));
  assert.equal((await reserve(createAllowanceGuard(db, { accountId: 'a', subscriptionId: 's' }), 'match')).accepted, true);
  assert.equal((await reserve(createAllowanceGuard(db, { accountId: 'a', subscriptionId: 'other', evidence: { ...r, verified: true } }), 'wrong')).reason, 'invalid_evidence');
  assert.equal((await reserve(createAllowanceGuard(db, { accountId: 'a', evidence: { ...r, verified: true } }), 'missing')).reason, 'invalid_request');
});
