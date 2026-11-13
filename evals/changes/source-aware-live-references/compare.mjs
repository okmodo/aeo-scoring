import { buildSemanticRequest } from '../../../backend/semantic-assessment.mjs';
import { inspectProductSchema } from '../../../backend/structure-assessment.mjs';
import { decodeContentFacts } from '../../../backend/content-facts.mjs';
import approved from './approved-alternatives.json' with { type: 'json' };
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const permitted = {
  'running-shoes': { 'C4.limitations': ['running-limits', 'decision', 'running-limits', 'category_conditions_absent'], 'C5.claim-support': ['material_claim', 'claim', 'claim', 'no_material_claims'] },
  'casual-daypacks': { 'C5.claim-support': ['material_claim', 'claim', 'claim', 'no_material_claims'] },
  handbags: { 'C4.limitations': ['handbags-limitations', 'decision', 'handbags-limitations', 'category_conditions_absent'], 'C5.claim-support': ['material_claim', 'claim', 'claim', 'no_material_claims'] },
};
export const sourceHash = item => digest({ snapshot: item.snapshot, extracted: item.extracted });
function primaryOutput(output) {
  let raw = output?.response ?? output?.output_text;
  if (raw == null && Array.isArray(output?.output)) { const parts=output.output.filter(item=>item.type==='message' && item.role==='assistant').flatMap(item=>item.content || []).filter(item=>item.type==='output_text').map(item=>item.text); if (parts.length !== 1) return null; raw=parts[0]; }
  raw ??= output?.choices?.[0]?.message?.content ?? output;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}
function proof(item, result, entry, alternative) {
  const expected = permitted[item.id]?.[alternative.check];
  if (!expected || alternative.status !== 'not_applicable' || !Array.isArray(entry.alternatives) || !expected.every((v, i) => v === [alternative.conditionKey, alternative.inspectionKind, alternative.inspectionKey, alternative.rule][i])) return false;
  if (entry.caseId !== item.id || entry.requestHash !== item.requestHash || entry.sourceHash !== sourceHash(item) || digest(item.request) !== item.requestHash) return false;
  const primary = result.modelCalls?.[0];
  if (primary?.invoked !== true || primary.inputHash !== item.requestHash || digest(primary.input) !== item.requestHash) return false;
  let payload;
  try { payload = JSON.parse(item.request.messages[1].content); } catch { return false; }
  const facts = result.assessmentResult?.facts, coverage = facts?.coverage;
  try {
    const prepared = buildSemanticRequest(item.snapshot, item.extracted, item.report, { product: inspectProductSchema(item.snapshot, item.extracted).product });
    const decoded = decodeContentFacts(prepared, item.request, primaryOutput(primary.output), { requireConditionChecks: true, requireRoleSlots: true });
    if (JSON.stringify(facts) !== JSON.stringify(decoded)) return false;
  } catch { return false; }
  if (JSON.stringify(facts?.observations?.map(({id,scope,text}) => ({id,scope,text}))) !== JSON.stringify(payload.observations) || JSON.stringify(coverage) !== JSON.stringify(payload.coverage)) return false;
  if (coverage?.productComplete !== true || coverage.unsafeInstructions !== false || coverage.truncated !== false || !Array.isArray(coverage.truncatedScopes) || coverage.truncatedScopes.includes('product') || !Array.isArray(coverage.uninterpretedScopes) || coverage.uninterpretedScopes.includes('product')) return false;
  const conditions = primaryOutput(primary.output)?.conditionChecks;
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions) || Object.keys(conditions).sort().join('\u0000') !== [...payload.conditionKeys].sort().join('\u0000') || conditions[alternative.conditionKey] !== 'absent') return false;
  const inspections = facts?.inspections?.filter(i => i.kind === alternative.inspectionKind && i.key === alternative.inspectionKey && i.scope === 'product');
  const actual = result.grade?.findings?.[alternative.check];
  return inspections?.length === 1 && inspections[0].status === 'absent' && actual?.status === alternative.status && actual.rule === alternative.rule && actual.justification === (alternative.rule === 'no_material_claims' ? 'Complete product content contained no identified material claims requiring substantiation.' : 'All conditional category questions were inspected and their conditions were absent.');
}
export function compareFrozen(id, result, item, manifest = []) {
  const checks = item?.expected?.checks;
  if (item?.id !== id || result?.assessmentResult?.status !== 'assessed' || !checks) return false;
  if (!Array.isArray(manifest) || manifest.length !== approved.cases.length || manifest.some((entry, index) => { const review = approved.cases[index]; return entry.caseId !== review.caseId || entry.sourceHash !== review.sourceHash || JSON.stringify(entry.alternatives) !== JSON.stringify(review.alternatives) || !/^[0-9a-f]{64}$/.test(entry.requestHash); })) return false;
  const bound = manifest.find(entry => entry.caseId === id);
  if (!bound || bound.sourceHash !== sourceHash(item) || bound.requestHash !== item.requestHash || digest(item.request) !== item.requestHash) return false;
  const facts=result.assessmentResult.facts;
  const primary = result.modelCalls?.[0];
  if (primary?.invoked !== true || primary.inputHash !== item.requestHash || digest(primary.input) !== item.requestHash) return false;
  try {
    const prepared = buildSemanticRequest(item.snapshot, item.extracted, item.report, { product: inspectProductSchema(item.snapshot, item.extracted).product });
    const decoded = decodeContentFacts(prepared, item.request, primaryOutput(primary.output), { requireConditionChecks: true, requireRoleSlots: true });
    if (JSON.stringify(facts?.observations) !== JSON.stringify(decoded.observations) || JSON.stringify(facts?.coverage) !== JSON.stringify(decoded.coverage) || JSON.stringify(facts?.facts) !== JSON.stringify(decoded.facts) || (id !== 'basic-tshirts' && JSON.stringify(facts) !== JSON.stringify(decoded))) return false;
  } catch { return false; }
  if (!Array.isArray(item.expected.facts) || !Array.isArray(facts?.facts) || !Array.isArray(facts.observations)) return false;
  if (!item.expected.facts.every(reference => facts.facts.some(f => f.kind === reference.kind && f.key === reference.key && f.validity === 'plausible' && f.quoteIds?.some(id => facts.observations.some(o => o.id === id && o.scope === reference.scope && o.text === reference.text))))) return false;
  if (id === 'basic-tshirts') {
    const findings=item.expected.findings;
    return result.score?.status === 'complete' && ['total', 'structure', 'content'].every(key => result.score.score?.[key] === checks[key]) && findings && Object.keys(findings).length === 15 && Object.entries(findings).every(([key,value]) => typeof value === 'number' ? result.grade?.findings?.[key]?.status === 'measured' && result.grade.findings[key].fraction === value : result.grade?.findings?.[key]?.status === value);
  }
  if (Object.keys(checks).length !== 15 || !Array.isArray(manifest)) return false;
  const entries = manifest.filter(entry => entry.caseId === id);
  if (entries.length > 1) return false;
  const entry = entries[0];
  if (entry && (!Array.isArray(entry.alternatives) || new Set(entry.alternatives.map(a => a.check)).size !== entry.alternatives.length || entry.alternatives.some(a => !permitted[id]?.[a.check]))) return false;
  return Object.entries(checks).every(([key, value]) => {
    const actual = result.grade?.findings?.[key];
    if (typeof value === 'number' ? actual?.status === 'measured' && actual.fraction === value : actual?.status === value) return true;
    const alt = entry?.alternatives.find(a => a.check === key);
    return value === 'not_measured' && alt && proof(item, result, entry, alt);
  });
}
