import test from 'node:test';
import assert from 'node:assert/strict';
import {derivePreparedObservations} from './prepared-derived.mjs';
import {scorePreparedProductStructure} from './prepared-product-structure.mjs';
import {scoreAudit} from './scoring.mjs';
import {HtmlTestRewriter} from './html-product-test-helper.mjs';
const encoder=new TextEncoder();
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function fixture(html) {
 const p={version:'simplified-html-v1',representation:'cleaned_rendered_html',originalCapturePreserved:true,outputBytes:encoder.encode(html).length,outputSha256:await hash(html)};
 const prepared={version:'1',html,preprocessing:p}, json=JSON.stringify(prepared), digest=await hash(json);
 const snapshot={url:'https://example.com/item',observedAt:'2026-11-20T00:00:00Z',retrievalMethod:'browser_api_content',preprocessing:p,browser:{renderedHtml:html,initialExtracted:{coverage:{html:false}}}};
 const derived=await derivePreparedObservations({snapshot,prepared,source:{preparedHash:digest,sha256:digest,bytes:encoder.encode(json).length,objectKey:'retained/item/prepared'}},{HTMLRewriter:HtmlTestRewriter});
 return {snapshot,derived};
}
test('prepared structured observations survive missing AI and retain rendered provenance',async()=>{
 const markup=JSON.stringify({'@context':'https://schema.org','@type':'Product',url:'https://example.com/item',name:'Solar kettle',sku:'A1',offers:{'@type':'Offer',price:'25',priceCurrency:'USD',availability:'https://schema.org/InStock'}});
 const {snapshot,derived}=await fixture(`<html><head><script type="application/ld+json">${markup}</script></head><body><main><h1>Solar kettle</h1><p>Solar kettle for outdoor use.</p></main></body></html>`);
 const product=scorePreparedProductStructure(snapshot,derived);
 assert.equal(product['S2.entity'].fraction,1);
 assert.equal(product['S2.offer'].fraction,1);
 assert.equal(product['S2.identifiers'].fraction,0.5);
 assert.equal(scorePreparedProductStructure({...snapshot},derived),null);
 const support={'S7.identity':{status:'measured',fraction:1,url:snapshot.url,location:'site guide',excerpt:'Verified site guide.'}};
 const report=scoreAudit(snapshot,{}, {programmaticStructure:{product,support},requireAiAssessment:true});
 const components=report.criteria.flatMap(c=>c.subchecks.flatMap(s=>s.components));
 for(const id of ['S2.entity','S2.offer','S2.identifiers']) {
  const check=components.find(c=>c.id===id); assert.equal(check.fraction,product[id].fraction);
  assert.ok(check.evidenceIds.length); assert.ok(check.evidenceIds.every(ref=>report.evidence.find(e=>e.id===ref).method==='rendered'));
 }
 const guide=components.find(c=>c.id==='S7.identity');
 assert.equal(guide.fraction,1);
 assert.equal(report.evidence.find(e=>e.id===guide.evidenceIds[0]).method,'raw');
});

test('recognizes a page-matched ProductGroup despite incomplete text inventory and extra properties',async()=>{
 const group={'@context':'https://schema.org','@type':'ProductGroup',url:'https://example.com/item',name:'Solar kettle',productGroupID:'family',mainEntityOfPage:'https://example.com/item',variesBy:['https://schema.org/size'],hasVariant:[{'@type':'Product',size:'Small',url:'https://example.com/item?variant=1'},{'@type':'Product',size:'Large',url:'https://example.com/item?variant=2'}]};
 // The bounded text inventory truncates, while the complete JSON-LD remains available.
 const {snapshot,derived}=await fixture(`<html><head><script type="application/ld+json">${JSON.stringify(group)}</script></head><body><main><h1>Solar kettle</h1>${'<p>Product detail.</p>'.repeat(350)}</main></body></html>`);
 assert.equal(derived.productHtml.complete,false);
 const findings=scorePreparedProductStructure(snapshot,derived);
 assert.equal(findings['S2.syntax'].fraction,1);
 assert.equal(findings['S2.entity'].fraction,1);
 assert.equal(findings['S2.variants'].fraction,1);
 assert.equal(findings['S2.offer'].status,'not_measured');
 assert.equal(findings['S2.identifiers'].status,'not_measured');
});

test('a complete text inventory does not turn unknown ProductGroup comparisons into zeroes',async()=>{
 const group={'@context':'https://schema.org','@type':'ProductGroup',url:'https://example.com/item',name:'Solar kettle',productGroupID:'family',variesBy:['https://schema.org/size'],hasVariant:[{'@type':'Product',size:'Small'},{'@type':'Product',size:'Large'}]};
 const {snapshot,derived}=await fixture(`<html><head><script type="application/ld+json">${JSON.stringify(group)}</script></head><body><main><h1>Solar kettle</h1><p>Price: USD 25. In stock. Material: steel.</p></main></body></html>`);
 assert.equal(derived.productHtml.complete,true);
 const findings=scorePreparedProductStructure(snapshot,derived);
 assert.equal(findings['S3.identity'].fraction,1);
 for (const id of ['S3.price','S3.availability','S3.optional-claims']) {
  assert.equal(findings[id].status,'not_measured',id);
 }
});
