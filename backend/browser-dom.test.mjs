import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML, DOMParser} from 'linkedom';
import {captureProductDom} from './browser-dom.mjs';
const read = name => readFileSync(new URL(`./fixtures/browser-product/${name}.html`,import.meta.url),'utf8');
function run(initialHtml, renderedHtml, initialLimited = false) {
  const {document,Element} = parseHTML(renderedHtml);
  const previous = {document:globalThis.document, DOMParser:globalThis.DOMParser, getComputedStyle:globalThis.getComputedStyle};
  globalThis.document=document; globalThis.DOMParser=DOMParser;
  globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'});
  Element.prototype.getClientRects = () => [{}];
  Object.defineProperty(Element.prototype,'innerText',{get(){return this.textContent},configurable:true});
  try { return captureProductDom({initialHtml,initialLimited}); }
  finally { Object.assign(globalThis,previous); }
}
test('initial shell and rendered product retain distinct evidence and scoped selection',()=>{
  const result=run(read('initial'),read('rendered'));
  assert.ok(result.initialExtracted.productHtml.blocks.some(x=>x.text==='Loading product details.'));
  assert.ok(result.extracted.productHtml.blocks.some(x=>x.text==='Warm recycled fleece.'));
  assert.ok(result.extracted.productHtml.blocks.some(x=>x.text==='Care: machine wash cold.'));
  assert.ok(!result.extracted.productHtml.blocks.some(x=>x.text.includes('Different jacket')));
  assert.equal(result.extracted.productHtml.images[0].alt,'Front view');
  assert.equal(result.initialExtracted.jsonLd.length,1);
  assert.equal(result.initialExtracted.productHtml.selectedControls[0].value,'m');
  assert.equal(result.initialExtracted.productHtml.sourceObservation.complete,true);
  assert.equal(result.expanded,1);
});
test('limited source remains incomplete while rendered observations can be complete',()=>{
  const result=run(read('initial'),read('rendered'),true);
  assert.equal(result.initialExtracted.productHtml.sourceObservation.complete,false);
  assert.equal(result.extracted.productHtml.complete,true);
});
test('a large rendered document is retained as a bounded prefix',()=>{
  const result=run(read('initial'),read('rendered').replace('</body>','<!--'+ 'x'.repeat(1024*1024) +'--></body>'));
  assert.equal(result.renderedLimited,true);
  assert.ok(new TextEncoder().encode(result.renderedHtml).length <= 1024*1024);
  assert.ok(result.extracted.productHtml.blocks.some(x=>x.text==='Warm recycled fleece.'));
});

test('stability requires persistent product text',async()=>{
  const {waitForProductStability} = await import('./browser-dom.mjs');
  const {document,Element} = parseHTML(read('rendered'));
  Object.defineProperty(Element.prototype,'innerText',{get(){return this.textContent},configurable:true});
  const old=globalThis.document, oldStyle=globalThis.getComputedStyle; globalThis.document=document; globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'}); Element.prototype.getClientRects=()=>[{}];
  try {
    assert.equal((await waitForProductStability({maxMs:100,stableMs:10,intervalMs:5})).stable,true);
    document.querySelector('main').textContent='';
    assert.equal((await waitForProductStability({maxMs:20,stableMs:5,intervalMs:5})).stable,false);
  } finally { globalThis.document=old; globalThis.getComputedStyle=oldStyle; }
});
test('table specifications are retained and unhandled custom visible text prevents absence credit',()=>{
 const table=read('rendered').replace('</main>','<table><tr><th>Fabric</th><td>100% recycled polyester</td></tr></table></main>');
 const result=run(read('initial'),table);
 assert.ok(result.extracted.productHtml.blocks.some(b=>b.text==='100% recycled polyester'));
 const custom=run(read('initial'),table.replace('</main>','<product-extra>Water resistant finish</product-extra></main>'));
 assert.equal(custom.extracted.productHtml.complete,false);
 assert.equal(custom.extracted.productHtml.sourceObservation.complete,false);
});
