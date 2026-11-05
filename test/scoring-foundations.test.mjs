import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateFoundations, scoreReference, deliveryFraction} from '../scripts/scoring-foundations.mjs';
const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url)));
const rubric=read('config/rubric.v1.json'), categories=read('config/categories.v1.json'), crawlers=read('config/crawlers.v1.json'), fixtures=read('evals/fixtures/scoring/reference.v1.json');
const ids=categories.categories.map(c=>c.id);
test('foundations have valid totals, anchors, category mappings and crawler pools',()=>assert.deepEqual(validateFoundations(rubric,categories,crawlers),[]));
for (const fixture of fixtures.cases) test(`frozen reference: ${fixture.id}`,()=>{
  const actual=scoreReference(rubric,categories,fixture.input), expected=fixture.expected;
  assert.equal(actual.status,expected.status); assert.equal(actual.finalScore,expected.finalScore); assert.equal(actual.earnedPoints,expected.earnedPoints);
  for (const [id,points] of Object.entries(expected.criterionPoints ?? {})) assert.equal(actual.criteria[id].points,points);
  for (const [id,denominator] of Object.entries(expected.denominator ?? {})) assert.equal(actual.criteria[id].denominator,denominator);
});
test('raw and rendered delivery are distinct and failed rendering is unknown',()=>{
  assert.equal(deliveryFraction('initial'),1); assert.equal(deliveryFraction('rendered'),.5); assert.equal(deliveryFraction('state_blob'),0); assert.equal(deliveryFraction('interaction'),0); assert.equal(deliveryFraction('unmeasured'),null); assert.throws(()=>deliveryFraction('guess'));
});
test('unknown category withholds overall assessment',()=>{
  const input=structuredClone(fixtures.cases[0].input); input.category='unknown'; const result=scoreReference(rubric,categories,input); assert.equal(result.finalScore,null); assert.equal(result.criteria.C2.complete,false); assert.equal(result.criteria.C2.points,0); assert.equal(result.criteria.C4.complete,false); assert.equal(result.criteria.C4.points,0); assert.equal(result.earnedPoints,70);
});
test('unjustified exclusions and deductions are rejected',()=>{
  const input=structuredClone(fixtures.cases[0].input); input.checks['S1.price']={status:'not_applicable',rule:'invented',justification:'none'}; assert.throws(()=>scoreReference(rubric,categories,input));
  input.checks['S1.price']={status:'measured',fraction:0}; assert.throws(()=>scoreReference(rubric,categories,input));
});
test('empty criterion withholds instead of redistributing across pillars',()=>{
  const r=structuredClone(rubric), input=structuredClone(fixtures.cases[0].input); r.criteria.find(c=>c.id==='C5').subchecks=r.criteria.find(c=>c.id==='C5').subchecks.filter(s=>s.id==='C5.claim-support'); delete input.checks['C5.consistency']; input.checks['C5.claim-support']={status:'not_applicable',rule:'no_material_claims',justification:'No material claims'}; const result=scoreReference(r,categories,input); assert.equal(result.finalScore,null); assert.equal(result.criteria.C5.denominator,0);
});
test('crawler policy examples preserve unscored training and user-triggered bots',()=>{
  for (const example of crawlers.policyExamples) {
    let points=0, complete=true;
    for (const pool of Object.values(crawlers.scoring)) for (const id of pool.botIds) {
      const observation=example.observations.find(o=>o.botId===id);
      if (!observation || observation.status==='not_measured') {complete=false; continue;}
      assert.ok(['allowed','disallowed'].includes(observation.status)); if (observation.status==='allowed') points+=pool.points/pool.botIds.length;
    }
    assert.equal(complete,example.expectedComplete); if (complete) assert.ok(Math.abs(points-example.expectedPoints)<1e-12); else assert.equal(example.expectedPoints,null);
  }
});
test('conditional C4 exclusions require every exact template condition and observed absence',()=>{
  const input=structuredClone(fixtures.cases.find(c=>c.id==='conditional-c4-partial').input);
  const entry=input.checks['C4.limitations'];
  for (const change of [e=>delete e.conditions[0].evidence, e=>delete e.conditions[0].location, e=>delete e.conditions[0].method, e=>e.conditions[0].status='unknown', e=>e.conditions[0].questionId='invented', e=>e.conditions[0].condition='different', e=>e.conditions=[]]) {
    const candidate=structuredClone(input); change(candidate.checks['C4.limitations']); assert.throws(()=>scoreReference(rubric,categories,candidate));
  }
  const unknown=structuredClone(input); unknown.checks['C4.limitations']={status:'not_measured'}; assert.equal(scoreReference(rubric,categories,unknown).finalScore,null);
  const always=structuredClone(input); always.checks['C4.intended-use']=structuredClone(entry); assert.throws(()=>scoreReference(rubric,categories,always));
});
test('schema validation policy is versioned and pins the supported formats',()=>{
  const p=rubric.schemaValidationPolicy; assert.equal(p.version,'1.0.0'); assert.deepEqual(p.formats,['JSON-LD','microdata','RDFa']); for (const k of ['entity','coreProperties','offer','identifiers','variants','delivery','provenance']) assert.ok(p[k]); assert.ok(p.sourceUrls.length);
});

test('version 1.1 clarifies only the basic T-shirt care anchor and preserves v1', () => {
  const v1 = read('config/categories.v1.json'), v11 = read('config/categories.v1.1.json');
  assert.equal(v1.version, '1.0.0'); assert.equal(v11.version, '1.1.0');
  const care = registry => registry.categories.find(c => c.id === 'basic-tshirts').supportingAttributes.find(a => a.id === 'care');
  assert.equal(care(v1).full, 'Specific regular washing and drying or other care instructions are given.');
  assert.match(care(v11).full, /Specific applicable regular care instructions/);
  assert.match(care(v11).full, /Washing guidance alone can satisfy this/);
  assert.match(care(v11).full, /not both universally required/);
  care(v11).full = care(v1).full;
  v11.version = v1.version;
  assert.deepEqual(v11, v1);
});
