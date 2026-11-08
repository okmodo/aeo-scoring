import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewEgress } from './preview-egress.mjs';
import { retrieve } from './retrieval.mjs';
import preview from './preview-worker.mjs';

const product = 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html';
const robots = 'https://books.toscrape.com/robots.txt';
const opts = { method: 'GET', redirect: 'manual' };

test('only exact approved product and robots requests reach fetch with fixed options', async () => {
  const calls = [];
  const egress = createPreviewEgress({ productUrls: [product], fetcher: (url, options) => { calls.push({ url, options }); return new Response('ok'); } });
  const controller = new AbortController();
  await egress.fetch(product, { ...opts, signal: controller.signal, headers: { authorization: 'secret', cookie: 'secret' } });
  await egress.fetch(robots, opts);
  for (const input of [product + '?x=1', product + '#x', product.replace('https:', 'http:'), product.replace('books.', 'evil.'), 'https://books.toscrape.com/', 'https://127.0.0.1/']) {
    assert.throws(() => egress.fetch(input, opts), { code: 'preview_denied' });
  }
  assert.throws(() => egress.fetch(product, { method: 'POST', redirect: 'manual' }), { code: 'preview_denied' });
  assert.throws(() => egress.fetch(product, { method: 'GET', redirect: 'follow' }), { code: 'preview_denied' });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(calls[0].options.headers).sort(), ['accept', 'user-agent']);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('invalid operator configuration fails closed', () => {
  for (const url of ['http://example.com/a', 'https://user@example.com/a', 'https://127.0.0.1/a', 'https://host.local/a', 'https://example.com/a#x', 'https://example.com:8443/a', 'https://example.com/robots.txt', 'https://EXAMPLE.com/a']) {
    assert.throws(() => createPreviewEgress({ productUrls: [url] }), TypeError);
  }
  assert.throws(() => createPreviewEgress({ productUrls: [] }), TypeError);
});

test('retrieval rejects redirect to an unapproved destination without fetching it', async () => {
  const calls = [];
  const egress = createPreviewEgress({ productUrls: [product], fetcher: async url => {
    calls.push(url);
    return url === robots ? new Response('', { status: 404 }) : new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
  } });
  await assert.rejects(retrieve(product, { egress }), { code: 'fetch_failed' });
  assert.deepEqual(calls, [product]);
});

test('preview rejects unapproved submissions before persistence or background work', async () => {
  const request = new Request('https://audit.example/api/v1/audits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
    body: JSON.stringify({ url: product + '?private=value' }),
  });
  const response = await preview.fetch(request, {
    AUDIT_DB: { prepare: () => assert.fail('Unapproved input must not reach D1') },
    AUDIT_RATE_SECRET: 'x'.repeat(32),
  }, { waitUntil: () => assert.fail('Unapproved input must not start an audit') });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'invalid_input');
  assert.match(body.error.message, /approved demo product URL/);
  assert.doesNotMatch(JSON.stringify(body), /private=value/);
});
