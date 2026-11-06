import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieve, extract } from './retrieval.mjs';

const html = '<html><title>Example</title></html>';
function binding(routes, calls = []) {
  return { fetch: async (url, options) => {
    calls.push({ url, options });
    const result = routes[new URL(url).pathname];
    return typeof result === 'function' ? result(url) : result ?? new Response('', { status: 404 });
  } };
}
const page = () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const rejectsCode = (promise, code) => assert.rejects(promise, { code });

test('requires trusted egress and validates URLs', async () => {
  await rejectsCode(retrieve('https://example.com'), 'egress_required');
  for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'https://user:pass@example.com/', 'file:///etc/passwd', 'http://host.local/']) {
    await rejectsCode(retrieve(url, { egress: binding({}) }), 'invalid_url');
  }
});

test('checks robots and fetches bounded HTML without forwarding credentials', async () => {
  const calls = [];
  const response = await retrieve('https://example.com/a#fragment', { egress: binding({ '/robots.txt': new Response('User-agent: *\nDisallow: /private'), '/a': page() }, calls) });
  assert.equal(response.body, html);
  assert.equal(response.url, 'https://example.com/a');
  assert.equal(response.robots, 'allowed');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.redirect, 'manual');
  assert.deepEqual(Object.keys(calls[1].options.headers).sort(), ['accept', 'user-agent']);
});

test('robots deny, unknown, and unsupported rules fail closed', async () => {
  for (const policy of ['User-agent: *\nDisallow: /', 'User-agent: AEOAuditBot\nDisallow: /']) {
    await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/robots.txt': new Response(policy), '/a': page() }) }), 'robots_denied');
  }
  await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/robots.txt': new Response('', { status: 503 }) }) }), 'robots_unknown');
  await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/robots.txt': new Response('User-agent: *\nDisallow: /*') }) }), 'robots_unknown');
});

test('redirects check each destination and enforce limit', async () => {
  const calls = [];
  const egress = binding({ '/a': new Response(null, { status: 302, headers: { location: 'https://other.example/b' } }), '/b': page() }, calls);
  assert.equal((await retrieve('https://example.com/a', { egress })).url, 'https://other.example/b');
  assert.deepEqual(calls.map(x => new URL(x.url).host), ['example.com', 'example.com', 'other.example', 'other.example']);
  await rejectsCode(retrieve('https://example.com/a', { egress, maxRedirects: 0 }), 'too_many_redirects');
  await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/a': new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }) }) }), 'invalid_redirect');
});

test('limits bytes, time and content type', async () => {
  await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/a': page() }), maxBytes: 3 }), 'too_large');
  await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/a': new Response('abc') }) }), 'unsupported_content');
  await rejectsCode(retrieve('https://example.com/a', { egress: { fetch: () => new Promise(() => {}) }, timeoutMs: 10 }), 'timeout');
});

test('extraction requires runtime and captures supported fields', async () => {
  await rejectsCode(extract({ body: html }), 'extractor_unavailable');
  class FakeRewriter {
    handlers = new Map();
    on(selector, handler) { this.handlers.set(selector, handler); return this; }
    transform(response) {
      this.handlers.get('title').text({ text: 'Example', lastInTextNode: true });
      this.handlers.get('h1').text({ text: 'Heading', lastInTextNode: true });
      this.handlers.get('meta[name]').element({ getAttribute: key => ({ name: 'description', content: 'Summary' })[key] });
      this.handlers.get('script[type="application/ld+json"]').text({ text: '{"@type":"Product"}', lastInTextNode: true });
      return response;
    }
  }
  const result = await extract({ body: html }, { HTMLRewriter: FakeRewriter });
  assert.equal(result.title, 'Example');
  assert.equal(result.description, 'Summary');
  assert.deepEqual(result.headings, [{ level: 1, text: 'Heading' }]);
  assert.deepEqual(result.jsonLd, ['{"@type":"Product"}']);
  assert.equal(result.coverage.bodyText, false);
});

test('normalization rejects nonstandard ports and oversized URLs', async () => {
  const { normalizeTarget } = await import('./retrieval.mjs');
  assert.equal(normalizeTarget('https://EXAMPLE.com:443/a#x'), 'https://example.com/a');
  assert.throws(() => normalizeTarget('https://example.com:8443/'), { code: 'invalid_url' });
  assert.throws(() => normalizeTarget(`https://example.com/${'a'.repeat(2048)}`), { code: 'invalid_url' });
});

test('robots maintenance pages, malformed policies, redirects and encoded paths fail closed', async () => {
  for (const response of [
    new Response('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('this is not robots syntax'),
    new Response('Disallow: /'),
    new Response(null, { status: 302, headers: { location: '/policy' } }),
  ]) await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/robots.txt': response }) }), 'robots_unknown');
  await rejectsCode(retrieve('https://example.com/%70rivate', { egress: binding({ '/robots.txt': new Response('User-agent: *\nDisallow: /private') }) }), 'robots_denied');
  await rejectsCode(retrieve('https://example.com/private', { egress: binding({ '/robots.txt': new Response('User-agent: *\nDisallow: /%70rivate') }) }), 'robots_denied');
});

test('cancels redirect and rejected response bodies', async () => {
  let cancelled = 0;
  const stream = () => new ReadableStream({ cancel() { cancelled++; } });
  await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/a': new Response(stream(), { status: 302, headers: { location: '/b' } }) }), maxRedirects: 0 }), 'too_many_redirects');
  await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/a': new Response(stream(), { headers: { 'content-type': 'application/json' } }) }) }), 'unsupported_content');
  assert.equal(cancelled, 2);
});

test('marks head-only output unusable and body text usable while visibility remains unknown', async () => {
  class FakeRewriter {
    handlers = new Map();
    on(selector, handler) { this.handlers.set(selector, handler); return this; }
    transform(response) {
      if (this.constructor.body) this.handlers.get('body p').text({ text: 'Product details', lastInTextNode: true });
      return response;
    }
  }
  assert.equal((await extract({ body: '<head><title>Only head</title></head>' }, { HTMLRewriter: FakeRewriter })).coverage.usable, false);
  FakeRewriter.body = true;
  const coverage = (await extract({ body: '<body><p>Product details</p></body>' }, { HTMLRewriter: FakeRewriter })).coverage;
  assert.equal(coverage.usable, true);
  assert.equal(coverage.visibility, 'unknown');
});


test('robots matches only exact agent and rejects escaped reserved paths', async () => {
  const egress = binding({ '/robots.txt': new Response('User-agent: bot\nDisallow: /\nUser-agent: *\nAllow: /'), '/a': page() });
  assert.equal((await retrieve('https://example.com/a', { egress })).status, 200);
  await rejectsCode(retrieve('https://example.com/a%2Fb', { egress: binding({ '/robots.txt': new Response('User-agent: *\nDisallow: /a/b') }) }), 'robots_unknown');
});

test('overlong JSON-LD is omitted and reported', async () => {
  class FakeRewriter {
    handlers = new Map();
    on(selector, handler) { this.handlers.set(selector, handler); return this; }
    transform(response) {
      const handler = this.handlers.get('script[type="application/ld+json"]');
      handler.text({ text: ' '.repeat(8192), lastInTextNode: false });
      handler.text({ text: '{"@type":"Product"}', lastInTextNode: true });
      return response;
    }
  }
  const result = await extract({ body: '' }, { HTMLRewriter: FakeRewriter });
  assert.deepEqual(result.jsonLd, []);
  assert.equal(result.coverage.jsonLdTruncated, true);
});

import './preview-egress.test.mjs';
