import test from 'node:test';
import assert from 'node:assert/strict';
import {gatherInitialSupport,matchesInitialProduct} from './initial-support.mjs';
import {restorePreparedObservations} from './prepared-observations.mjs';
import {HtmlTestRewriter} from './html-product-test-helper.mjs';
import {extract} from './retrieval.mjs';

const url='https://shop.example.com/products/item';
const page = title => `<html><head><title>${title}</title><link rel="canonical" href="${url}"></head><body><main><h1>${title}</h1><p>A useful product description with details about this item.</p></main></body></html>`;
const parse = title => extract({url,body:page(title),htmlLimited:null},{HTMLRewriter:HtmlTestRewriter});
test('only matching canonical and product headings can supply initial evidence',async()=>{
 const rendered=await parse('Blue Shirt'), matching=await parse('Blue Shirt'), other=await parse('Red Shirt');
 assert.equal(matchesInitialProduct(matching,rendered,url),true);
 assert.equal(matchesInitialProduct(other,rendered,url),false);
 assert.equal(matchesInitialProduct({...matching,canonical:'https://shop.example.com/products/other'},rendered,url),false);
 assert.equal(matchesInitialProduct({...matching,canonical:''},rendered,url),false);
});
test('wrong product response is discarded while supporting observations survive',async()=>{
 const rendered=await parse('Blue Shirt');let calls=[];
 const result=await gatherInitialSupport({url},rendered,{HTMLRewriter:HtmlTestRewriter,egress:{fetch:async target=>{calls.push(target);return target===url ? new Response(page('Red Shirt'),{headers:{'content-type':'text/html'}}) : new Response(null,{status:404});}}});
 assert.equal(result.initialExtracted,null);assert.ok(result.support.crawlerPolicy);assert.ok(calls.includes('https://shop.example.com/robots.txt'));
 const restored=restorePreparedObservations({observations:{...result,support:{...result.support,url:'https://attacker.invalid/'}}});
 assert.equal(restored.initialAvailable,false);assert.ok(restored.support.crawlerPolicy);assert.equal(restored.support.url,undefined);
});

test('matching canonicals and duplicate responsive headings bind without upgrading completeness',async()=>{
 const base=await parse('Blue Shirt');
 const duplicate={...base,canonical:url,productHtml:{...base.productHtml,complete:false,identity:{...base.productHtml.identity,mainH1:null},headings:[{level:1,text:'Blue Shirt'},{level:1,text:'Blue Shirt'}]}};
 assert.equal(matchesInitialProduct(duplicate,duplicate,url),true);
 assert.equal(duplicate.productHtml.complete,false);
 const different={...duplicate,productHtml:{...duplicate.productHtml,headings:[...duplicate.productHtml.headings,{level:1,text:'Red Shirt'}]}};
 assert.equal(matchesInitialProduct(different,duplicate,url),false);
 assert.equal(matchesInitialProduct({...duplicate,canonical:''},duplicate,url),false);
});

test('a rejected response with stalled cancellation cannot hold supporting inspection', {timeout:1000}, async()=>{
 const rendered=await parse('Blue Shirt');
 let cancelled=false;
 const invalid=new Response(new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}}),
   {headers:{'content-type':'text/plain'}});
 const result=await gatherInitialSupport({url},rendered,{HTMLRewriter:HtmlTestRewriter,egress:{async fetch(target){
   return target===url ? invalid : new Response(null,{status:404});
 }}});
 assert.equal(cancelled,true);
 assert.equal(result.initialExtracted,null);
 assert.equal(result.support.crawlerPolicy.httpStatus,404);
});
