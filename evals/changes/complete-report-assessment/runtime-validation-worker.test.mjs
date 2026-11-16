import test from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual, createHash } from 'node:crypto';
import { createValidationHandler } from './runtime-validation-worker.mjs';
if (!crypto.subtle.timingSafeEqual) crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const approvedHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const secret = 'a'.repeat(40), target = 'https://kokatat.com/naiad-pfd-lvhnai';
const make = (body = { url: target }, token = secret, path = '/api/v1/audits') => new Request(`https://example.com${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify(body) });

test('authentication, method, route, and exact target are enforced before service work', async () => {
  let calls = 0;
  const worker = createValidationHandler({ handle: () => { calls++; }, egress: () => ({}) });
  const env = { AUDIT_VALIDATION_SECRET: secret };
  assert.equal((await worker(make(undefined, 'wrong'), env)).status, 401);
  assert.equal((await worker(make(), { AUDIT_VALIDATION_SECRET: 'short' })).status, 401);
  assert.equal((await worker(make({ url: target + '?nonce=1' }), env)).status, 400);
  assert.equal((await worker(make({ url: target, extra: true }), env)).status, 400);
  assert.equal((await worker(make(undefined, secret, '/other'), env)).status, 404);
  assert.equal((await worker(new Request('https://example.com/api/v1/audits'), env)).status, 404);
  assert.equal(calls, 0);
});

test('captures only the admitted request retrieval and model calls and awaits background work', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let polls = 0;
  const handle = async (request, env, ctx, options) => {
    if (request.method === 'GET') { polls++; return Response.json({ status: 'complete' }); }
    assert.equal(request.headers.has('authorization'), false);
    assert.equal(options.allowsProduct(target), true);
    assert.equal(options.allowsProduct(target + '?x=1'), false);
    ctx.waitUntil((async () => {
      await options.retrievePage(target, {});
      await env.AUDIT_AI.run('model', { input: 'actual' });
    })());
    return Response.json({ statusUrl: `/api/v1/audits/${id}` }, { status: 202 });
  };
  const worker = createValidationHandler({ handle, claim: async () => true, preflight: () => ({ input: 'actual' }), egress: () => ({}), retrievePage: async (_url, options) => ({ url: target, guides: options.observeGuides, sitemap: options.observeSitemap }) });
  const response = await worker(make(), { AUDIT_VALIDATION_SECRET: secret, AUDIT_VALIDATION_REQUEST_SHA256: approvedHash({ input: 'actual' }), AUDIT_AI: { run: async () => ({ result: 'output' }) } });
  const proof = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(polls, 1);
  assert.equal(proof.validation.snapshot.guides, true);
  assert.deepEqual(proof.validation.modelCalls, [{ model: 'model', input: { input: 'actual' }, output: { result: 'output' }, invoked: true, inputHash: approvedHash({ input: 'actual' }) }]);
  assert.equal(proof.assessment.status, 'complete');
});

test('admission failure does not poll, retrieve, or call a model', async () => {
  let polls = 0, calls = 0;
  const worker = createValidationHandler({ claim: async () => true, egress: () => ({}), retrievePage: () => { calls++; }, handle: async request => {
    if (request.method === 'GET') polls++;
    return Response.json({ error: 'unavailable' }, { status: 503 });
  } });
  const response = await worker(make(), { AUDIT_VALIDATION_SECRET: secret, AUDIT_AI: { run: () => { calls++; } } });
  const proof = await response.json();
  assert.equal(response.status, 503);
  assert.equal(polls, 0);
  assert.equal(calls, 0);
  assert.deepEqual(proof.validation, { snapshot: null, preflight: null, modelCalls: [] });
});


test('claims only after authentication and target validation and denies a repeated run', async () => {
  let claims = 0, calls = 0;
  const worker = createValidationHandler({ egress: () => ({}), claim: async () => ++claims === 1, handle: async () => { calls++; return Response.json({ error: 'unavailable' }, { status: 503 }); } });
  const env = { AUDIT_VALIDATION_SECRET: secret };
  assert.equal((await worker(make(undefined, 'bad'), env)).status, 401);
  assert.equal((await worker(make({ url: target + '?x=1' }), env)).status, 400);
  assert.equal(claims, 0);
  assert.equal((await worker(make(), env)).status, 503);
  assert.equal((await worker(make(), env)).status, 429);
  assert.equal(claims, 2);
  assert.equal(calls, 1);
});

test('missing durable claim configuration fails closed', async () => {
  let calls = 0;
  const worker = createValidationHandler({ egress: () => ({}), handle: () => { calls++; } });
  assert.equal((await worker(make(), { AUDIT_VALIDATION_SECRET: secret })).status, 429);
  assert.equal(calls, 0);
});

test('default claim uses the durable ledger and cannot be reused after failure', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const { createTestAllowanceGuard } = await import('../../../backend/allowance-store.test-helper.mjs');
  const { METRICS } = await import('../../../backend/allowance-policy.mjs');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../../backend/schema.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) { return { bind(...args) { const stmt = sqlite.prepare(sql); return { run: async () => stmt.run(...args), first: async () => stmt.get(...args) ?? null }; } }; } };
  const now = Date.now(), usage = Object.fromEntries(METRICS.map(key => [key, 0]));
  const evidence = { verified: true, accountId: 'account', observedAt: now, cycleStart: now - 1000, cycleEnd: now + 3600000, aiDay: new Date(now).toISOString().slice(0, 10), usage };
  await createTestAllowanceGuard(db, { accountId: 'account', evidence }).reserve({ id: 'seed', costs: { requests: 1 }, now });
  let calls = 0;
  const worker = createValidationHandler({ egress: () => ({}), handle: async () => { calls++; return Response.json({ error: 'unavailable' }, { status: 503 }); } });
  const env = { AUDIT_VALIDATION_SECRET: secret, AUDIT_VALIDATION_RUN_ID: 'fixed_run_id_123456', AUDIT_DB: db, AUDIT_BILLING_ACCOUNT_ID: 'account', AUDIT_BILLING_SUBSCRIPTION_ID: 'fixture-subscription' };
  assert.equal((await worker(make(), env)).status, 503);
  assert.equal((await worker(make(), env)).status, 429);
  assert.equal(calls, 1);
  const row = sqlite.prepare('SELECT requests, cpu_ms, d1_reads, d1_writes, d1_storage_bytes, ai_neurons FROM allowance_reservations WHERE id = ?').get('fixed_run_id_123456:once');
  assert.deepEqual({ ...row }, { requests: 1, cpu_ms: 2000, d1_reads: 10000, d1_writes: 10, d1_storage_bytes: 4096, ai_neurons: 0 });
  sqlite.close();
});


test('changed or missing approved input hash blocks the provider and captures evidence', async () => {
  for (const approved of [undefined, 'f'.repeat(64)]) {
    let providerCalls = 0;
    const handle = async (request, env, ctx) => {
      if (request.method === 'GET') return Response.json({ status: 'incomplete' });
      ctx.waitUntil(env.AUDIT_AI.run('model', { input: 'changed' }).catch(() => {}));
      return Response.json({ statusUrl: '/api/v1/audits/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, { status: 202 });
    };
    const worker = createValidationHandler({ handle, claim: async () => true, egress: () => ({}) });
    const response = await worker(make(), { AUDIT_VALIDATION_SECRET: secret, AUDIT_VALIDATION_REQUEST_SHA256: approved, AUDIT_AI: { run: async () => { providerCalls++; } } });
    const { validation } = await response.json();
    assert.equal(providerCalls, 0);
    assert.deepEqual(validation.modelCalls, [{ model: 'model', input: { input: 'changed' }, output: null, invoked: false, inputHash: approvedHash({ input: 'changed' }), error: 'Pre-reviewed model input changed' }]);
  }
});


test('preflight mismatch stops the service before AI reservation or provider invocation', async () => {
  let reservations = 0, providerCalls = 0;
  const handle = async (request, env, ctx, options) => {
    if (request.method === 'GET') return Response.json({ status: 'unable_to_assess' });
    ctx.waitUntil((async () => {
      try { await options.retrievePage(target, {}); } catch { return; }
      reservations++;
      await env.AUDIT_AI.run('model', { input: 'changed' });
    })());
    return Response.json({ statusUrl: '/api/v1/audits/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, { status: 202 });
  };
  const worker = createValidationHandler({ handle, claim: async () => true, egress: () => ({}), retrievePage: async () => ({ extracted: {} }), preflight: () => ({ input: 'changed' }) });
  const response = await worker(make(), { AUDIT_VALIDATION_SECRET: secret, AUDIT_VALIDATION_REQUEST_SHA256: approvedHash({ input: 'reviewed' }), AUDIT_AI: { run: async () => { providerCalls++; } } });
  const proof = await response.json();
  assert.equal(reservations, 0);
  assert.equal(providerCalls, 0);
  assert.deepEqual(proof.validation.preflight, { input: { input: 'changed' }, inputHash: approvedHash({ input: 'changed' }), approved: false });
  assert.deepEqual(proof.validation.modelCalls, []);
});
