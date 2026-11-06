import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicEgress, normalizePublicTarget } from './public-egress.mjs';
import { retrieve } from './retrieval.mjs';
import publicWorker from './public-worker.mjs';

test('public transport fixes outbound options and checks each redirected host and robots policy', async () => {
  const calls = [];
  const egress = createPublicEgress({ fetcher: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/robots.txt')) return new Response(null, { status: 404 });
    if (url === 'https://shop.example.com/a') return new Response(null, { status: 302, headers: { location: 'https://other.example.org/b' } });
    return new Response('<p>Product</p>', { headers: { 'content-type': 'text/html' } });
  } });
  assert.equal((await retrieve('https://shop.example.com/a', { egress })).url, 'https://other.example.org/b');
  assert.deepEqual(calls.map(call => call.url), ['https://shop.example.com/robots.txt', 'https://shop.example.com/a', 'https://other.example.org/robots.txt', 'https://other.example.org/b']);
  for (const { options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(options.headers, { 'user-agent': 'AEOAuditBot/1.0', accept: 'text/html,text/plain;q=0.9,application/xml;q=0.8,text/xml;q=0.8' });
    assert.ok(options.signal instanceof AbortSignal);
  }
  await egress.fetch('https://shop.example.com/', { method: 'GET', redirect: 'manual', headers: { cookie: 'secret', authorization: 'secret' }, credentials: 'include' });
  assert.equal(calls.at(-1).options.credentials, undefined);
  assert.equal(calls.at(-1).options.headers.cookie, undefined);
  assert.equal(calls.at(-1).options.headers.authorization, undefined);
});

test('rejects unsafe destinations before any request to them', async () => {
  for (const destination of ['http://127.1/', 'http://[::1]/', 'http://host.local/', 'http://service.internal/', 'http://host.test/', 'http://host.invalid/', 'http://host.example/', 'http://foo.home.arpa/', 'http://foo.alt/', 'https://user:pass@shop.example.com/']) {
    assert.throws(() => normalizePublicTarget(destination), { code: 'invalid_url' });
    const calls = [];
    const egress = createPublicEgress({ fetcher: async url => {
      calls.push(url);
      return url.endsWith('/robots.txt') ? new Response(null, { status: 404 }) : new Response(null, { status: 302, headers: { location: destination } });
    } });
    await assert.rejects(retrieve('https://shop.example.com/a', { egress }), { code: destination === 'http://host.example/' ? 'fetch_failed' : 'invalid_redirect' });
    assert.deepEqual(calls, ['https://shop.example.com/robots.txt', 'https://shop.example.com/a']);
  }
});

test('rejects a redirect with raw backslashes before URL resolution', async () => {
  const calls = [];
  const egress = createPublicEgress({ fetcher: async url => {
    calls.push(url);
    return url.endsWith('/robots.txt') ? new Response(null, { status: 404 }) :
      new Response(null, { status: 302, headers: { location: String.raw`/unsafe\path` } });
  } });
  await assert.rejects(retrieve('https://shop.example.com/a', { egress }), { code: 'invalid_redirect' });
  assert.deepEqual(calls, ['https://shop.example.com/robots.txt', 'https://shop.example.com/a']);
});

test('public submission rejects reserved example domains before database admission', async () => {
  const response = await publicWorker.fetch(new Request('https://api.example.com/api/v1/audits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://shop.example/item' }),
  }), {
    AUDIT_DB: { prepare: () => assert.fail('Reserved URL reached database') },
  }, { waitUntil: () => assert.fail('Reserved URL started an audit') });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_input');
});
