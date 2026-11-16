import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFrozen, caseIds, captureResponse, captureCase, requireReview, resultDigest, filterTelemetry, validCpu } from './synthetic-client.mjs';

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


test('persists HTTP status before parsing a bodyless error response', async () => {
  const saved = [];
  await assert.rejects(captureResponse(new Response(null, { status: 429 }), 'running-shoes', async record => saved.push({ ...record })), /InvalidResponseJSON/);
  assert.deepEqual(saved, [{ id: 'running-shoes', status: 429 }]);
});

test('telemetry keeps only primary root CPU and pathname', () => {
  const filtered = filterTelemetry({ cpuTime: 42, event: { request: { url: 'https://example.test/control?secret=x', cf: { cpuTime: 999 } } }, logs: ['secret'] });
  assert.deepEqual(filtered, { cpuMs: 42, path: '/control' });
  assert.equal(validCpu(filtered, 1000), true);
  assert.equal(validCpu({ cpuMs: 1001 }, 1000), false);
  assert.equal(validCpu(filterTelemetry({ event: { cpuTime: 2 } })), false);
});


test('failed response still waits for and saves primary CPU before stopping', async () => {
  const saved = []; let waited = false;
  await assert.rejects(captureCase(new Response(null, { status: 503 }), 'running-shoes', async record => saved.push(structuredClone(record)), async () => { waited = true; return { cpuMs: 77, path: '/validate/running-shoes' }; }), /InvalidResponseJSON/);
  assert.equal(waited, true);
  assert.equal(saved[0].status, 503);
  assert.equal(saved.at(-1).telemetry.cpuMs, 77);
  assert.equal(saved.at(-1).cpuGatePassed, true);
});


test('review gate accepts only exact case and result digest and rejects EOF', async () => {
  const { PassThrough } = await import('node:stream');
  const digest = resultDigest({ raw: ['S', 'N', 'U'] });
  const input = new PassThrough();
  const accepted = requireReview('running-shoes', digest, input, 1000);
  input.write(`REVIEW_PASS running-shoes ${digest}\n`);
  await accepted;
  const wrong = new PassThrough();
  const rejected = requireReview('running-shoes', digest, wrong, 1000);
  wrong.write(`REVIEW_PASS handbags ${digest}\n`);
  await assert.rejects(rejected, /ReviewRejected/);
  const eof = new PassThrough();
  const closed = requireReview('running-shoes', digest, eof, 1000);
  eof.end();
  await assert.rejects(closed, /ReviewEOF/);
});
