import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scoreAudit} from './scoring.mjs';
import {extract} from './retrieval.mjs';
import {HtmlTestRewriter} from './html-product-test-helper.mjs';
import {buildSemanticRequest,validateSemanticResponse} from './semantic-assessment.mjs';
const read = path => readFileSync(new URL(path,import.meta.url),'utf8');
async function fixture() {
 const snapshot={url:'https://shop.example/products/everyday-tshirt',observedAt:'2026-11-15T00:00:00.000Z',body:read('./fixtures/revised-s1-s2/complete-shirt-v2.html'),htmlLimited:null,...JSON.parse(read('./fixtures/complete-engine/support.json'))};
 const extracted=await extract(snapshot,{HTMLRewriter:HtmlTestRewriter});
 const prepared=buildSemanticRequest(snapshot,extracted,{category:'basic-tshirts',currency:'USD'});
 const semantic={...validateSemanticResponse(prepared,JSON.parse(read('./fixtures/complete-engine/reviewed-judgments.json'))),status:'assessed',model:'independently-reviewed-synthetic-judgments'};
 return {snapshot,extracted,semantic};
}
const fractions = r => r.criteria.flatMap(c=>c.subchecks.map(s=>({id:s.id,status:s.status,fraction:s.fraction,points:s.points})));
test('identical initial and rendered observations preserve every score and fix',async()=>{
 const {snapshot,extracted,semantic}=await fixture();
 const baseline=scoreAudit(snapshot,extracted,{semantic});
 const browser=scoreAudit({...snapshot,retrievalMethod:'browser'},extracted,{semantic,initialExtracted:extracted});
 assert.deepEqual(fractions(browser),fractions(baseline));
 assert.deepEqual(browser.score,baseline.score);assert.deepEqual(browser.fixes,baseline.fixes);
 assert.equal(browser.engineVersion,baseline.engineVersion);assert.equal(browser.rubricVersion,baseline.rubricVersion);
 assert.ok(browser.evidence.some(e=>e.method==='rendered'));
});
test('client-added Product schema cannot earn initial-response S2 credit',async()=>{
 const {snapshot,extracted,semantic}=await fixture();
 const initial=structuredClone(extracted);initial.jsonLd=[];
 const browser=scoreAudit({...snapshot,retrievalMethod:'browser'},extracted,{semantic,initialExtracted:initial});
 const source=scoreAudit(snapshot,initial,{semantic});
 const checks=(r,id)=>r.criteria.find(c=>c.id===id).subchecks.map(s=>({id:s.id,status:s.status,fraction:s.fraction}));
 assert.deepEqual(checks(browser,'S2'),checks(source,'S2'));
 assert.ok(browser.evidence.filter(e=>browser.criteria.find(c=>c.id==='S2').subchecks.some(s=>s.evidenceIds.includes(e.id))).every(e=>e.method==='raw'));
});
test('nested rendered references retain rendered provenance and external policies remain raw',async()=>{
 const {snapshot,extracted,semantic}=await fixture();
 const r=scoreAudit({...snapshot,retrievalMethod:'browser'},extracted,{semantic,initialExtracted:extracted});
 const contentIds=new Set(r.criteria.filter(c=>c.id.startsWith('C')).flatMap(c=>c.subchecks.flatMap(s=>s.evidenceIds)));
 const content=r.evidence.filter(e=>contentIds.has(e.id)&&e.url===snapshot.url);
 assert.ok(content.length>3);assert.ok(content.every(e=>e.method==='rendered'));
 assert.ok(r.evidence.some(e=>e.url!==snapshot.url&&e.method==='raw'));
});
test('frozen retained capture resumes deterministic assessment without another product request',()=>{
 const input=JSON.parse(read('./fixtures/browser-product/retained-capture.json'));
 const result=scoreAudit(input.snapshot,input.extracted,{initialExtracted:input.snapshot.browser.initialExtracted});
 const historical=JSON.parse(read('./fixtures/browser-product/replay-report.json'));
 assert.equal(historical.engineVersion,'2.2.0');
 // Candidate preparation changes the release/cache revision only. Keep every
 // frozen score, finding, evidence reference and fix unchanged in this replay.
 assert.deepEqual(result,{...historical,engineVersion:'2.2.1'});
 assert.equal(result.status,'incomplete');assert.equal(result.score,null);
 assert.ok(input.snapshot.browser.renderedHtml.includes('Warm recycled fleece'));
 assert.ok(!input.rawHtml.includes('Warm recycled fleece'));
});
