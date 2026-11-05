import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, snapshot } from './worker.mjs';

const req = path => new Request(`https://example.invalid/${path}`, { method: 'POST' });
test('fixed snapshots have exact bounded ASCII sizes', () => {
  for (const [size, bytes] of [['small', 2048], ['medium', 131072], ['large', 1048576]]) {
    assert.equal(new TextEncoder().encode(snapshot(size)).length, bytes);
  }
});
test('handler fails closed without independently provided admission', async () => {
  assert.equal((await handle(req('small'), {})).status, 503);
  assert.equal((await handle(req('small'), { BENCH_ADMISSION: { fetch: async () => new Response(null, { status: 403 }) } })).status, 503);
  assert.equal((await handle(req('small'), { BENCH_ADMISSION: { fetch: async () => { throw Error('unavailable'); } } })).status, 503);
});
test('only built-in POST workloads reach admission and error input is rejected', async () => {
  let attempts = 0;
  const env = { BENCH_ADMISSION: { fetch: async () => { attempts++; return new Response(null, { status: 204 }); } } };
  assert.equal((await handle(req('small?url=https://example.com'), env)).status, 404);
  assert.equal((await handle(new Request('https://example.invalid/small'), env)).status, 404);
  assert.equal((await handle(new Request('https://example.invalid/small', { method: 'POST', body: 'html' }), env)).status, 404);
  assert.equal(attempts, 0);
  const good = await handle(req('small'), env);
  assert.equal(good.status, 200);
  assert.equal((await good.json()).bytes, 2048);
  const error = await handle(req('error'), env);
  assert.deepEqual(await error.json(), { workload: 'error', rejected: true });
  assert.equal(attempts, 2);
});
