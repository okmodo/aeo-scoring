import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectBrowserSupport } from './browser-support.mjs';
import { HtmlTestRewriter } from './html-product-test-helper.mjs';

const product='https://shop.example.com/products/item';
const snapshot=()=>({url:product,extracted:{productHtml:{complete:true,discoveryLinks:[{url:'/shipping',text:'Shipping'},{url:'/returns',text:'Returns'},{url:'https://evil.example.net/shipping',text:'Shipping'}]}}});
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
