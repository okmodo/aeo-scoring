import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './public-worker.mjs';

const origin = 'https://aeo-scoring-preview-20261105-kk7.pages.dev';
const url = 'https://api.example.com/api/v1/audits';
const id = '123e4567-e89b-42d3-a456-426614174000';
const ctx = { waitUntil() {} };
const send = (path, init = {}, env = {}) => worker.fetch(new Request(url + path, init), env, ctx);

test('preflight permits only the preview origin, contract methods and Content-Type without storage', async () => {
  const env = { get AUDIT_DB() { throw new Error('storage accessed'); } };
  for (const [path, method, headers] of [['', 'POST', 'Content-Type'], ['/' + id, 'GET', '']]) {
    const response = await send(path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers } }, env);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-methods'), method);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal(response.headers.get('vary'), 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  }
  for (const headers of [
    { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    { Origin: origin + '.evil.example', 'Access-Control-Request-Method': 'POST' },
    { Origin: origin, 'Access-Control-Request-Method': 'GET' },
    { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization' },
  ]) {
    const response = await send('', { method: 'OPTIONS', headers }, env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(response.headers.get('vary'), /Access-Control-Request-Headers/);
  }
});

test('actual contract responses expose Retry-After only to the exact origin and preserve errors', async () => {
  for (const [path, init, status] of [
    ['', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }, 400],
    ['/' + id, { headers: { Origin: origin } }, 503],
  ]) {
    const response = await send(path, init);
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
