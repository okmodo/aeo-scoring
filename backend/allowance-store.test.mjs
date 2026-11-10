import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createTestAllowanceGuard } from './allowance-store.test-helper.mjs';
import { INCLUDED_CEILINGS } from './allowance-policy.mjs';

const now = Date.UTC(2026, 10, 10);
const zero = Object.fromEntries(Object.keys(INCLUDED_CEILINGS).map(k => [k, 0]));
const evidence = () => ({ verified: true, accountId: 'account', observedAt: now, cycleStart: now - 1000, cycleEnd: now + 1000000, aiDay: '2026-11-10', usage: { ...zero } });
function setup(e = evidence(), allocations = INCLUDED_CEILINGS) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) { return { bind(...args) {
    const stmt = sqlite.prepare(sql);
    return { run: async () => stmt.run(...args), first: async () => stmt.get(...args) ?? null };
  } }; } };
  return { db, sqlite, guard: createTestAllowanceGuard(db, { accountId: 'account', evidence: e, allocations }) };
}
const reserve = (guard, id, costs, at = now) => guard.reserve({ id, costs, now: at });

test('all metrics are reserved atomically, idempotently and without refunds', async () => {
  const { guard, sqlite } = setup();
  assert.deepEqual(await reserve(guard, 'one', { requests: 1, aiNeurons: 5999 }), { accepted: true, duplicate: false });
  assert.deepEqual(await reserve(guard, 'one', { aiNeurons: 5999, requests: 1 }), { accepted: true, duplicate: true });
  assert.equal((await reserve(guard, 'one', { requests: 2 })).reason, 'id_conflict');
  assert.equal((await reserve(guard, 'two', { requests: 10, aiNeurons: 2 })).reason, 'allowance_exhausted');
  assert.equal(sqlite.prepare('SELECT SUM(requests) AS n FROM allowance_reservations').get().n, 1);
  assert.equal((await reserve(guard, 'three', { aiNeurons: 1 })).accepted, true);
});

test('interleaved callers cannot exceed the allocation', async () => {
  const { guard } = setup(evidence(), { ...INCLUDED_CEILINGS, requests: 3 });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(guard, String(i), { requests: 1 })));
  assert.equal(results.filter(r => r.accepted).length, 3);
});

test('unverified, missing, stale and incomplete evidence deny admission', async () => {
  for (const e of [null, { ...evidence(), verified: false }, { ...evidence(), observedAt: now - 300001 }, { ...evidence(), accountId: 'other' }, { ...evidence(), usage: {} }, { ...evidence(), aiDay: '2026-11-09' }]) {
    assert.equal((await reserve(setup(e).guard, 'a', { requests: 1 })).reason, 'invalid_evidence');
  }
});

test('other usage counts, limits cannot change within a cycle, and bad amounts fail', async () => {
  const e = evidence(); e.usage.requests = 5_999_999;
  const { guard, db } = setup(e);
  assert.equal((await reserve(guard, 'a', { requests: 2 })).reason, 'allowance_exhausted');
  assert.equal((await reserve(guard, 'b', { requests: -1 })).reason, 'invalid_request');
  assert.equal((await reserve(guard, 'c', { unexpected: 1 })).reason, 'invalid_request');
  const changed = createTestAllowanceGuard(db, { accountId: 'account', evidence: e, allocations: { ...INCLUDED_CEILINGS, requests: 5 } });
  assert.equal((await reserve(changed, 'd', { requests: 1 })).reason, 'cycle_mismatch');
});

test('daily AI resets while storage reservations persist and overlapping cycles fail', async () => {
  const start = Date.UTC(2026, 10, 10, 23, 59);
  const e = { ...evidence(), observedAt: start, cycleStart: start - 1000, cycleEnd: start + 600000 };
  const { db, guard } = setup(e, { ...INCLUDED_CEILINGS, d1StorageBytes: 10 });
  assert.equal((await reserve(guard, 'a', { aiNeurons: 6000, d1StorageBytes: 9 }, start)).accepted, true);
  const tomorrow = start + 120000;
  const nextEvidence = { ...e, observedAt: tomorrow, aiDay: '2026-11-11' };
  const next = createTestAllowanceGuard(db, { accountId: 'account', evidence: nextEvidence, allocations: { ...INCLUDED_CEILINGS, d1StorageBytes: 10 } });
  assert.equal((await reserve(next, 'b', { aiNeurons: 6000, d1StorageBytes: 2 }, tomorrow)).reason, 'allowance_exhausted');
  assert.equal((await reserve(next, 'c', { aiNeurons: 6000 }, tomorrow)).accepted, true);
  const overlap = createTestAllowanceGuard(db, { accountId: 'account', evidence: { ...nextEvidence, cycleStart: start }, allocations: { ...INCLUDED_CEILINGS, d1StorageBytes: 10 } });
  assert.equal((await reserve(overlap, 'd', { requests: 1 }, tomorrow)).reason, 'cycle_mismatch');
});

test('storage reservations carry into a new billing cycle', async () => {
  const allocation = { ...INCLUDED_CEILINGS, d1StorageBytes: 10 };
  const { guard, db } = setup(evidence(), allocation);
  assert.equal((await reserve(guard, 'a', { d1StorageBytes: 9 })).accepted, true);
  const nextNow = now + 1000000;
  const nextEvidence = { ...evidence(), observedAt: nextNow, cycleStart: nextNow, cycleEnd: nextNow + 1000000 };
  const next = createTestAllowanceGuard(db, { accountId: 'account', evidence: nextEvidence, allocations: allocation });
  assert.equal((await reserve(next, 'b', { d1StorageBytes: 2 }, nextNow)).reason, 'allowance_exhausted');
});


async function contend(costs, allocations) {
  const dir = mkdtempSync(join(tmpdir(), 'allowance-contention-'));
  const path = join(dir, 'ledger.sqlite');
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const barrier = new SharedArrayBuffer(4);
  const workers = [];
  try {
    const pending = Array.from({ length: 20 }, (_, id) => {
      const worker = new Worker(new URL('./allowance-contention-worker.mjs', import.meta.url), {
        workerData: { path, barrier, id, evidence: evidence(), allocations, costs, now },
      });
      workers.push(worker);
      let ready;
      const started = new Promise((resolve, reject) => { ready = resolve; worker.once('error', reject); });
      const result = new Promise((resolve, reject) => {
        worker.on('message', message => {
          if (message.ready) ready();
          else if (message.error) reject(new Error(message.error));
          else resolve(message.result);
        });
        worker.once('error', reject);
        worker.once('exit', code => { if (code !== 0) reject(new Error(`Worker exited ${code}`)); });
      });
      return { started, result };
    });
    await Promise.all(pending.map(p => p.started));
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0, 20);
    const results = await Promise.all(pending.map(p => p.result));
    const rows = sqlite.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(ai_neurons), 0) AS ai FROM allowance_reservations').get();
    const totals = sqlite.prepare('SELECT requests, cpu_ms, d1_reads, d1_writes FROM allowance_totals WHERE account_id = ?').get('account');
    const daily = sqlite.prepare('SELECT ai_neurons FROM allowance_days WHERE account_id = ?').get('account');
    const storage = sqlite.prepare('SELECT d1_storage_bytes FROM allowance_storage WHERE account_id = ?').get('account');
    return { results, rows, totals, daily, storage };
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('separate SQLite connections enforce simultaneous multi-metric limits atomically', async () => {
  const requests = await contend({ requests: 1, cpuMs: 1, d1Reads: 1, d1Writes: 1, d1StorageBytes: 1, aiNeurons: 1 }, { ...INCLUDED_CEILINGS, requests: 3 });
  assert.equal(requests.results.filter(result => result.accepted).length, 3);
  assert.deepEqual({ ...requests.rows }, { n: 3, requests: 3, ai: 3 });
  assert.deepEqual({ ...requests.totals }, { requests: 3, cpu_ms: 3, d1_reads: 3, d1_writes: 3 });
  assert.equal(requests.storage.d1_storage_bytes, 3);
  assert.equal(requests.daily.ai_neurons, 3);

  const ai = await contend({ requests: 2, aiNeurons: 2 }, { ...INCLUDED_CEILINGS, requests: 100, aiNeurons: 6 });
  assert.equal(ai.results.filter(result => result.accepted).length, 3);
  assert.deepEqual({ ...ai.rows }, { n: 3, requests: 6, ai: 6 });
  assert.equal(ai.totals.requests, 6);
  assert.equal(ai.daily.ai_neurons, 6);
});
