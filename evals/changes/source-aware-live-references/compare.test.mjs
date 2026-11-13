import { referenceShirtResponse } from '../../../backend/fixtures/content-facts/reference-shirt.mjs';
import { buildSemanticRequest } from '../../../backend/semantic-assessment.mjs';
import { inspectProductSchema } from '../../../backend/structure-assessment.mjs';
import { buildContentFactsRequest, decodeContentFacts } from '../../../backend/content-facts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import cases from '../selected-variant-evidence/synthetic-cases.json' with { type: 'json' };
import approved from './approved-alternatives.json' with { type: 'json' };
import { compareFrozen, sourceHash } from './compare.mjs';
for (const item of cases) {
  const prepared = buildSemanticRequest(item.snapshot, item.extracted, item.report, { product: inspectProductSchema(item.snapshot, item.extracted).product });
  item.request = buildContentFactsRequest(prepared);
  item.requestHash = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(item.request)).digest('hex');
}
const manifest = approved.cases.map((entry, i) => ({ ...entry, requestHash: cases[i].requestHash }));
function sample(id, alternative) {
  const item = structuredClone(cases.find(c => c.id === id));
  const payload = JSON.parse(item.request.messages[1].content);
  const checks = item.expected.checks;
  const findings = Object.fromEntries(Object.entries(checks).map(([key,value]) => [key, typeof value === 'number' ? { status: 'measured', fraction: value } : { status: value }]));
  const raw = { roles: Object.fromEntries(payload.candidates.map(c => [c.roleId, []])), inspections: [], conditionChecks: Object.fromEntries(payload.conditionKeys.map(key => [key, 'unknown'])) };
  raw.conditionChecks[alternative.conditionKey] = 'absent';
  for (const ref of item.expected.facts) {
    const observation=payload.observations.find(o => o.scope === ref.scope && o.text === ref.text);
    const candidate=payload.candidates.find(c => c.kind === ref.kind && c.key === ref.key && c.ids.includes(observation?.id));
    if (candidate && !raw.roles[candidate.roleId].includes(observation.id)) raw.roles[candidate.roleId].push(observation.id);
  }
  findings[alternative.check] = { status: 'not_applicable', rule: alternative.rule, justification: alternative.rule === 'no_material_claims' ? 'Complete product content contained no identified material claims requiring substantiation.' : 'All conditional category questions were inspected and their conditions were absent.' };
  const prepared = buildSemanticRequest(item.snapshot, item.extracted, item.report, { product: inspectProductSchema(item.snapshot, item.extracted).product });
  const facts = decodeContentFacts(prepared, item.request, raw, { requireConditionChecks: true, requireRoleSlots: true });
  const result = { assessmentResult: { status: 'assessed', facts }, grade: { findings }, modelCalls: [{ invoked: true, input: item.request, inputHash: item.requestHash, output: { response: JSON.stringify(raw) } }] };
  return { item, result, raw };
}
for (const entry of approved.cases) for (const alternative of entry.alternatives) test(`${entry.caseId} ${alternative.check} requires all source-bound absence proofs`, () => {
  const { item, result, raw } = sample(entry.caseId, alternative);
  assert.equal(sourceHash(item), entry.sourceHash);
  assert.equal(compareFrozen(item.id, result, item, manifest), true);
  const mutations = [
    r => { r.modelCalls[0].inputHash = '0'.repeat(64); },
    r => { r.modelCalls[0].input.max_tokens++; },
    r => { r.modelCalls[0].invoked = false; },
    r => { const value=JSON.parse(r.modelCalls[0].output.response); const slot=Object.keys(value.roles).find(k=>value.roles[k].length); value.roles[slot]=[]; r.modelCalls[0].output.response=JSON.stringify(value); },
    r => { r.modelCalls[0].output.response = JSON.stringify({ conditionChecks: { ...raw.conditionChecks, [alternative.conditionKey]: 'unknown' } }); },
    r => { r.modelCalls[0].output.response = JSON.stringify({ conditionChecks: { ...raw.conditionChecks, extra: 'absent' } }); },
    r => { r.assessmentResult.facts.inspections.find(i => i.kind === alternative.inspectionKind && i.key === alternative.inspectionKey && i.scope === 'product').status = 'unknown'; },
    r => { r.assessmentResult.facts.inspections.find(i => i.kind === alternative.inspectionKind && i.key === alternative.inspectionKey && i.scope === 'product').scope = 'shipping'; },
    r => { r.assessmentResult.facts.coverage.productComplete = false; },
    r => { r.assessmentResult.facts.coverage.truncated = true; },
    r => { r.assessmentResult.facts.coverage.truncatedScopes.push('product'); },
    r => { r.assessmentResult.facts.coverage.uninterpretedScopes.push('product'); },
    r => { r.assessmentResult.facts.coverage.unsafeInstructions = true; },
    r => { r.assessmentResult.facts.observations[0].text += 'changed'; },
    r => { r.grade.findings[alternative.check].rule = 'wrong'; },
    r => { r.grade.findings[alternative.check].justification = 'wrong'; },
  ];
  for (const mutate of mutations) { const copy = structuredClone(result); mutate(copy); assert.equal(compareFrozen(item.id, copy, item, manifest), false); }
  const missing = structuredClone(result); missing.assessmentResult.facts.facts = missing.assessmentResult.facts.facts.filter(f => !(f.kind === item.expected.facts[0].kind && f.key === item.expected.facts[0].key)); assert.equal(compareFrozen(item.id, missing, item, manifest), false);
  const changed = structuredClone(item); changed.snapshot.url += 'changed'; assert.equal(compareFrozen(item.id, result, changed, manifest), false);
  const tampered = structuredClone(manifest); tampered.find(e => e.caseId === item.id).alternatives[0].rule = 'wrong'; assert.equal(compareFrozen(item.id, result, item, tampered), false);
  const extra = structuredClone(result); extra.grade.findings['C3.price'] = {status:'not_applicable'}; assert.equal(compareFrozen(item.id, extra, item, manifest), false);
});

test('shirt requires exact complete score, all findings and required roles', () => {
  const item = structuredClone(cases.at(-1));
  const reference = referenceShirtResponse(item.request), payload = JSON.parse(item.request.messages[1].content);
  item.expected.facts = reference.facts.map(f => { const o = payload.observations.find(o => o.id === f.quoteIds[0]); return { kind:f.kind, key:f.key, scope:o.scope, text:o.text }; });
  const prepared = buildSemanticRequest(item.snapshot, item.extracted, item.report, { product: inspectProductSchema(item.snapshot, item.extracted).product });
  const facts = decodeContentFacts(prepared,item.request,reference);
  const raw = {roles:Object.fromEntries(payload.candidates.map(c=>[c.roleId,[]])), inspections:[], conditionChecks:Object.fromEntries(payload.conditionKeys.map(k=>[k,'unknown']))};
  for (const f of reference.facts) { const c=payload.candidates.find(c=>c.kind===f.kind && c.key===f.key && c.ids.includes(f.quoteIds[0])); if(c) raw.roles[c.roleId].push(c.kind==='repeated' ? {id:f.quoteIds[0]} : f.quoteIds[0]); }
  item.expected.findings = Object.fromEntries(Array.from({length:15}, (_,i)=>[`check${i}`, 0.5]));
  const primaryFacts=decodeContentFacts(prepared,item.request,raw,{requireConditionChecks:true,requireRoleSlots:true});
  const result = { assessmentResult: {status:'assessed', facts:primaryFacts}, grade:{findings:Object.fromEntries(Object.keys(item.expected.findings).map(k=>[k,{status:'measured',fraction:0.5}]))}, score: {status:'complete', score: {...item.expected.checks}}, modelCalls:[{invoked:true,input:item.request,inputHash:item.requestHash,output:{response:JSON.stringify(raw)}}] };
  assert.equal(compareFrozen(item.id, result, item, manifest), true);
  result.grade.findings.check0.fraction = 0; assert.equal(compareFrozen(item.id, result, item, manifest), false);
  result.grade.findings.check0.fraction = 0.5; result.score.score.total = 78; assert.equal(compareFrozen(item.id, result, item, manifest), false);
});
