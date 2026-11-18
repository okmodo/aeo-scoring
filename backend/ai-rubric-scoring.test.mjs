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

test('conditional question exclusions require matching frozen conditions and evidence', () => {
  const input=inputs();
  const profile={slots:[{id:'fit',group:'C4.compatibility',applicability:'conditional',condition:'Requires a host device'}]};
  const absent={status:'not_applicable',rule:'category_conditions_absent',justification:'No host device is required.',evidence:[ref],conditions:[{questionId:'fit',condition:'Requires a host device',status:'absent',evidence:'No host device',location:'description',method:'raw'}]};
  const checks={'C4.compatibility':{status:'not_measured'}};
  applyRubricAssessment(checks,{profile,findings:{'C4.compatibility':absent}},input);
  assert.equal(checks['C4.compatibility'].status,'not_applicable');
  assert.equal(checks['C4.compatibility'].rule,'category_conditions_absent');
  const invalid={...absent,conditions:[{...absent.conditions[0],condition:'Different condition'}]};
  applyRubricAssessment(checks,{profile,findings:{'C4.compatibility':invalid}},input);
  assert.equal(checks['C4.compatibility'].status,'not_measured');
  applyRubricAssessment(checks,{profile,findings:{'C4.compatibility':{status:'not_measured',reason:'Condition unknown'}}},input);
  assert.equal(checks['C4.compatibility'].status,'not_measured');
});

test('C4 exclusions redistribute only among applicable subchecks and all excluded stays incomplete', async () => {
  const { scoreReference } = await import('../scripts/scoring-foundations.mjs');
  const rubric={version:'2.0.0',criteria:[{id:'C4',maxPoints:10,subchecks:[{id:'C4.compatibility',maxPoints:4},{id:'C4.selection',maxPoints:6}]}]};
  const categories={categories:[{id:'open',decisionSupport:[{id:'fit',subcheckId:'C4.compatibility',applicability:'conditional',condition:'Requires host'}, {id:'select',subcheckId:'C4.selection',applicability:'conditional',condition:'Has choices'}]}]};
  const exclusion=(questionId,condition)=>({status:'not_applicable',rule:'category_conditions_absent',justification:'Condition absent',conditions:[{questionId,condition,status:'absent',evidence:'e1',location:'description',method:'raw'}]});
  const checks={'C4.compatibility':exclusion('fit','Requires host'),'C4.selection':{status:'measured',fraction:0.5,evidence:'e2'}};
  const partial=scoreReference(rubric,categories,{category:'open',checks});
  assert.equal(partial.criteria.C4.points,5); assert.equal(partial.status,'complete');
  checks['C4.selection']=exclusion('select','Has choices');
  assert.equal(scoreReference(rubric,categories,{category:'open',checks}).status,'incomplete');
  checks['C4.compatibility'].conditions[0].condition='Wrong';
  assert.throws(()=>scoreReference(rubric,categories,{category:'open',checks}),/Unjustified category exclusion/);
});

test('required AI assessment withholds heuristic content after an unavailable or forged assessment', async () => {
  const { scoreAudit } = await import('./scoring.mjs');
  const snapshot={url:'https://example.test/item',observedAt:'2026-11-17T00:00:00Z'};
  const extracted={coverage:{jsonLdTruncated:false},jsonLd:[],productHtml:{complete:true,identity:'Acme Trail Shoe',blocks:[{text:'This trail shoe protects feet on rocky paths.',location:'description'}],links:[]}};
  const previous=scoreAudit(snapshot,extracted,{category:'running-shoes'});
  assert.ok(previous.criteria.find(c=>c.id==='C1').subchecks.some(c=>c.status==='measured'));
  for (const aiAssessment of [null,{version:'1',findings:{}}]) {
    const result=scoreAudit(snapshot,extracted,{category:'running-shoes',requireAiAssessment:true,aiAssessment});
    assert.equal(result.score,null); assert.equal(result.category,null);
    for (const c of result.criteria.filter(c=>c.id.startsWith('C'))) for (const check of c.subchecks) assert.equal(check.status,'not_measured',check.id);
  }
});

test('validated absent C4 condition reaches scoreAudit category registry', async () => {
  const { prepareAssessmentSources } = await import('./assessment-sources.mjs');
  const { validateRubricAssessment } = await import('./ai-rubric-assessment.mjs');
  const { scoreAudit } = await import('./scoring.mjs');
  const rubric=(await import('../config/rubric.v2.json',{with:{type:'json'}})).default;
  const snapshot={url:'https://example.test/item',observedAt:'2026-11-17T00:00:00Z',rawHtml:'<h1>Solar kettle</h1><p>Six cups</p>'};
  const extracted={coverage:{jsonLdTruncated:false},jsonLd:[],productHtml:{complete:true,blocks:[{text:'Solar kettle',location:'heading'}]}};
  const bundle=await prepareAssessmentSources(snapshot,extracted), source=bundle.sources.find(s=>s.scope==='product');
  const groups=['C2.essential','C2.supporting','C4.intended-use','C4.compatibility','C4.limitations','C4.selection'];
  const profile={category:'Solar kettle',evidence:[{sourceId:source.id,quote:'Solar kettle'}],slots:groups.map((group,i)=>({id:`slot-${i}`,group,label:`Need ${i}`,relevance:'Relevant',full:'Complete value',partial:'Partial value',zero:'Missing value',missingExpectation:'Provide value'}))};
  const slot=profile.slots.find(s=>s.group==='C4.compatibility');
  Object.assign(slot,{applicability:'conditional',condition:'Product requires external power',conditionWhy:'Electrical compatibility applies only when power is required'});
  profile.conditionReview=[{id:slot.id,valid:true,reason:'The condition describes an actual product property.'}];
  const direct=rubric.criteria.flatMap(c=>c.subchecks.map(s=>s.id)).filter(id=>!/^S[56]\./.test(id) && id!=='S2.syntax' && !/^C[24]\./.test(id));
  const judgments={judgments:[...direct,...profile.slots.map(s=>s.id)].map(id=>({id,status:'not_measured',fraction:null,reason:'Unknown',evidence:[]}))};
  Object.assign(judgments.judgments.find(x=>x.id===slot.id),{status:'not_applicable',fraction:null,rule:'category_conditions_absent',reason:'No external power applies',evidence:[{sourceId:source.id,quote:'Solar kettle'}]});
  const inspections=bundle.sources.map(s=>({sourceId:s.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],conditions:[{id:slot.id,status:'absent',evidence:[]}],checks:[...direct,...profile.slots.map(x=>x.id)].map(id=>({id,status:'absent',evidence:[]}))}));
  const assessment=validateRubricAssessment(bundle,profile,judgments,{snapshot,extracted,inspections,supportInspections:[]});
  assert.equal(assessment.findings['C4.compatibility'].status,'not_applicable');
  const report=scoreAudit(snapshot,extracted,{aiAssessment:assessment});
  assert.equal(report.criteria.find(c=>c.id==='C4').subchecks.find(s=>s.id==='C4.compatibility').status,'not_applicable');
  assert.equal(report.score,null);
});

test('validated claim assessments replace legacy C5 assumptions in both directions', () => {
  const checks={'C5.claim-support':{status:'not_applicable',rule:'no_material_claims'}};
  applyRubricAssessment(checks,{findings:{'C5.claim-support':judgment(0.5)}},inputs());
  assert.equal(checks['C5.claim-support'].status,'measured'); assert.equal(checks['C5.claim-support'].fraction,0.5);
  const absence={status:'not_applicable',rule:'no_material_claims',justification:'No claims in complete inspection.',evidence:[ref]};
  applyRubricAssessment(checks,{findings:{'C5.claim-support':absence}},inputs());
  assert.equal(checks['C5.claim-support'].status,'not_applicable');
});

test('complete 40+60 rubric preserves conditional redistribution and recoverable deduction', async () => {
  const { scoreReference } = await import('../scripts/scoring-foundations.mjs');
  const rubric=(await import('../config/rubric.v2.json',{with:{type:'json'}})).default;
  const categories={categories:[{id:'open',decisionSupport:[{id:'host',subcheckId:'C4.compatibility',applicability:'conditional',condition:'Requires host device'}]}]};
  const checks=Object.fromEntries(rubric.criteria.flatMap(c=>c.subchecks.map(s=>[s.id,{status:'measured',fraction:1,evidence:'e1'}])));
  checks['C4.compatibility']={status:'not_applicable',rule:'category_conditions_absent',justification:'No host device.',conditions:[{questionId:'host',condition:'Requires host device',status:'absent',evidence:'e1',location:'product',method:'raw'}]};
  const complete=scoreReference(rubric,categories,{category:'open',checks});
  assert.equal(complete.status,'complete'); assert.equal(complete.finalScore,100);
  assert.equal(rubric.criteria.filter(c=>c.pillar==='structure').reduce((n,c)=>n+complete.criteria[c.id].points,0),40);
  assert.equal(rubric.criteria.filter(c=>c.pillar==='content').reduce((n,c)=>n+complete.criteria[c.id].points,0),60);
  checks['C4.selection'].fraction=0.75;
  const partial=scoreReference(rubric,categories,{category:'open',checks});
  const criterion=rubric.criteria.find(c=>c.id==='C4'), subcheck=criterion.subchecks.find(s=>s.id==='C4.selection');
  const recovery=subcheck.maxPoints*0.25*criterion.maxPoints/partial.criteria.C4.denominator;
  assert.ok(recovery>0); assert.ok(Math.abs(partial.finalScore+recovery-100)<1e-9);
});
