import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectBrowserSupport, inspectPreparedPolicyLinks, scorePreparedDomainStructure } from './browser-support.mjs';
import { HtmlTestRewriter } from './html-product-test-helper.mjs';
import { assessSupport } from './support-assessment.mjs';

const product='https://shop.example.com/products/item';
const snapshot=()=>({url:product,extracted:{productHtml:{complete:true,discoveryLinks:[{url:'/shipping',text:'Shipping'},{url:'/returns',text:'Returns'},{url:'https://evil.example.net/shipping',text:'Shipping'}]}}});

test('prepared policy inspection fetches only eligible linked unresolved policies', async()=>{
  const calls=[];
  const links=[{url:'https://evil.com/shipping',text:'Shipping'}, {url:'/products/item',text:'Shipping'}, {url:'/shipping?x=1',text:'Shipping'}, {url:'/shipping',text:'Shipping'}, {url:'/returns',text:'Returns'}];
  const result=await inspectPreparedPolicyLinks('https://shop.com/products/item',links,{kinds:['returns'],HTMLRewriter:HtmlTestRewriter,fetcher:async(target,options)=>{
    calls.push({target,options});
    return new Response('<main><p>Returns are accepted for thirty days.</p></main>',{headers:{'content-type':'text/html'}});
  }});
  assert.equal(result.shipping.state,'unknown');
  assert.equal(result.returns.state,'read');
  assert.deepEqual(calls.map(c=>c.target),['https://shop.com/returns']);
  assert.equal(calls[0].options.redirect,'manual');
});

test('prepared policy inspection rejects redirects and oversized bodies', async()=>{
  const links=[{url:'/shipping',text:'Shipping'}, {url:'/returns',text:'Returns'}];
  const calls=[];
  const result=await inspectPreparedPolicyLinks('https://shop.com/products/item',links,{HTMLRewriter:HtmlTestRewriter,fetcher:async target=>{
    calls.push(target);
    return target.endsWith('/shipping') ? new Response(null,{status:302,headers:{location:'https://evil.com/shipping'}}) : new Response('x'.repeat(1024*1024+1),{headers:{'content-type':'text/html'}});
  }});
  assert.equal(result.shipping.state,'failed');
  assert.equal(result.returns.state,'failed');
  assert.equal(calls.length,2);
  assert.ok(calls.every(url=>new URL(url).origin==='https://shop.com'));
});

test('prepared policy inspection ignores promotional and commerce navigation links', async()=>{
  const calls=[];
  const links=[
    {url:'/collections/featured',text:'FREE SHIPPING OVER $50. CONT. US'},
    {url:'/',text:'Shipping'}, {url:'/products/shipping',text:'Shipping'},
    {url:'/cart',text:'Returns'}, {url:'/offers',text:'Free shipping on every order'},
    {url:'/pages/shipping-policy',text:'Shipping Policy'}, {url:'/pages/returns',text:'Returns'},
  ];
  const result=await inspectPreparedPolicyLinks('https://shop.com/products/item',links,{HTMLRewriter:HtmlTestRewriter,fetcher:async target=>{
    calls.push(target);
    return new Response('<main><p>Shipping takes three days; returns accepted for thirty days.</p></main>',{headers:{'content-type':'text/html'}});
  }});
  assert.deepEqual(calls,['https://shop.com/pages/shipping-policy','https://shop.com/pages/returns']);
  assert.equal(result.shipping.state,'read');
  assert.equal(result.returns.state,'read');
});
test('same-session transport inspects supporting resources without fetching the product',async()=>{
  const calls=[];
  const fetchBounded=async url=>{
    calls.push(url.href);
    if(url.pathname==='/robots.txt') return new Response('User-agent: *\nAllow: /\n',{headers:{'content-type':'text/plain'}});
    if(url.pathname==='/sitemap.xml') return new Response(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${product}</loc></url></urlset>`,{headers:{'content-type':'application/xml'}});
    if(url.pathname==='/shipping'||url.pathname==='/returns') return new Response('<html><body><main><p>Shipping takes three days and returns are accepted for thirty days.</p></main></body></html>',{headers:{'content-type':'text/html'}});
    return new Response(null,{status:404});
  };
  const result=await inspectBrowserSupport(snapshot(),{fetchBounded,signal:new AbortController().signal,HTMLRewriter:HtmlTestRewriter});
  assert.ok(result.crawlerPolicy.observations.some(o=>o.status==='allowed'));
  assert.equal(result.sitemap.inclusionSource,'https://shop.example.com/sitemap.xml');
  assert.equal(result.guides.llmsState,'absent');
  assert.equal(result.policies.shipping.state,'read');
  assert.equal(result.policies.returns.state,'read');
  assert.ok(calls.every(url=>new URL(url).origin==='https://shop.example.com' && url!==product));
});
test('failed or aborted support remains unmeasured without retrying product',async()=>{
  const result=await inspectBrowserSupport(snapshot(),{fetchBounded:async()=>{throw new Error('blocked');},signal:new AbortController().signal});
  assert.ok(result.crawlerPolicy.observations.every(o=>o.status==='not_measured'));
  assert.notEqual(result.sitemap.complete,true);
  assert.equal(result.guides.llmsState,'unknown');
  assert.notEqual(result.policies.shipping.state,'read');
  const controller=new AbortController();controller.abort();let calls=0;
  await inspectBrowserSupport(snapshot(),{fetchBounded:async()=>{calls++;},signal:controller.signal});
  assert.equal(calls,0);
});

test('support observations produce independent crawler, sitemap and guide findings',async()=>{
  const calls=[];
  const fetchBounded=async url=>{
    calls.push(url.href);
    if(url.pathname==='/robots.txt') return new Response('User-agent: *\nAllow: /\n',{headers:{'content-type':'text/plain'}});
    if(url.pathname==='/sitemap.xml') return new Response(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${product}</loc></url></urlset>`,{headers:{'content-type':'application/xml'}});
    if(url.pathname==='/llms.txt') return new Response(`# Shop\n\nWe sell outdoor equipment and clothing for hikers.\n\n[Product](${product})\n[Shipping](https://shop.example.com/shipping)`,{headers:{'content-type':'text/plain'}});
    if(url.pathname==='/shipping'||url.pathname==='/returns') return new Response('<html><body><main><p>Shipping takes three days and returns are accepted for thirty days.</p></main></body></html>',{headers:{'content-type':'text/html'}});
    return new Response(null,{status:404});
  };
  const inspected=await inspectBrowserSupport(snapshot(),{fetchBounded,signal:new AbortController().signal,HTMLRewriter:HtmlTestRewriter});
  const checks=assessSupport(inspected);
  for(const id of ['S5.search','S5.ai-retrieval','S6.usable','S6.inclusion','S7.identity','S7.links']) assert.equal(checks[id].fraction,1,id);
  assert.ok(calls.length<=8);
  assert.ok(calls.every(url=>new URL(url).origin===new URL(product).origin && url!==product));
});

test('a missing default sitemap does not establish absence when robots declarations are unknown',async()=>{
  const fetchBounded=async url=>url.pathname==='/robots.txt' ? new Response(null,{status:503}) : new Response(null,{status:404});
  const inspected=await inspectBrowserSupport(snapshot(),{fetchBounded,signal:new AbortController().signal});
  const checks=assessSupport(inspected);
  assert.equal(checks['S5.search'].status,'not_measured');
  assert.equal(checks['S6.usable'].status,'not_measured');
  assert.equal(checks['S7.identity'].fraction,0);
});

test('prepared domain scoring uses only bounded public support requests',async()=>{
  const url='https://shop.com/products/item';
  const calls=[];
  const fetcher=async (target,options)=>{
    calls.push({target,options});
    const path=new URL(target).pathname;
    if(path==='/robots.txt') return new Response('User-agent: *\nAllow: /\n',{headers:{'content-type':'text/plain'}});
    if(path==='/sitemap.xml') return new Response(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url}</loc></url></urlset>`,{headers:{'content-type':'application/xml'}});
    if(path==='/llms.txt') return new Response('# Shop\n\nWe sell outdoor equipment and clothing for hikers.',{headers:{'content-type':'text/plain'}});
    throw new Error('unexpected request');
  };
  const checks=await scorePreparedDomainStructure(url,{fetcher});
  for(const id of ['S5.search','S5.ai-retrieval','S6.usable','S6.inclusion','S7.identity']) assert.equal(checks[id].fraction,1,id);
  assert.equal(checks['S7.links'].fraction,0);
  assert.equal(calls.length,3);
  assert.ok(calls.every(({target,options})=>new URL(target).origin==='https://shop.com' && target!==url && options.method==='GET' && options.redirect==='manual'));
});

test('prepared domain scoring does not follow support redirects',async()=>{
  const calls=[];
  const checks=await scorePreparedDomainStructure('https://shop.com/products/item',{fetcher:async target=>{
    calls.push(target);
    return new Response(null,{status:302,headers:{location:'https://other.com/resource'}});
  }});
  assert.ok(calls.length<=4);
  assert.ok(calls.every(target=>new URL(target).origin==='https://shop.com'));
  assert.ok(Object.values(checks).every(check=>check.status==='not_measured'));
});
