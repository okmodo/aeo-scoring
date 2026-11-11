import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFrozen, caseIds } from './synthetic-client.mjs';
import { filterTelemetry, validCpu } from '../ai-real-validation/operator-run.mjs';

test('compares all fifteen frozen findings including status and fraction', () => {
  const checks = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`check${i}`, i === 0 ? 'not_measured' : 0.5]));
  const findings = Object.fromEntries(Object.entries(checks).map(([id, value]) => [id, typeof value === 'number' ? { status: 'measured', fraction: value } : { status: value }]));
  const result = { assessmentResult: { status: 'assessed' }, grade: { findings } };
  assert.equal(compareFrozen(caseIds[0], result, { checks }), true);
  findings.check14.fraction = 1;
  assert.equal(compareFrozen(caseIds[0], result, { checks }), false);
  findings.check14.fraction = 0.5; findings.check0.status = 'measured';
  assert.equal(compareFrozen(caseIds[0], result, { checks }), false);
  delete checks.check0;
  assert.equal(compareFrozen(caseIds[0], result, { checks }), false);
});

test('shirt requires complete exact frozen total and pillar scores', () => {
  const expected = { checks: { total: 78.125, structure: 20, content: 58.125 } };
  const result = { assessmentResult: { status: 'assessed' }, score: { status: 'complete', score: { ...expected.checks } } };
  assert.equal(compareFrozen('basic-tshirts', result, expected), true);
  result.score.score.content = 58;
  assert.equal(compareFrozen('basic-tshirts', result, expected), false);
  result.score.score.content = 58.125; result.score.status = 'incomplete';
  assert.equal(compareFrozen('basic-tshirts', result, expected), false);
});

test('shared telemetry filtering removes secrets and requires primary CPU', () => {
  const filtered = filterTelemetry({ event: { request: { url: 'https://example.test/validate/running-shoes?token=secret', headers: { authorization: 'secret' }, cf: { cpuTime: 1 } } }, logs: [{ message: 'secret' }] });
  assert.equal(JSON.stringify(filtered).includes('secret'), false);
  assert.equal(validCpu(filtered, 1000), false);
});
