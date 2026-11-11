import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createSyntheticHandler } from './synthetic-worker.mjs';
if (!crypto.subtle.timingSafeEqual) crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ids = ['running-shoes', 'casual-daypacks', 'personal-flotation-devices', 'handbags', 'basic-tshirts'];
const input = { sample: 'reviewed' }, requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
const cases = async () => ids.map(id => ({ id, snapshot: {}, extracted: {}, report: {}, requestHash }));
const secret = 'a'.repeat(40);
const env = { AUDIT_VALIDATION_SECRET: secret, RUN_ID: 'run_id_1234567890', AUDIT_DB: {}, AUDIT_AI: { run: async () => ({ result: true }) } };
const req = (id, token = secret, body) => new Request(`https://example.test/validate/${id}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });
const factory = (run, extra = {}) => {
  let claims = 0, settlements = 0, calls = 0;
  const worker = createSyntheticHandler({ cases, prepare: () => input, guard: () => ({ reserve: async () => ({ accepted: true, duplicate: claims++ > 0 }), settle: async () => { settlements++; return { accepted: true }; } }), run, ...extra });
  return { worker, counts: () => ({ claims, settlements, calls }), env: { ...env, AUDIT_AI: { run: async () => { calls++; return { result: true }; } } } };
};

test('rejects unknown routes, bad authentication and request bodies before admission', async () => {
  const f = factory(() => { throw new Error(); });
  assert.equal((await f.worker(req('other'), f.env)).status, 404);
  assert.equal((await f.worker(req(ids[0], 'bad'), f.env)).status, 401);
  assert.equal((await f.worker(req(ids[0], secret, '{}'), f.env)).status, 400);
  assert.equal(f.counts().claims, 0);
});

test('enforces one physical call for non-shirt cases and durable one-shot claim', async () => {
  const f = factory(async ({ AI, calibrationApproved }) => {
    assert.equal(calibrationApproved, true);
    await AI.run('model', input);
    await AI.run('model', input).catch(() => {});
    return { status: 'assessed', facts: {} };
  }, { grade: () => 'grade', score: () => 'score' });
  const response = await f.worker(req(ids[0]), f.env), result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.modelCalls[1].invoked, false);
  assert.equal(result.grade, 'grade'); assert.equal(result.score, 'score');
  assert.equal((await f.worker(req(ids[0]), f.env)).status, 429);
  assert.deepEqual(f.counts(), { claims: 2, settlements: 1, calls: 1 });
});

test('shirt permits two calls, but primary hash mismatch never reaches provider', async () => {
  const f = factory(async ({ AI }) => { await AI.run('model', input); await AI.run('model', { followup: true }); await AI.run('model', {}).catch(() => {}); return { status: 'assessed' }; });
  const result = await (await f.worker(req('basic-tshirts'), f.env)).json();
  assert.equal(f.counts().calls, 2); assert.equal(result.modelCalls[2].invoked, false);
  const bad = factory(async ({ AI }) => { await AI.run('model', { changed: true }).catch(() => {}); return { status: 'unavailable' }; });
  await bad.worker(req(ids[0]), bad.env);
  assert.equal(bad.counts().calls, 0);
});

test('an unresolved provider call retains the infrastructure hold', async () => {
  const f = factory(async ({ AI }) => { AI.run('model', input); await new Promise(resolve => setTimeout(resolve, 5)); return { status: 'unavailable' }; });
  f.env.AUDIT_AI.run = () => new Promise(() => {});
  const response = await f.worker(req(ids[0]), f.env);
  assert.equal(response.status, 503);
  assert.equal(f.counts().settlements, 0);
});
