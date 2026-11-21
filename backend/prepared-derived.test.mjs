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
