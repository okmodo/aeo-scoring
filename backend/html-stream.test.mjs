import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieve, extract } from './retrieval.mjs';

const encoder = new TextEncoder();
function egressFor(body, headers = {}) {
  return { fetch: async url => new URL(url).pathname === '/robots.txt'
    ? new Response(null, { status: 404 })
    : new Response(body, { headers: { 'content-type': 'text/html', ...headers } }) };
}
const consume = async snapshot => new Response(snapshot.body).text();

test('streams more than the buffered limit and retains late content', async () => {
  const html = 'x'.repeat(600 * 1024) + '<title>late evidence</title>';
  const result = await retrieve('https://example.com/', { egress: egressFor(html), consumeHtml: consume });
  assert.equal(result.extracted, html);
  assert.equal(result.htmlLimited, null);
});

test('distinguishes exact limit from excess, regardless of content length', async () => {
  for (const [html, limited] of [['abcde', null], ['abcdef', 'bytes']]) {
    const result = await retrieve('https://example.com/', { egress: egressFor(html, { 'content-length': '9999' }), maxStreamBytes: 5, consumeHtml: consume });
    assert.equal(result.extracted, 'abcde');
    assert.equal(result.htmlLimited, limited);
  }
});

test('deadline preserves prefix and cancels the upstream stream', async () => {
  let canceled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('prefix')); }, cancel() { canceled = true; } });
  const result = await retrieve('https://example.com/', { egress: egressFor(body), timeoutMs: 30, consumeHtml: consume });
  assert.equal(result.extracted, 'prefix');
  assert.equal(result.htmlLimited, 'time');
  assert.equal(canceled, true);
});

test('upstream failures remain failures rather than truncation', async () => {
  const body = new ReadableStream({ pull(controller) { controller.error(new Error('network')); } });
  await assert.rejects(retrieve('https://example.com/', { egress: egressFor(body), consumeHtml: consume }), { code: 'fetch_failed' });
});

test('streaming extraction accepts only explicitly ended JSON-LD blocks', async () => {
  class Rewriter {
    handlers = new Map();
    on(selector, handler) { this.handlers.set(selector, handler); return this; }
    transform(response) {
      const script = this.handlers.get('script[type="application/ld+json"]');
      let end;
      script.element({ onEndTag(fn) { end = fn; } });
      script.text({ text: '{"complete":true}', lastInTextNode: true });
      end();
      script.element({ onEndTag() {} });
      script.text({ text: '{"partial":true}', lastInTextNode: true });
      return response;
    }
  }
  const result = await extract({ body: '', htmlLimited: 'bytes' }, { HTMLRewriter: Rewriter });
  assert.deepEqual(result.jsonLd, ['{"complete":true}']);
  assert.equal(result.coverage.jsonLdTruncated, true);
});

test('a stalled consumer cannot prevent upstream cancellation by locking the body', async () => {
  let canceled = false;
  const body = new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}); } });
  await assert.rejects(retrieve('https://example.com/', {
    egress: egressFor(body), timeoutMs: 15,
    consumeHtml(snapshot) { snapshot.body.getReader(); return new Promise(() => {}); },
  }), { code: 'timeout' });
  assert.equal(canceled, true);
});
