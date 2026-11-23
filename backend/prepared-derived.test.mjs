import test from 'node:test';
import assert from 'node:assert/strict';
import {derivePreparedObservations, isPreparedObservations, MAX_DERIVED_HTML_BYTES} from './prepared-derived.mjs';
import {HtmlTestRewriter} from './html-product-test-helper.mjs';
import {scoreAudit} from './scoring.mjs';
const encoder=new TextEncoder();
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function inputFor(html){
 const p={version:'simplified-html-v1',representation:'cleaned_rendered_html',originalCapturePreserved:true,outputBytes:encoder.encode(html).length,outputSha256:await hash(html)};
 const prepared={version:'1',html,preprocessing:p},json=JSON.stringify(prepared),preparedHash=await hash(json);
 return {snapshot:{url:'https://example.com/item',observedAt:'2026-11-20T00:00:00Z',retrievalMethod:'browser_api_content',preprocessing:p,browser:{renderedHtml:html,initialExtracted:{coverage:{html:false}}}},prepared,source:{preparedHash,sha256:preparedHash,bytes:encoder.encode(json).length,objectKey:'retained/item/prepared'}};
}
test('derives complete prepared pages and binds observations to unchanged source and results', async () => {
 const input=await inputFor('<main><h1>Solar kettle</h1><p>'+('x'.repeat(435704))+'</p></main>');
 const result=await derivePreparedObservations(input,{HTMLRewriter:HtmlTestRewriter});
 assert.ok(result.productHtml);assert.equal(isPreparedObservations(result,input.snapshot),true);
 assert.equal(isPreparedObservations(result,{...input.snapshot}),false);assert.equal(isPreparedObservations({...result},input.snapshot),false);
 result.title='forged';assert.equal(isPreparedObservations(result,input.snapshot),false);
 const second=await derivePreparedObservations(input,{HTMLRewriter:HtmlTestRewriter});input.snapshot.url='https://example.com/other';assert.equal(isPreparedObservations(second,input.snapshot),false);
 const forged=await inputFor('<main><h1>Item</h1></main>');forged.prepared.html+='changed';assert.equal(await derivePreparedObservations(forged,{HTMLRewriter:HtmlTestRewriter}),null);
 const oversized=await inputFor('x'.repeat(MAX_DERIVED_HTML_BYTES+1));assert.equal(await derivePreparedObservations(oversized,{HTMLRewriter:HtmlTestRewriter}),null);
});
test('derived HTML does not erase independently verified sitemap observations',async()=>{
 const input=await inputFor('<html><head><title>Solar kettle</title></head><body><main><h1>Solar kettle</h1></main></body></html>');
 input.snapshot.crawlerPolicy={version:'1.0.0',httpStatus:200,url:'https://example.com/robots.txt',observations:['googlebot','bingbot','oai-searchbot','claude-searchbot','perplexitybot','gptbot'].map(botId=>({botId,status:'allowed'}))};
 input.snapshot.sitemap={complete:true,usableSource:'https://example.com/sitemap.xml',inclusionSource:'https://example.com/sitemap.xml'};
 const result=await derivePreparedObservations(input,{HTMLRewriter:HtmlTestRewriter});
 const report=scoreAudit(input.snapshot,{}, {initialExtracted:input.snapshot.browser.initialExtracted,deterministicExtracted:result,requireAiAssessment:true});
 const checks=report.criteria.flatMap(c=>c.subchecks);
 for(const id of ['S5.search','S5.ai-retrieval','S6.usable','S6.inclusion'])assert.equal(checks.find(c=>c.id===id).fraction,1);
});

test('hidden or unselected images and missing labels do not become rendered findings',async()=>{
 const input=await inputFor('<html><head><style>.hidden{display:none}</style></head><body><main><div class="hidden"><img alt="Solar kettle" src="hidden.jpg"></div><img alt="Unselected blue variant" src="blue.jpg"></main></body></html>');
 const derived=await derivePreparedObservations(input,{HTMLRewriter:HtmlTestRewriter});
 const report=scoreAudit(input.snapshot,{}, {initialExtracted:input.snapshot.browser.initialExtracted,deterministicExtracted:derived,requireAiAssessment:true});
 const checks=report.criteria.flatMap(c=>c.subchecks);
 for(const id of ['S4.title','S4.image-alternatives'])assert.equal(checks.find(c=>c.id===id).status,'not_measured');
});

test('prepared product evidence keeps the head title and only selected primary options',async()=>{
 const input=await inputFor('<html><head><title>Short - Stone | Shop</title></head><body><main><svg><title>Logo</title></svg><product-rerender id="product-info-main"><h1>Short - Stone</h1><variant-picker form-id="pf"><fieldset data-option-name="Color"><input type="radio" name="pf-option1" form="pf" data-option-position="1" value="321" data-option-name="Stone" checked></fieldset><fieldset data-option-name="Size"><input type="radio" name="pf-option2" form="pf" data-option-position="2" value="322" data-option-name="XS"></fieldset></variant-picker><sale-price><span>Sale price</span> $64</sale-price><div class="related"><input type="radio" name="other" data-option-name="Blue" checked></div><dialog><input type="radio" name="quick" data-option-name="XS" checked></dialog></product-rerender></main></body></html>');
 const result=await derivePreparedObservations(input,{HTMLRewriter:HtmlTestRewriter,keyed:true});
 assert.equal(result.productHtml.identity.title,'Short - Stone | Shop');
 assert.deepEqual(result.productHtml.keyedPrimary.filter(item=>item.kind==='selected-option').map(({name,value,text})=>({name,value,text})),[{name:'pf-option1',value:'321',text:'Stone'}]);
 assert.ok(result.productHtml.keyedPrimary.some(item=>item.tag==='sale-price' && item.text==='Sale price $64'));
});

test('selected option evidence rejects ambiguous groups and unrelated checked controls',async()=>{
 const input=await inputFor('<main><product-rerender id="product-info-main"><input type="checkbox" name="consent" data-option-name="yes" checked><input type="radio" name="pf-option3" data-option-name="pickup" checked><variant-picker form-id="pf"><fieldset data-option-name="Color"><input type="radio" name="pf-option1" form="pf" data-option-position="1" data-option-name="Stone" checked><input type="radio" name="pf-option1" form="pf" data-option-position="1" data-option-name="Blue" checked></fieldset><fieldset data-option-name="Gift wrapping"><input type="radio" name="pf-option2" form="pf" data-option-position="2" data-option-name="Gift" checked></fieldset><fieldset data-option-name="Size"><input type="radio" name="pf-option4" form="wrong" data-option-position="4" data-option-name="XS" checked></fieldset></variant-picker></product-rerender></main>');
 const result=await derivePreparedObservations(input,{HTMLRewriter:HtmlTestRewriter,keyed:true});
 assert.deepEqual(result.productHtml.keyedPrimary.filter(item=>item.kind==='selected-option'),[]);
});

test('keyed tag ordinals include excluded tags before and after the primary product',async()=>{
 const input=await inputFor('<html><body><header><input><sale-price>$99</sale-price></header><main><product-rerender id="product-info-main"><variant-picker form-id="pf"><fieldset data-option-name="Color"><input type="radio" name="pf-option1" form="pf" data-option-position="1" value="321" data-option-name="Stone" checked></fieldset></variant-picker><sale-price>$64</sale-price><div class="related"><input><sale-price>$64</sale-price></div></product-rerender></main><footer><input><sale-price>$10</sale-price></footer></body></html>');
 const result=await derivePreparedObservations(input,{HTMLRewriter:HtmlTestRewriter,keyed:true});
 const option=result.productHtml.keyedPrimary.find(item=>item.kind==='selected-option');
 const price=result.productHtml.keyedPrimary.find(item=>item.tag==='sale-price');
 assert.deepEqual([option.tagOrdinal,option.tagCount],[1,4]);
 assert.deepEqual([price.tagOrdinal,price.tagCount],[1,4]);
});

test('a text inventory limit preserves positive tag evidence after full traversal',async()=>{
 const inputs='<main><article class="product-detail"><sale-price>$64</sale-price>' +
  '<p>Product detail.</p>'.repeat(301) + '</article></main>';
 const result=await derivePreparedObservations(await inputFor(inputs),{HTMLRewriter:HtmlTestRewriter,keyed:true});
 assert.equal(result.productHtml.complete,false);
 const price=result.productHtml.keyedPrimary.find(item=>item.tag==='sale-price');
 assert.deepEqual([price.tagOrdinal,price.tagCount],[0,1]);
});

test('prepared title remains ambiguous with multiple head titles and keyed options require one primary scope',async()=>{
 const input=await inputFor('<html><head><title>One</title><title>Two</title></head><body><main><product-rerender id="product-info-one"><input type="radio" name="option1" data-option-name="Stone" checked></product-rerender><product-rerender id="product-info-two"><input type="radio" name="option1" data-option-name="Blue" checked></product-rerender></main></body></html>');
 const result=await derivePreparedObservations(input,{HTMLRewriter:HtmlTestRewriter,keyed:true});
 assert.equal(result.productHtml.identity.title,null);
 assert.deepEqual(result.productHtml.keyedPrimary,[]);
});
