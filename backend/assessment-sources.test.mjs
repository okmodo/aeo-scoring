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
