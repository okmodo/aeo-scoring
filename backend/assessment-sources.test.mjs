import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAssessmentSources, SECTION_BYTES } from './assessment-sources.mjs';
const url = 'https://example.test/product';
test('all captured bytes and extraction records are sectioned without the legacy 24KiB cutoff', async () => {
  const html = '<h1>Product</h1>' + 'é🦺'.repeat(12000) + '<p>LAST DECISIVE FACT</p>';
  const snapshot = {url, rawHtml:new TextEncoder().encode(html), policies:{returns:{state:'read',url:url+'/returns',extraction:{blocks:[{text:'Returns within 30 days.',location:'terms'}]}}}};
  const extracted = {productHtml:{blocks:[{text:'Unusual attribute in natural prose.',location:'description'}]}, jsonLd:['{"@type":"Product"}']};
  const bundle = await prepareAssessmentSources(snapshot,extracted);
  assert.equal(bundle.coverage.complete,true);
  assert.equal(bundle.sources.filter(s=>s.kind==='html').map(s=>s.text).join(''),html);
  assert.ok(bundle.sources.every(s=>new TextEncoder().encode(s.text).length<=SECTION_BYTES));
  assert.ok(bundle.sources.every(s=>!Object.hasOwn(s,'origin') && !Object.hasOwn(s,'method')));
  assert.ok(bundle.sources.some(s=>s.text.includes('LAST DECISIVE FACT')));
  assert.ok(bundle.sources.some(s=>s.scope==='returns' && s.text==='Returns within 30 days.'));
  assert.equal(new Set(bundle.sources.map(s=>s.id)).size,bundle.sources.length);
  assert.equal((await prepareAssessmentSources(structuredClone(snapshot),structuredClone(extracted))).sourceDigest,bundle.sourceDigest);
  assert.notEqual((await prepareAssessmentSources({...snapshot,url:url+'/different'},extracted)).sourceDigest,bundle.sourceDigest);
});
test('capture limits remain incomplete and invalid or oversized retained input is rejected', async()=>{
  const snapshot={url,rawHtml:'<h1>Captured</h1>',htmlLimited:'bytes'};
  assert.equal((await prepareAssessmentSources(snapshot,{})).coverage.complete,false);
  await assert.rejects(prepareAssessmentSources({url},{}),/Missing retained/);
  await assert.rejects(prepareAssessmentSources({url,rawHtml:new Uint8Array([255])},{}));
  await assert.rejects(prepareAssessmentSources({url,rawHtml:'a'.repeat(1024*1024+1)},{}),/limit/);
  await assert.rejects(prepareAssessmentSources(snapshot,{oversize:'a'.repeat(4*1024*1024)}),/limit/);
});
test('browser captures retain separate initial and rendered evidence with deterministic provenance',async()=>{
  const snapshot={url,rawHtml:'<h1>Initial shell</h1>',browser:{version:'v1',initialExtracted:{title:'Initial shell'},renderedHtml:'<h1>Rendered product</h1><p>Only after render.</p>',selectedVariant:{value:'Blue'},coverage:{complete:true,initialLimited:false,renderedLimited:false}}};
  const extracted={productHtml:{blocks:[{text:'Only after render.',location:'description'}]}};
  const bundle=await prepareAssessmentSources(snapshot,extracted);
  assert.equal(bundle.coverage.complete,true);
  assert.equal(bundle.coverage.initial,true);
  assert.ok(bundle.sources.every(s=>s.method === (s.origin==='rendered' ? 'rendered' : 'raw')));
  assert.ok(bundle.sources.some(s=>s.kind==='support' && s.scope==='support' && s.origin==='shared'));
  assert.ok(bundle.sources.some(s=>s.kind==='html' && s.origin==='initial' && s.text.includes('Initial shell')));
  assert.ok(bundle.sources.some(s=>s.kind==='html' && s.origin==='rendered' && s.text.includes('Only after render.')));
  assert.ok(bundle.sources.some(s=>s.kind==='extracted' && s.origin==='initial' && s.text.includes('Initial shell')));
  assert.ok(bundle.sources.some(s=>s.kind==='text' && s.origin==='rendered' && s.text==='Only after render.'));
  assert.ok(bundle.sources.filter(s=>s.origin==='shared').every(s=>!s.text.includes('Only after render.') && !s.text.includes('Initial shell')));
  assert.equal((await prepareAssessmentSources(structuredClone(snapshot),structuredClone(extracted))).sourceDigest,bundle.sourceDigest);
  const changed=structuredClone(snapshot);changed.browser.renderedHtml+=' additional content';
  assert.notEqual((await prepareAssessmentSources(changed,extracted)).sourceDigest,bundle.sourceDigest);
});
test('partial, absent or oversized rendered captures cannot claim complete inspection',async()=>{
  const base={url,rawHtml:'initial',browser:{renderedHtml:'rendered',initialExtracted:{},coverage:{complete:true,initialLimited:false,renderedLimited:false}}};
  for (const coverage of [{complete:false,initialLimited:false,renderedLimited:false},{complete:true,initialLimited:true,renderedLimited:false},{complete:true,initialLimited:false,renderedLimited:true},{}]) {
    const bundle=await prepareAssessmentSources({...base,browser:{...base.browser,coverage}},{});
    assert.equal(bundle.coverage.complete,false);
    assert.equal(bundle.coverage.scopes.product,false);
    assert.equal(bundle.coverage.initial,coverage.initialLimited === false);
  }
  await assert.rejects(prepareAssessmentSources({...base,browser:{...base.browser,renderedHtml:null}},{}),/Invalid retained browser/);
  await assert.rejects(prepareAssessmentSources({...base,browser:{...base.browser,renderedHtml:'x'.repeat(1024*1024+1)}},{}),/limit/);
});
test('browser product sources use scoped visible extraction and only associated initial schema',async()=>{
  const product={'@context':'https://schema.org','@type':'Product',name:'Example product',url,weight:'1 kg'};
  const initialExtracted={productHtml:{complete:true,identity:{mainH1:'Example product'},structuredRecords:[]},coverage:{jsonLdTruncated:false},jsonLd:[JSON.stringify(product)]};
  const snapshot={url,rawHtml:'initial',browser:{renderedHtml:'<main><p hidden>Hidden claim</p><aside>Recommended item</aside><h1>Example product</h1></main>',initialExtracted,coverage:{complete:true,initialLimited:false,renderedLimited:false}}};
  const extracted={productHtml:{blocks:[{text:'Visible description',location:'rendered:1'}],headings:[{text:'Example product',location:'rendered:2'}],selectedControls:[{value:'Blue',location:'rendered:3'}],images:[{alt:'Front view',location:'rendered:4'}]}};
  const bundle=await prepareAssessmentSources(snapshot,extracted);
  const visible=bundle.sources.filter(s=>s.kind==='text' && s.origin==='rendered');
  assert.deepEqual(visible.map(s=>s.text),['Visible description','Example product','Blue','Front view']);
  assert.ok(visible.every(s=>!s.text.includes('Hidden claim') && !s.text.includes('Recommended item')));
  const associated=bundle.sources.find(s=>s.kind==='structured_product');
  assert.ok(associated);assert.equal(associated.origin,'initial');assert.equal(associated.method,'raw');assert.equal(associated.scope,'product');assert.equal(JSON.parse(associated.text).weight,'1 kg');
  for (const change of [p=>p.browser.initialExtracted.jsonLd.push(JSON.stringify(product)),p=>p.browser.initialExtracted.jsonLd.push('{invalid'),p=>p.browser.coverage.initialLimited=true,p=>p.htmlLimited='bytes']) {
    const bad=structuredClone(snapshot);change(bad);
    assert.ok(!(await prepareAssessmentSources(bad,extracted)).sources.some(s=>s.kind==='structured_product'));
  }
});

test('content API capture retains one rendered HTML document with replayable provenance',async()=>{
  const html='<main><h1>Example</h1><p>Product detail</p></main>';
  const snapshot={url,retrievalMethod:'browser_api_content',rawHtml:html,browser:{version:'browser-content-v1',captureType:'content-api',initialExtracted:{productHtml:null,jsonLd:[],coverage:{html:false}},renderedHtml:html,coverage:{complete:true,initialAvailable:false,initialLimited:false,renderedLimited:false}}};
  const extracted={productHtml:{blocks:[{text:'Product detail',location:'visible block'}]}};
  const bundle=await prepareAssessmentSources(snapshot,extracted);
  assert.equal(bundle.coverage.complete,true); assert.equal(bundle.coverage.initial,false);
  assert.equal(bundle.sources.filter(s=>s.kind==='html').length,1);
  assert.equal(bundle.sources.find(s=>s.kind==='html').origin,'rendered');
  assert.ok(!bundle.sources.some(s=>s.origin==='initial' || s.kind==='structured_product'));
  assert.ok(!bundle.sources.filter(s=>s.kind==='metadata').some(s=>s.text.includes(html)));
  assert.match(bundle.sources.find(s=>s.kind==='text').location,/parsed rendered HTML/);
  assert.equal((await prepareAssessmentSources(structuredClone(snapshot),structuredClone(extracted))).sourceDigest,bundle.sourceDigest);
  await assert.rejects(prepareAssessmentSources({...snapshot,browser:{...snapshot.browser,renderedHtml:'different'}},extracted),/Invalid rendered-only/);
  const large='x'.repeat(4*1024*1024+1);
  await assert.rejects(prepareAssessmentSources({...snapshot,rawHtml:large,browser:{...snapshot.browser,renderedHtml:large}},extracted),/Assessment source limit/);
});

test('verified cleaned HTML is complete model input despite partial parser excerpts',async()=>{
  const html='<main><h1>Solar kettle</h1>'+('<p>Context</p>'.repeat(900))+'<p>LAST DECISIVE FACT</p></main>';
  const bytes=new TextEncoder().encode(html),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const preprocessing={version:'simplified-html-v1',representation:'cleaned_rendered_html',originalCapturePreserved:true,sourceObjectKey:'retained/00000000-0000-4000-8000-000000000000/11111111-1111-4111-8111-111111111111/html',sourceSha256:'a'.repeat(64),sourceBytes:bytes.length+100,outputBytes:bytes.length,outputSha256:digest};
  const snapshot={url,retrievalMethod:'browser_api_content',rawHtml:bytes,preprocessing,browser:{renderedHtml:html,initialExtracted:{},coverage:{complete:false,initialAvailable:false,initialLimited:false,renderedLimited:false}}};
  const extracted={productHtml:{complete:false,blocks:[{text:'ONLY FIRST PARSED BLOCK',location:'partial'}]}};
  const bundle=await prepareAssessmentSources(snapshot,extracted);
  assert.equal(bundle.coverage.complete,true);assert.equal(bundle.coverage.parserComplete,false);assert.equal(bundle.coverage.initial,false);assert.equal(bundle.coverage.visibility,'unknown');
  const sources=bundle.sources.filter(s=>s.scope==='product');
  assert.equal(sources.map(s=>s.text).join(''),html);assert.ok(sources.every(s=>s.kind==='html'&&s.preparedHtml===true&&s.origin==='rendered'));
  assert.ok(sources.at(-1).text.includes('LAST DECISIVE FACT'));
  assert.ok(!bundle.sources.some(s=>s.kind==='extracted'||s.kind==='text'));
  assert.equal((await prepareAssessmentSources(structuredClone(snapshot),structuredClone(extracted))).sourceDigest,bundle.sourceDigest);
  for (const changed of [{outputBytes:bytes.length+1},{outputSha256:'b'.repeat(64)},{sourceSha256:'not a hash'},{originalCapturePreserved:false}]) await assert.rejects(prepareAssessmentSources({...snapshot,preprocessing:{...preprocessing,...changed}},extracted),/cleaned HTML provenance/);
  assert.equal((await prepareAssessmentSources({...snapshot,htmlLimited:'bytes'},extracted)).coverage.complete,false);
  assert.equal((await prepareAssessmentSources({...snapshot,browser:{...snapshot.browser,coverage:{...snapshot.browser.coverage,renderedLimited:true}}},extracted)).coverage.complete,false);
  const ordinary={...snapshot};delete ordinary.preprocessing;
  assert.equal((await prepareAssessmentSources(ordinary,extracted)).coverage.complete,false);
});
