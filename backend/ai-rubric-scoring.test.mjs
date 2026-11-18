import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRubricAssessment } from './ai-rubric-scoring.mjs';

const ref = { url: 'https://shop.test/item', location: 'description', excerpt: 'A durable travel bag.' };
const judgment = fraction => ({ status: 'measured', fraction, evidence: [ref] });
const inputs = () => ({ snapshot: { url: ref.url }, extracted: { productHtml: { complete: true, sourceObservation: { complete: true } } }, addEvidence: () => 'e1' });

test('semantic meaning adjusts eligible content with grounded evidence', () => {
  const checks = { 'C1.explanation': { status: 'measured', fraction: 0.5 } };
  applyRubricAssessment(checks, { findings: { 'C1.explanation': judgment(1) } }, inputs());
  assert.equal(checks['C1.explanation'].fraction, 1);
  assert.deepEqual(checks['C1.explanation'].evidenceIds, ['e1']);
});

test('semantic judgments cannot repair technical failures or invent exclusions', () => {
  const checks = {
    'S2.syntax': { status: 'measured', fraction: 0 },
    'S2.entity': { status: 'measured', fraction: 0 },
    'S3.price': { status: 'measured', fraction: 0 },
    'S7.links': { status: 'not_measured' },
    'S5.search': { status: 'measured', fraction: 0 },
    'C1.configuration': { status: 'not_applicable', rule: 'single_configuration' },
  };
  const before = structuredClone(checks);
  applyRubricAssessment(checks, { findings: Object.fromEntries(Object.keys(checks).map(id => [id, judgment(1)])) }, inputs());
  for (const id of Object.keys(checks)) assert.equal(checks[id].fraction, before[id].fraction, id);
  assert.equal(checks['C1.configuration'].status, 'not_applicable');
});

test('incomplete extraction cannot become a measured assessment', () => {
  const checks = { 'C1.explanation': { status: 'not_measured' } };
  const input = inputs(); input.snapshot.htmlLimited = 'bytes';
  applyRubricAssessment(checks, { findings: { 'C1.explanation': judgment(1) } }, input);
  assert.equal(checks['C1.explanation'].status, 'not_measured');
});

test('an unresolved judgment replaces heuristic credit and dynamic groups retain aggregate credit', () => {
  const checks = { 'C1.explanation': { status: 'measured', fraction: 1 }, 'C2.essential': { status: 'not_measured' }, 'C5.claim-support': { status: 'not_measured' } };
  applyRubricAssessment(checks, { findings: {
    'C1.explanation': { status: 'not_measured', reason: 'Ambiguous' },
    'C2.essential': { ...judgment(0.75), attributes: [{ id: 'fabric' }, { id: 'weight' }] },
    'C5.claim-support': { ...judgment(0.75), claims: [{ fraction: 1 }, { fraction: 0.5 }] },
  } }, inputs());
  assert.equal(checks['C1.explanation'].status, 'not_measured');
  assert.equal(checks['C2.essential'].fraction, 0.75);
  assert.equal(checks['C5.claim-support'].fraction, 0.75);
});

test('explicit validated exclusion preserves its rule and evidence', () => {
  const checks = { 'C5.claim-support': { status: 'not_measured' } };
  applyRubricAssessment(checks, { findings: { 'C5.claim-support': {
    status: 'not_applicable', rule: 'no_material_claims', justification: 'No material claims were found.', evidence: [ref],
  } } }, inputs());
  assert.equal(checks['C5.claim-support'].rule, 'no_material_claims');
  assert.equal(checks['C5.claim-support'].evidence, 'e1');
});

test('full scoreAudit does not promote unverified structured fields or variant relationships', async () => {
  const { prepareAssessmentSources } = await import('./assessment-sources.mjs');
  const { validateRubricAssessment } = await import('./ai-rubric-assessment.mjs');
  const { scoreAudit } = await import('./scoring.mjs');
  const rubric = (await import('../config/rubric.v2.json', { with: { type: 'json' } })).default;
  const url = 'https://example.test/product';
  const groups = ['C2.essential','C2.supporting','C4.intended-use','C4.compatibility','C4.limitations','C4.selection'];
  const ids = rubric.criteria.flatMap(c => c.subchecks.map(s => s.id)).filter(id => !/^S[56]\./.test(id) && id !== 'S2.syntax' && !/^C[24]\./.test(id));
  for (const product of [
    { '@type':'Product', url, name:'Shoe', offers:{'@type':'Offer',availability:'InStock'}, sku:'local', isVariantOf:{'@id':'#family'} },
    { '@type':'Product', url, name:'Shoe', gtin12:'036000291453', offers:{'@type':'Offer',price:'12',priceCurrency:'USD',availability:'InStock'} },
    { '@type':'Product', name:'Shoe', offers:{'@type':'Offer',price:'12',priceCurrency:'USD',availability:'InStock'}, isVariantOf:{'@id':'#family'} },
  ]) {
    const snapshot = { url, observedAt:'2026-11-17T00:00:00Z', rawHtml:'<h1>Shoe</h1><p>Product description</p>' };
    const extracted = {coverage:{jsonLdTruncated:false},productHtml:{complete:true,identity:'Shoe',blocks:[{text:'Product description',location:'description'}]},jsonLd:[JSON.stringify({'@context':'https://schema.org',...product})]};
    const bundle = await prepareAssessmentSources(snapshot, extracted), source = bundle.sources.find(s=>s.scope==='product');
    const profile = {category:'Shoes',evidence:[{sourceId:source.id,quote:'Shoe'}],slots:groups.map((group,i)=>({id:`slot-${i}`,group,label:`Need ${i}`,relevance:'Relevant',full:'Complete detail',partial:'Partial detail',zero:'Missing detail',missingExpectation:'Provide detail'}))};
    const judgments = {judgments:[...ids,...profile.slots.map(s=>s.id)].map(id=>({id,status:'not_measured',fraction:null,reason:'Unknown',evidence:[]}))};
    for (const item of judgments.judgments.filter(j=>['S2.entity','S2.offer','S2.identifiers','S2.variants'].includes(j.id))) Object.assign(item,{status:'measured',fraction:1,reason:'Full',evidence:[{sourceId:source.id,quote:'Shoe'}]});
    const assessment = validateRubricAssessment(bundle,profile,judgments,{snapshot,extracted});
    for (const id of ['S2.entity','S2.offer','S2.identifiers','S2.variants']) assert.equal(assessment.findings[id].fraction,1,id);
    const baseline = scoreAudit(snapshot,extracted), assessed = scoreAudit(snapshot,extracted,{aiAssessment:assessment});
    const check = (report,id) => report.criteria.flatMap(c=>c.subchecks).find(s=>s.id===id);
    for (const id of ['S2.entity','S2.offer','S2.identifiers','S2.variants']) {
      const before=check(baseline,id), after=check(assessed,id);
      if (before.status === 'measured') assert.ok(after.status !== 'measured' || after.fraction <= before.fraction, id);
      else assert.notEqual(after.status,'measured',id);
    }
  }
});
