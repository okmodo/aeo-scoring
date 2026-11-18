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
  const checks = { 'C1.explanation': { status: 'measured', fraction: 1 }, 'C2.essential': { status: 'not_measured' } };
  applyRubricAssessment(checks, { findings: {
    'C1.explanation': { status: 'not_measured', reason: 'Ambiguous' },
    'C2.essential': { ...judgment(0.75), attributes: [{ id: 'fabric' }, { id: 'weight' }] },
  } }, inputs());
  assert.equal(checks['C1.explanation'].status, 'not_measured');
  assert.equal(checks['C2.essential'].fraction, 0.75);
});

test('explicit validated exclusion preserves its rule and evidence', () => {
  const checks = { 'C5.claim-support': { status: 'not_measured' } };
  applyRubricAssessment(checks, { findings: { 'C5.claim-support': {
    status: 'not_applicable', rule: 'no_material_claims', justification: 'No material claims were found.', evidence: [ref],
  } } }, inputs());
  assert.equal(checks['C5.claim-support'].rule, 'no_material_claims');
  assert.equal(checks['C5.claim-support'].evidence, 'e1');
});
