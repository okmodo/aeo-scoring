import test from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { handle, snapshot } from './worker.mjs';

crypto.subtle.timingSafeEqual = timingSafeEqual;
const token = 'a'.repeat(64);
const req = (path, auth = token) => new Request(`https://example.invalid/${path}`, { method: 'POST', headers: { authorization: `Bearer ${auth}` } });
function database({ remaining = 30, expired = false, fail = false } = {}) {
  return { get remaining() { return remaining; }, prepare(sql) {
    assert.match(sql, /UPDATE budget SET remaining = remaining - 1 WHERE id = 1 AND remaining > 0 AND expires_at > unixepoch\(\) RETURNING remaining/);
    return { async first() { if (fail) throw Error('unavailable'); if (expired || remaining <= 0) return null; return { remaining: --remaining }; } };
  } };
}
test('fixed snapshots have exact bounded ASCII sizes', () => {
  for (const [size, bytes] of [['small', 2048], ['medium', 131072], ['large', 1048576]]) assert.equal(new TextEncoder().encode(snapshot(size)).length, bytes);
});
test('admission fails closed on missing, invalid, expired and failing configuration', async () => {
  assert.equal((await handle(req('small'), {})).status, 503);
  const db = database();
  assert.equal((await handle(req('small', 'b'.repeat(64)), { BENCH_DB: db, BENCH_TOKEN: token })).status, 503);
  assert.equal(db.remaining, 30);
  for (const options of [{ expired: true }, { fail: true }]) assert.equal((await handle(req('small'), { BENCH_DB: database(options), BENCH_TOKEN: token })).status, 503);
});
test('only built-in POST workloads reach database', async () => {
  const db = database(), env = { BENCH_DB: db, BENCH_TOKEN: token };
  assert.equal((await handle(req('small?url=https://example.com'), env)).status, 404);
  assert.equal((await handle(new Request('https://example.invalid/small'), env)).status, 404);
  assert.equal((await handle(new Request('https://example.invalid/small', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'html' }), env)).status, 404);
  assert.equal(db.remaining, 30);
  const error = await handle(req('error'), env);
  assert.deepEqual(await error.json(), { workload: 'error', rejected: true });
});
test('30 admitted requests consume permits and all later requests fail closed', async () => {
  const db = database(), env = { BENCH_DB: db, BENCH_TOKEN: token };
  const responses = await Promise.all(Array.from({ length: 35 }, () => handle(req('small'), env)));
  assert.equal(responses.filter(response => response.status === 200).length, 30);
  assert.equal(responses.filter(response => response.status === 503).length, 5);
  assert.equal(db.remaining, 0);
});


test('bodyless runtime stream is accepted, nonempty streams fail before admission', async () => {
  const db = database(), env = { BENCH_DB: db, BENCH_TOKEN: token };
  const empty = new ReadableStream({ start(controller) { controller.close(); } });
  const emptyRequest = new Request('https://example.invalid/small', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: empty, duplex: 'half' });
  assert.equal((await handle(emptyRequest, env)).status, 200);
  assert.equal(db.remaining, 29);
  let cancelled = false;
  const nonempty = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } });
  const bodyRequest = new Request('https://example.invalid/small', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: nonempty, duplex: 'half' });
  assert.equal((await handle(bodyRequest, env)).status, 404);
  assert.equal(cancelled, true);
  assert.equal(db.remaining, 29);
});
