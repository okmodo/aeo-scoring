import { HtmlTestRewriter } from './html-product-test-helper.mjs';
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
  assert.equal(calls[0].url, 'https://example.com/a');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.redirect, 'manual');
  assert.deepEqual(Object.keys(calls[1].options.headers).sort(), ['accept', 'user-agent']);
});

test('robots restrictions and unavailable policies do not block products', async () => {
  for (const policy of ['User-agent: *\nDisallow: /', 'User-agent: AEOAuditBot\nDisallow: /', null]) {
    const result = await retrieve('https://example.com/a', { egress: binding({ '/robots.txt': policy === null ? new Response('', { status: 503 }) : new Response(policy), '/a': page() }) });
    assert.equal(result.body, html);
    if (policy === null) assert.ok(result.crawlerPolicy.observations.every(item => item.status === 'not_measured'));
  }
});

test('redirects check each destination and enforce limit', async () => {
  const calls = [];
  const egress = binding({ '/a': new Response(null, { status: 302, headers: { location: 'https://other.example.org/b' } }), '/b': page() }, calls);
  assert.equal((await retrieve('https://example.com/a', { egress })).url, 'https://other.example.org/b');
  assert.deepEqual(calls.map(x => new URL(x.url).host), ['example.com', 'other.example.org', 'other.example.org']);
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

test('unusable robots evidence never fails the product', async () => {
  for (const response of [
    new Response('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('this is not robots syntax'), new Response('Disallow: /'),
    new Response(null, { status: 302, headers: { location: '/policy' } }),
    new Response(new Uint8Array([255]), { headers: { 'content-type': 'text/plain' } }),
  ]) {
    const result = await retrieve('https://example.com/a', { egress: binding({ '/robots.txt': response, '/a': page() }) });
    assert.ok(result.crawlerPolicy.observations.every(item => item.status === 'not_measured'));
  }
});

test('stalled robots is bounded and cannot consume the product deadline', async () => {
  let signal;
  const start = Date.now();
  const result = await retrieve('https://example.com/a', { timeoutMs: 2000, egress: { fetch(url, options) {
    if (url.endsWith('/robots.txt')) { signal = options.signal; return new Promise(() => {}); }
    return page();
  } } });
  assert.equal(result.body, html);
  assert.ok(Date.now() - start < 1500);
  assert.equal(signal.aborted, true);
  assert.equal(result.crawlerPolicy.httpStatus, null);
  assert.ok(result.crawlerPolicy.observations.every(item => item.status === 'not_measured'));
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


test('ambiguous escaped paths leave crawler policy unmeasured', async () => {
  const result = await retrieve('https://example.com/a%2Fb', { egress: binding({ '/robots.txt': new Response('User-agent: *\nDisallow: /a/b'), '/a%2Fb': page() }) });
  assert.ok(result.crawlerPolicy.observations.every(item => item.status === 'not_measured'));
});

test('overlong JSON-LD is omitted and reported', async () => {
  class FakeRewriter {
    handlers = new Map();
    on(selector, handler) { this.handlers.set(selector, handler); return this; }
    transform(response) {
      const handler = this.handlers.get('script[type="application/ld+json"]');
      handler.text({ text: ' '.repeat(128 * 1024), lastInTextNode: false });
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

test('wildcard deny rules are reported without blocking the page', async () => {
  const result = await retrieve('https://example.com/products/coffee?preview=1', { egress: binding({ '/robots.txt': new Response('User-agent: *\nDisallow: /products/*?*preview=1$'), '/products/coffee': page() }) });
  assert.ok(result.crawlerPolicy.observations.some(item => item.status === 'disallowed'));
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
  assert.deepEqual(result.sitemap, { usableSource: 'https://example.com/child.xml', inclusionSource: 'https://example.com/child.xml', complete: true });
  assert.equal(calls.length, 4);
  assert.equal(calls[2].options.redirect, 'manual');

  const blockedCalls = [];
  const blocked = await retrieve('https://example.com/a', { observeSitemap: true, egress: binding({
    '/robots.txt': () => new Response('User-agent: *\nDisallow: /blocked\nSitemap: https://other.example.org/sitemap.xml\nSitemap: https://example.com/blocked'),
    '/a': page,
  }, blockedCalls) });
  assert.deepEqual(blocked.sitemap, { usableSource: null, inclusionSource: null, complete: false });
  assert.equal(blockedCalls.length, 3);
  assert.ok(blockedCalls.some(call => call.url.endsWith('/blocked')));

  const multi = await retrieve('https://example.com/a', { observeSitemap: true, egress: binding({
    '/a': page,
    '/sitemap.xml': () => new Response(index(['https://example.com/child.xml', 'https://example.com/other.xml'])),
    '/child.xml': () => new Response(xml(['https://example.com/a'])),
  }) });
  assert.deepEqual(multi.sitemap, { usableSource: null, inclusionSource: 'https://example.com/child.xml', complete: false });
});

test('sitemap declarations survive malformed robots rules', async () => {
  const result = await retrieve('https://example.com/a', { observeSitemap: true, egress: binding({
    '/a': page,
    '/robots.txt': () => new Response('bad syntax\nSitemap: https://example.com/blocked'),
    '/blocked': () => new Response('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url></urlset>'),
  }) });
  assert.equal(result.sitemap.inclusionSource, 'https://example.com/blocked');
  assert.ok(result.crawlerPolicy.observations.every(item => item.status === 'not_measured'));
});

test('optional sitemap failures, redirects, and oversized bodies do not fail the audit', async () => {
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: 'https://other.example.org/sitemap.xml' } }),
    () => new Response('x'.repeat(32769)),
    () => new Response('<urlset>'),
    () => { throw new Error('offline'); },
  ]) {
    const result = await retrieve('https://example.com/a', { observeSitemap: true, egress: binding({ '/a': page, '/sitemap.xml': response }) });
    assert.deepEqual(result.sitemap, { usableSource: null, inclusionSource: null, complete: false });
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
  assert.deepEqual(bounded.sitemap, { usableSource: null, inclusionSource: null, complete: false });
  assert.equal(sitemapSignal?.aborted, true);
  calls.length = 0;
  const result = await retrieve('https://example.com/a', { egress: binding({ '/a': page }, calls) });
  assert.equal(result.sitemap, undefined);
  assert.equal(calls.length, 2);
});

test('guide inspection is opt-in, bounded to fixed final-origin paths, and reconciles case variants', async () => {
  const calls = [];
  const routes = { '/a': page(), '/llms.txt': new Response('guide'), '/AGENTS.md': new Response(' instructions '), '/agents.md': new Response('instructions') };
  const snapshot = await retrieve('https://example.com/a', { egress: binding(routes, calls), observeGuides: true });
  assert.deepEqual(snapshot.guides, { llms: { url: 'https://example.com/llms.txt', text: 'guide' }, agents: { url: 'https://example.com/AGENTS.md', text: ' instructions ' }, llmsState: 'found', agentsState: 'found' });
  assert.deepEqual(calls.slice(2).map(call => new URL(call.url).pathname), ['/llms.txt', '/AGENTS.md', '/agents.md']);
  const basicCalls = [];
  await retrieve('https://example.com/a', { egress: binding({ '/a': page() }, basicCalls) });
  assert.equal(basicCalls.length, 2);
});

test('guide failures and conflicts never assert agents evidence or fail the page', async () => {
  for (const lower of [new Response('different'), new Response('', { status: 503 }), new Response(null, { status: 302, headers: { location: '/elsewhere' } }), new Response(new Uint8Array([255]), { headers: { 'content-type': 'text/plain' } }), new Response('x'.repeat(8193))]) {
    const snapshot = await retrieve('https://example.com/a', { egress: binding({ '/a': page(), '/AGENTS.md': new Response('instructions'), '/agents.md': lower }), observeGuides: true });
    assert.equal(snapshot.guides.agents, null);
    assert.equal(snapshot.body, html);
  }
  const snapshot = await retrieve('https://example.com/a', { egress: binding({ '/a': page(), '/AGENTS.md': new Response('instructions') }), observeGuides: true });
  assert.equal(snapshot.guides.agents.text, 'instructions');
});

test('guide probes ignore robots and abort on their shared deadline', async () => {
  const calls = [];
  const snapshot = await retrieve('https://example.com/a', { egress: binding({ '/robots.txt': new Response('User-agent: *\nDisallow: /AGENTS.md'), '/a': page(), '/agents.md': new Response('instructions'), '/llms.txt': () => new Promise(() => {}) }, calls), observeGuides: true });
  assert.deepEqual(snapshot.guides, { llms: null, agents: { url: 'https://example.com/agents.md', text: 'instructions' }, llmsState: 'unknown', agentsState: 'found' });
  assert.equal(calls.some(call => call.url.endsWith('/AGENTS.md')), true);
  assert.equal(calls.find(call => call.url.endsWith('/llms.txt')).options.signal.aborted, true);
});

test('unsupported robots rules leave observations unmeasured without blocking', async () => {
  const result = await retrieve('https://example.com/search', { egress: binding({
    '/robots.txt': () => new Response('User-agent: *\nDisallow: */search*'), '/search': page,
  }) });
  assert.equal(result.status, 200);
  assert.ok(result.crawlerPolicy.observations.every(item => item.status === 'not_measured'));
});

test('policy inspection fetches at most two safe same-origin pages and ignores robots restrictions', async () => {
  const calls = [];
  const routes = { '/a': page(), '/robots.txt': new Response('User-agent: *\nDisallow: /'), '/policies/shipping': new Response('<main><h1>Shipping</h1><p>Ships in two days.</p></main>', { headers: { 'content-type': 'text/html' } }), '/returns': new Response('<main><h1>Returns</h1><p>Return within 30 days.</p></main>', { headers: { 'content-type': 'text/html' } }) };
  const snapshot = await retrieve('https://example.com/a', { egress: binding(routes, calls), observeGuides: true, HTMLRewriter: HtmlTestRewriter, consumeHtml: async () => ({ productHtml: { discoveryLinks: [{ url: 'https://evil.example/shipping', text: 'Shipping' }, { url: '/policies/shipping', text: 'Shipping' }, { url: '/returns', text: 'Returns' }] } }) });
  assert.equal(snapshot.policies.shipping.state, 'read');
  assert.equal(snapshot.policies.returns.extraction.blocks[0].text, 'Return within 30 days.');
  assert.equal(calls.some(call => call.url.includes('evil.example')), false);
});

test('unrelated multiword and slash user agents do not invalidate ordinary crawler rules', async () => {
  const snapshot = await retrieve('https://example.com/a', { egress: binding({ '/a': page(), '/robots.txt': new Response('User-agent: Some Bot/1.0\nDisallow: /private\nUser-agent: *\nDisallow: /a') }) });
  assert.ok(snapshot.crawlerPolicy.observations.some(item => item.status === 'disallowed'));
});

test('policy terms after a large template are read within the product source cap; oversized policies remain unknown', async () => {
  const policy = '<main><!--' + 'x'.repeat(172 * 1024) + '--><p>Return unworn items within 30 days.</p></main>';
  const run = html => retrieve('https://example.com/a', { egress: binding({ '/a': page(), '/robots.txt': new Response(''), '/returns': new Response(html, {headers:{'content-type':'text/html'}}) }), observeGuides: true, HTMLRewriter: HtmlTestRewriter, consumeHtml: async () => ({productHtml:{discoveryLinks:[{url:'/returns',text:'Returns'}]}}) });
  const complete = await run(policy);
  assert.equal(complete.policies.returns.state, 'read');
  assert.equal(complete.policies.returns.extraction.blocks[0].text, 'Return unworn items within 30 days.');
  const excess = await run(policy + 'x'.repeat(1024 * 1024));
  assert.equal(excess.policies.returns.state, 'failed');
  assert.equal(excess.policies.returns.extraction, undefined);
});

test('sitemap absence requires successful inspection of every declared listing within the request budget', async () => {
  const xml = locations => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map(loc=>`<url><loc>${loc}</loc></url>`).join('')}</urlset>`;
  const routes = {
    '/a':page,
    '/robots.txt':()=>new Response('User-agent: *\nSitemap: https://example.com/one.xml\nSitemap: https://example.com/two.xml'),
    '/one.xml':()=>new Response(xml(['https://example.com/other'])),
    '/two.xml':()=>new Response(xml(['https://example.com/a'])),
  };
  const included=await retrieve('https://example.com/a',{egress:binding(routes),observeSitemap:true});
  assert.equal(included.sitemap.complete,true);assert.equal(included.sitemap.inclusionSource,'https://example.com/two.xml');
  const failed=await retrieve('https://example.com/a',{egress:binding({...routes,'/two.xml':()=>new Response(null,{status:503})}),observeSitemap:true});
  assert.equal(failed.sitemap.complete,false);assert.equal(failed.sitemap.inclusionSource,null);
  const limited=await retrieve('https://example.com/a',{egress:binding({...routes,'/robots.txt':()=>new Response('Sitemap: https://example.com/one.xml\nSitemap: https://example.com/two.xml\nSitemap: https://example.com/three.xml'),'/two.xml':()=>new Response(xml(['https://example.com/other2']))}),observeSitemap:true});
  assert.equal(limited.sitemap.complete,false);assert.equal(limited.sitemap.inclusionSource,null);
});

test('verified BigCommerce product scope follows explicitly partitioned relevant sitemap child',async()=>{
 const {readFileSync}=await import('node:fs');
 const index=readFileSync(new URL('./fixtures/content-facts/kokatat-index.xml',import.meta.url),'utf8');
 const products=readFileSync(new URL('./fixtures/content-facts/kokatat-products.xml',import.meta.url),'utf8');
 const target='https://kokatat.com/naiad-pfd-lvhnai';
 const state={platform:'bigcommerce.stencil',complete:true,identity:{mainH1:'Naiad Life Vest'},structuredRecords:[{complete:true,record:{'@type':'Product',name:'Naiad Life Vest'}}]};
 const run=(indexText,childResponse,stateOverride={})=>retrieve(target,{observeSitemap:true,consumeHtml:async snapshot=>{await new Response(snapshot.body).text();return {productHtml:{...state,...stateOverride}};},egress:{fetch:async url=>{
   const u=new URL(url);
   if(u.pathname==='/robots.txt')return new Response('Sitemap: https://kokatat.com/xmlsitemap.php');
   if(u.pathname==='/xmlsitemap.php')return childResponse && u.search ? childResponse() : new Response(indexText,{headers:{'content-type':'application/xml'}});
   return new Response('<main>Naiad Life Vest</main>',{headers:{'content-type':'text/html'}});
 }}});
 const good=await run(index,()=>new Response(products,{headers:{'content-type':'application/xml'}}));
 assert.equal(good.sitemap.complete,true);assert.equal(good.sitemap.inclusionSource,'https://kokatat.com/xmlsitemap.php?type=products&page=1');
 const broken=await run(index,()=>new Response(null,{status:503}));assert.equal(broken.sitemap.complete,false);
 const multi=index.replace('</sitemapindex>','<sitemap><loc>https://kokatat.com/xmlsitemap.php?type=products&amp;page=2</loc></sitemap></sitemapindex>');
 assert.equal((await run(multi,()=>new Response(products,{headers:{'content-type':'application/xml'}}))).sitemap.complete,false);
 const unknown=await run(index,()=>new Response(products,{headers:{'content-type':'application/xml'}}),{platform:null});
 assert.equal(unknown.sitemap.complete,false);
});

test('all declared sitemap starts must be inspected for usability, while exact inclusion survives a partial scan', async () => {
  const xml = url => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url}</loc></url></urlset>`;
  const robots = starts => new Response('User-agent: *\nAllow: /\n' + starts.map(name=>`Sitemap: https://example.com/${name}`).join('\n'));
  const declarations=['first.xml','second.xml'];
  const make = (second,calls=[]) => retrieve('https://example.com/a',{observeSitemap:true,egress:binding({
    '/a':page,'/robots.txt':()=>robots(declarations),'/first.xml':()=>new Response(xml('https://example.com/a')),'/second.xml':second,
  },calls)});
  const calls=[];
  const full=await make(()=>new Response(xml('https://example.com/other')),calls);
  assert.equal(full.sitemap.complete,true);
  assert.equal(full.sitemap.inclusionSource,'https://example.com/first.xml');
  assert.ok(full.sitemap.usableSource);
  assert.ok(calls.some(c=>c.url.endsWith('/second.xml')));
  for (const failure of [()=>new Response('bad xml'),()=>new Response('',{status:503}),()=>{throw new Error('offline');}]) {
    const partial=await make(failure);
    assert.deepEqual(partial.sitemap,{usableSource:null,inclusionSource:'https://example.com/first.xml',complete:false});
  }
  const exhausted=await retrieve('https://example.com/a',{observeSitemap:true,egress:binding({
    '/a':page,'/robots.txt':()=>robots(['first.xml','second.xml','third.xml']),
    '/first.xml':()=>new Response(xml('https://example.com/a')),'/second.xml':()=>new Response(xml('https://example.com/other')),
  })});
  assert.deepEqual(exhausted.sitemap,{usableSource:null,inclusionSource:'https://example.com/first.xml',complete:false});
});

test('an incomplete sitemap cannot earn full usability even when an exact URL was found', async () => {
  const {scoreAudit}=await import('./scoring.mjs');
  const source='https://example.com/first.xml';
  const snapshot={url:'https://example.com/a',observedAt:'2026-11-09T00:00:00.000Z',sitemap:{usableSource:source,inclusionSource:source,complete:false}};
  const check=(report,id)=>report.criteria.flatMap(c=>c.subchecks).find(c=>c.id===id);
  for (const extracted of [null,{productHtml:{complete:false,blocks:[],headings:[],links:[]},coverage:{jsonLdTruncated:false},jsonLd:[]}]) {
    const report=scoreAudit(snapshot,extracted);
    assert.equal(check(report,'S6.usable').status,'not_measured');
    assert.equal(check(report,'S6.inclusion').fraction,1);
  }
});

test('a discovered matching child cannot hide a second uninspected declared sitemap', async () => {
  const calls=[];
  const index='<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>';
  const child='<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url></urlset>';
  const result=await retrieve('https://example.com/a',{observeSitemap:true,egress:binding({
    '/a':page,'/robots.txt':()=>new Response('User-agent: *\nAllow: /\nSitemap: https://example.com/index.xml\nSitemap: https://example.com/second.xml'),
    '/index.xml':()=>new Response(index),'/child.xml':()=>new Response(child),'/second.xml':()=>new Response(child),
  },calls)});
  assert.deepEqual(result.sitemap,{usableSource:null,inclusionSource:'https://example.com/child.xml',complete:false});
  assert.ok(!calls.some(call=>call.url.endsWith('/second.xml')));
});
