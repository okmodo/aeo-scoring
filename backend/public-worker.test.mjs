import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './public-worker.mjs';
import { INCLUDED_CEILINGS, METRICS } from './allowance-policy.mjs';

const origin = 'https://aeo-scoring-preview-20261105-kk7.pages.dev';
const url = 'https://api.example.com/api/v1/audits';
const id = '123e4567-e89b-42d3-a456-426614174000';
const password = 'test-preview-password';
const accessUrl = 'https://api.example.com/api/v1/preview-access';
const authorized = { Authorization: 'Bearer ' + password };
const configured = { AUDIT_PREVIEW_PASSWORD: password };

test('explicit public mode admits requests without the preview password', async () => {
  const env = { AUDIT_PUBLIC_ACCESS: 'enabled' };
  const unlock = await worker.fetch(new Request('https://worker.example/api/v1/preview-access', { method: 'POST' }), env, {});
  assert.equal(unlock.status, 204);
  const response = await send('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_input');
});
const ctx = { waitUntil() {} };
const send = (path, init = {}, env = {}) => worker.fetch(new Request(url + path, init), env, ctx);

test('authenticated submissions and report reads require current allowance evidence for the pinned billing scope', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const previousRewriter = globalThis.HTMLRewriter;
  globalThis.HTMLRewriter = class {};
  try {
    sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    let auditAdmissions = 0;
    const db = {
      prepare(sql) { return { bind(...args) { const stmt = sqlite.prepare(sql); return {
        first: async () => stmt.get(...args) ?? null, run: async () => stmt.run(...args),
      }; } }; },
      async batch() { auditAdmissions++; assert.fail('Denied submission reached audit persistence'); },
    };
    const accountId = '0123456789abcdef0123456789abcdef';
    const subscriptionId = 'fixture-subscription';
    const now = Date.now();
    const env = { ...configured, AUDIT_DB: db, AUDIT_RATE_SECRET: 'x'.repeat(32), AUDIT_BILLING_ACCOUNT_ID: accountId, AUDIT_BILLING_SUBSCRIPTION_ID: subscriptionId };
    const poll = scope => send('/' + id, { headers: authorized }, scope);
    const submit = scope => send('', {
      method: 'POST',
      headers: { ...authorized, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
      body: JSON.stringify({ url: 'https://example.com/product' }),
    }, scope);
    const expectDenied = async (scope, status) => {
      assert.equal((await submit(scope)).status, status);
      assert.equal((await poll(scope)).status, status);
      assert.equal(auditAdmissions, 0);
    };
    const usage = Object.fromEntries(METRICS.map(key => [key, 0]));
    const seedReceipt = (sub, observedAt, amounts) => {
      const watermarks = Object.fromEntries(METRICS.map(key => [key, observedAt]));
      sqlite.prepare(`INSERT OR REPLACE INTO allowance_receipts
        (account_id, subscription_id, generation, active, cycle_start, cycle_end, ai_day, observed_at, usage_json, watermarks_json)
        VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`)
        .run(accountId, sub, now - 60_000, now + 60_000, new Date(now).toISOString().slice(0,10), observedAt, JSON.stringify(amounts), JSON.stringify(watermarks));
    };
    sqlite.prepare('INSERT INTO audits (id,url,cache_key,status,created_at,expires_at) VALUES (?,?,?,?,?,?)')
      .run(id, 'https://example.com/product', 'fixture', 'pending', now, now + 60_000);
    await expectDenied(env, 503);
    seedReceipt('other-subscription', now, usage);
    await expectDenied(env, 503);
    seedReceipt(subscriptionId, now - 300_001, usage);
    await expectDenied(env, 503);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM allowance_reservations').get().total, 0);
    seedReceipt(subscriptionId, now, usage);
    await expectDenied({ ...env, AUDIT_BILLING_SUBSCRIPTION_ID: undefined }, 503);
    const response = await poll(env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'pending');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM allowance_reservations').get().total, 1);
    seedReceipt(subscriptionId, now, { ...usage, requests: INCLUDED_CEILINGS.requests });
    await expectDenied(env, 429);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM allowance_reservations').get().total, 1);
  } finally {
    if (previousRewriter === undefined) delete globalThis.HTMLRewriter;
    else globalThis.HTMLRewriter = previousRewriter;
    sqlite.close();
  }
});

test('preflight permits only the preview origin, contract methods and allowed headers without storage', async () => {
  const env = { get AUDIT_DB() { throw new Error('storage accessed'); } };
  for (const [path, method, headers] of [['', 'POST', 'Content-Type, Authorization'], ['/' + id, 'GET', 'Authorization']]) {
    const response = await send(path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers } }, env);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-methods'), method);
    assert.match(response.headers.get('access-control-allow-headers'), /Authorization/);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal(response.headers.get('vary'), 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  }
  for (const headers of [
    { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    { Origin: origin + '.evil.example', 'Access-Control-Request-Method': 'POST' },
    { Origin: origin, 'Access-Control-Request-Method': 'GET' },
    { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-unexpected' },
  ]) {
    const response = await send('', { method: 'OPTIONS', headers }, env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(response.headers.get('vary'), /Access-Control-Request-Headers/);
  }
});

test('actual contract responses expose Retry-After only to the exact origin and preserve errors', async () => {
  for (const [path, init, status] of [
    ['', { method: 'POST', headers: { ...authorized, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }, 400],
    ['/' + id, { headers: { ...authorized, Origin: origin } }, 503],
  ]) {
    const response = await send(path, init, configured);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.match(response.headers.get('vary'), /Origin/);
  }
  for (const init of [{ headers: { Origin: 'null' } }, {}, { method: 'POST', headers: { Origin: origin } }]) {
    const response = await send('/' + id, init);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(response.headers.get('vary'), /Origin/);
  }
  const unrelated = await send('/' + id + '/extra', { headers: { Origin: origin } });
  assert.equal(unrelated.headers.get('access-control-allow-origin'), null);
  const nonBrowser = await send('', { method: 'OPTIONS' });
  assert.equal(nonBrowser.status, 405);
  assert.equal(nonBrowser.headers.get('allow'), 'POST');
});

test('unlock verifies the shared password without touching audit storage or allowances', async () => {
  const env = {
    ...configured,
    get AUDIT_DB() { assert.fail('Unlock accessed audit storage'); },
  };
  const request = (method, headers) => worker.fetch(new Request(accessUrl, { method, headers }), env, ctx);
  const preflight = await request('OPTIONS', { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  for (const authorization of [undefined, 'Bearer incorrect-password', 'Basic ' + password]) {
    const response = await request('POST', { Origin: origin, ...(authorization && { Authorization: authorization }) });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const unlocked = await request('POST', { ...authorized, Origin: origin });
  assert.equal(unlocked.status, 204);
  assert.equal(await unlocked.text(), '');
  assert.equal(unlocked.headers.get('cache-control'), 'no-store');
});

test('direct submissions and report reads fail closed before audit storage', async () => {
  for (const [path, method] of [['', 'POST'], ['/' + id, 'GET']]) {
    for (const [secret, headers, expectedStatus] of [
      [password, {}, 401],
      [password, { Authorization: 'Bearer incorrect-password' }, 401],
      [undefined, authorized, 503],
      ['weak', authorized, 503],
    ]) {
      const env = {
        AUDIT_PREVIEW_PASSWORD: secret,
        get AUDIT_DB() { assert.fail('Unauthorized request accessed audit storage'); },
      };
      const response = await send(path, { method, headers }, env);
      assert.equal(response.status, expectedStatus);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
});

test('shared access accepts shorter configured credentials while rejecting invalid boundaries', async () => {
  const unlock = (secret, provided) => worker.fetch(new Request(accessUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + provided },
  }), {
    AUDIT_PREVIEW_PASSWORD: secret,
    get AUDIT_DB() { assert.fail('Password verification accessed audit storage'); },
  }, ctx);
  for (const length of [8, 10, 128]) {
    const secret = 'x'.repeat(length);
    assert.equal((await unlock(secret, secret)).status, 204);
    assert.equal((await unlock(secret, 'incorrect')).status, 401);
  }
  for (const secret of ['', 'x'.repeat(7), 'x'.repeat(129), 'invalid password']) {
    assert.equal((await unlock(secret, secret)).status, 503);
  }
});
