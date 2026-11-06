import './sitemap-parser.test.mjs';
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

test('robots denies matching literal and wildcard rules and fails closed on unavailable policy', async () => {
  for (const policy of ['User-agent: *\nDisallow: /', 'User-agent: AEOAuditBot\nDisallow: /']) {
    await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/robots.txt': new Response(policy), '/a': page() }) }), 'robots_denied');
  }
  await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/robots.txt': new Response('', { status: 503 }) }) }), 'robots_unknown');
  await rejectsCode(retrieve('https://example.com/a', { egress: binding({ '/robots.txt': new Response('User-agent: *\nDisallow: /*') }) }), 'robots_denied');
});

test('redirects check each destination and enforce limit', async () => {
  const calls = [];
  const egress = binding({ '/a': new Response(null, { status: 302, headers: { location: 'https://other.example.org/b' } }), '/b': page() }, calls);
  assert.equal((await retrieve('https://example.com/a', { egress })).url, 'https://other.example.org/b');
  assert.deepEqual(calls.map(x => new URL(x.url).host), ['example.com', 'example.com', 'other.example.org', 'other.example.org']);
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

import './public-egress.test.mjs';

import './robots-path.test.mjs';

test('robots wildcard filters respect specificity, end anchors, and reserved escape rules', async () => {
  const policy = 'User-agent: *\nAllow: /\nDisallow: /*/checkout\nDisallow: /products/*?*preview=1$\nDisallow: /collections/*%2B*\nDisallow: /*?*ls%3*ls%3*';
  const egress = binding({ '/robots.txt': new Response(policy), '/products/coffee': page() });
  assert.equal((await retrieve('https://example.com/products/coffee', { egress })).robots, 'allowed');
  await rejectsCode(retrieve('https://example.com/products/coffee?preview=1', {
    egress: binding({ '/robots.txt': new Response(policy) }),
  }), 'robots_denied');
  await rejectsCode(retrieve('https://example.com/' + 'a'.repeat(500), {
    egress: binding({ '/robots.txt': new Response('User-agent: *\n' + ('Disallow: /never*matches\n').repeat(40)) }),
  }), 'robots_unknown');
});

test('crawler policy uses bot-specific groups for the final redirect path', async () => {
  const calls = [];
  const egress = binding({
    '/robots.txt': new Response('User-agent: *\nAllow: /\nUser-agent: OAI-SearchBot\nDisallow: /final\nUser-agent: GPTBot\nDisallow: /'),
    '/start': new Response(null, { status: 302, headers: { location: '/final' } }),
    '/final': page(),
  }, calls);
  // The fixture supplies independent robots responses for the two requests.
  const original = egress.fetch;
  egress.fetch = async (url, options) => url.endsWith('/robots.txt')
    ? new Response('User-agent: *\nAllow: /\nUser-agent: OAI-SearchBot\nDisallow: /final\nUser-agent: GPTBot\nDisallow: /')
    : original(url, options);
  const result = await retrieve('https://example.com/start', { egress });
  assert.equal(result.crawlerPolicy.url, 'https://example.com/robots.txt');
  assert.equal(result.crawlerPolicy.httpStatus, 200);
  assert.deepEqual(result.crawlerPolicy.observations.map(({ botId, status }) => [botId, status]), [
    ['googlebot', 'allowed'], ['bingbot', 'allowed'], ['oai-searchbot', 'disallowed'],
    ['claude-searchbot', 'allowed'], ['perplexitybot', 'allowed'],
  ]);
});

test('missing robots only reports documented crawler behavior', async () => {
  const result = await retrieve('https://example.com/a', { egress: binding({ '/robots.txt': new Response(null, { status: 404 }), '/a': page() }) });
  assert.equal(result.crawlerPolicy.httpStatus, 404);
  assert.deepEqual(result.crawlerPolicy.observations.map(item => item.status), ['allowed', 'not_measured', 'not_measured', 'not_measured', 'not_measured']);
});

test('crawler matching shares a bounded work budget and leaves excess observations unmeasured', async () => {
  const rules = Array.from({ length: 20 }, (_, i) => `Disallow: /${'x'.repeat(100)}${i}`).join('\n');
  const policy = `User-agent: *\nAllow: /\nUser-agent: Googlebot\n${rules}\nUser-agent: bingbot\n${rules}\nUser-agent: OAI-SearchBot\n${rules}`;
  const result = await retrieve(`https://example.com/${'a'.repeat(40)}`, { egress: binding({ '/robots.txt': new Response(policy), [`/${'a'.repeat(40)}`]: page() }) });
  assert.equal(result.crawlerPolicy.observations[0].status, 'allowed');
  assert.equal(result.crawlerPolicy.observations[1].status, 'not_measured');
});

test('label evidence assembles complete element text and fails closed on ambiguity', async () => {
  class EvidenceRewriter {
    handlers = new Map();
    on(selector, handler) { this.handlers.set(selector, handler); return this; }
    transform(response) {
      const element = (selector, attrs = {}) => {
        let end;
        this.handlers.get(selector).element({ getAttribute: key => attrs[key] ?? null, onEndTag: fn => { end = fn; } });
        return () => end?.();
      };
      const titleEnd = element('head title');
      this.handlers.get('head title').text({ text: 'The ', lastInTextNode: false });
      this.handlers.get('head title').text({ text: 'Product', lastInTextNode: true });
      titleEnd();
      element('main');
      if (this.constructor.ancestorSelector) this.handlers.get(this.constructor.ancestorSelector).element({});
      const headingEnd = element('main h1', this.constructor.headingAttributes);
      this.handlers.get('main h1').text({ text: 'Great ', lastInTextNode: true });
      this.handlers.get('main h1').text({ text: this.constructor.overlong ? 'x'.repeat(8193) : 'Product', lastInTextNode: true });
      headingEnd();
      if (this.constructor.duplicate) element('main h1')();
      return response;
    }
  }
  const evidence = async () => (await extract({ body: '' }, { HTMLRewriter: EvidenceRewriter })).labelEvidence;
  assert.deepEqual(await evidence(), { title: 'The Product', mainH1: 'Great Product' });
  EvidenceRewriter.duplicate = true;
  assert.equal((await evidence()).mainH1, null);
  EvidenceRewriter.duplicate = false;
  EvidenceRewriter.headingAttributes = { hidden: '' };
  assert.equal((await evidence()).mainH1, null);
  EvidenceRewriter.headingAttributes = { style: 'opacity:0' };
  assert.equal((await evidence()).mainH1, null);
  EvidenceRewriter.headingAttributes = {};
  for (const selector of ['main [hidden] h1', 'main [inert] h1', 'main template h1', 'main noscript h1', '[inert] main']) {
    EvidenceRewriter.ancestorSelector = selector;
    assert.equal((await evidence()).mainH1, null, selector);
  }
  EvidenceRewriter.ancestorSelector = null;
  EvidenceRewriter.overlong = true;
  assert.equal((await evidence()).mainH1, null);
});

test('optional sitemap observation follows bounded same-origin permitted paths', async () => {
  const calls = [];
  const xml = locations => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map(loc => `<url><loc>${loc}</loc></url>`).join('')}</urlset>`;
  const index = locations => `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map(loc => `<sitemap><loc>${loc}</loc></sitemap>`).join('')}</sitemapindex>`;
  const egress = binding({
    '/robots.txt': () => new Response('User-agent: *\nDisallow: /blocked\nSitemap: https://example.com/index.xml'),
    '/a': page,
    '/index.xml': () => new Response(index(['https://example.com/child.xml'])),
    '/child.xml': () => new Response(xml(['https://example.com/a'])),
  }, calls);
  const result = await retrieve('https://example.com/a', { egress, observeSitemap: true });
  assert.deepEqual(result.sitemap, { usableSource: 'https://example.com/child.xml', inclusionSource: 'https://example.com/child.xml' });
  assert.equal(calls.length, 4);
  assert.equal(calls[2].options.redirect, 'manual');

  const blockedCalls = [];
  const blocked = await retrieve('https://example.com/a', { observeSitemap: true, egress: binding({
    '/robots.txt': () => new Response('User-agent: *\nDisallow: /blocked\nSitemap: https://other.example.org/sitemap.xml\nSitemap: https://example.com/blocked'),
    '/a': page,
  }, blockedCalls) });
  assert.deepEqual(blocked.sitemap, { usableSource: null, inclusionSource: null });
  assert.equal(blockedCalls.length, 2);

  const multi = await retrieve('https://example.com/a', { observeSitemap: true, egress: binding({
    '/a': page,
    '/sitemap.xml': () => new Response(index(['https://example.com/child.xml', 'https://example.com/other.xml'])),
    '/child.xml': () => new Response(xml(['https://example.com/a'])),
  }) });
  assert.deepEqual(multi.sitemap, { usableSource: null, inclusionSource: 'https://example.com/child.xml' });
});

test('optional sitemap failures, redirects, and oversized bodies do not fail the audit', async () => {
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: 'https://other.example.org/sitemap.xml' } }),
    () => new Response('x'.repeat(32769)),
    () => new Response('<urlset>'),
    () => { throw new Error('offline'); },
  ]) {
    const result = await retrieve('https://example.com/a', { observeSitemap: true, egress: binding({ '/a': page, '/sitemap.xml': response }) });
    assert.deepEqual(result.sitemap, { usableSource: null, inclusionSource: null });
  }
  const calls = [];
  let sitemapSignal;
  const bounded = await retrieve('https://example.com/a', { observeSitemap: true, timeoutMs: 60, egress: {
    fetch(url, options) {
      calls.push(url);
      if (url.endsWith('/robots.txt')) return new Response(null, { status: 404 });
      if (url.endsWith('/sitemap.xml')) {
        sitemapSignal = options.signal;
        return new Promise(() => {});
      }
      return page();
    },
  } });
  assert.equal(bounded.status, 200);
  assert.deepEqual(bounded.sitemap, { usableSource: null, inclusionSource: null });
  assert.equal(sitemapSignal?.aborted, true);
  calls.length = 0;
  const result = await retrieve('https://example.com/a', { egress: binding({ '/a': page }, calls) });
  assert.equal(result.sitemap, undefined);
  assert.equal(calls.length, 2);
});
