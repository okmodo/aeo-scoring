import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GRANITE_MODEL_CONFIG as config } from '../backend/granite-provider.mjs';
import { prepareBinaryBenchmark, runBinaryBenchmark, scoreBinaryBenchmark } from '../scripts/granite-binary-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../evals/fixtures/granite-binary-harness.json', import.meta.url)));
const env = { AUDIT_AI_GATEWAY_TOKEN: 'mock-token' };
const gateway = () => Response.json({ success: true, result: { id: 'default', workers_ai_billing_mode: 'postpaid' } });
const providerResponse = output => Response.json({ success: true, result: {
  response: JSON.stringify(output),
  usage: { prompt_tokens: 10, completion_tokens: 5, neurons: 0.3 },
} });
const ledger = () => {
  const calls = [];
  return { calls,
    async reserve(request) { calls.push(['reserve', request]); return { accepted: true, duplicate: false }; },
    async settle(request) { calls.push(['settle', request]); return { accepted: true, overrun: false }; },
  };
};

test('the frozen request uses one prompt, binary answers and local cardinality', () => {
  const { input, requestBytes } = prepareBinaryBenchmark(fixture);
  assert.equal(input.messages.length, 1);
  assert.match(input.messages[0].content, /exactly one response/);
  assert.doesNotMatch(input.messages[0].content, /\/partial|\/full|half credit/i);
  const results = input.response_format.json_schema.properties.results;
  assert.equal(results.minItems, undefined);
  assert.equal(results.maxItems, undefined);
  assert.deepEqual(results.items.properties.id.enum, fixture.questions.map(question => question.id));
  assert.deepEqual(results.items.properties.answer.enum, ['pass', 'fail']);
  assert.equal(results.items.properties.reason.maxLength, 300);
  assert.ok(requestBytes < config.requestMaxBytes);
});

test('the frozen response earns only evidenced points from the current rubric', () => {
  const report = scoreBinaryBenchmark(prepareBinaryBenchmark(fixture), fixture.output);
  const { findings, scope, ...summary } = report;
  assert.equal(scope, 'benchmark_questions');
  assert.deepEqual({ ...summary, points: findings.map(finding => finding.points) }, fixture.expected);
  assert.equal(findings[3].validation, 'failure_unverified');
  assert.deepEqual(findings[4].verifiedAbsenceSourceIds, ['shipping']);
  assert.equal(findings[0].evidence[1].quote, 'Brand: Example Outfitters.');
});

test('source matching does not grant credit to a person name or a shipping heading', () => {
  const input = structuredClone(fixture.output);
  input.results[0].evidenceIds = ['name', 'person'];
  input.results[3].answer = 'pass';
  const report = scoreBinaryBenchmark(prepareBinaryBenchmark(fixture), input);
  assert.equal(report.findings[0].validation, 'pass_evidence_missing');
  assert.equal(report.findings[3].validation, 'pass_evidence_missing');
  input.results[0].evidenceIds = ['composition'];
  assert.equal(scoreBinaryBenchmark(prepareBinaryBenchmark(fixture), input).findings[0].validation, 'ineligible_evidence');
});

test('rejects invalid evidence and claims of absence on incomplete sources', () => {
  const forged = structuredClone(fixture);
  forged.evidence[0].quote = 'Invented title';
  assert.throws(() => prepareBinaryBenchmark(forged), /quote could not be verified/);
  const wrongScope = structuredClone(fixture);
  wrongScope.evidence[0].scope = 'returns';
  assert.throws(() => prepareBinaryBenchmark(wrongScope), /scope does not match/);
  const incomplete = structuredClone(fixture);
  incomplete.sources[1].complete = false;
  assert.throws(() => prepareBinaryBenchmark(incomplete), /evidence policy/);
  const empty = structuredClone(fixture);
  empty.sources[1].text = '';
  assert.throws(() => prepareBinaryBenchmark(empty), /invalid benchmark source/i);
});

test('the serialized schema and data count toward the existing request limit', () => {
  const large = structuredClone(fixture);
  large.questions[0].passRule = 'x'.repeat(config.requestMaxBytes);
  assert.throws(() => prepareBinaryBenchmark(large), /request_limit/);
});

test('rejects malformed output before scoring any row', () => {
  const benchmark = prepareBinaryBenchmark(fixture);
  for (const edit of [
    rows => rows.pop(),
    rows => { rows[1].id = rows[0].id; },
    rows => { rows[0].id = 'C6.alien'; },
    rows => { rows[0].answer = 'partial'; },
    rows => { rows[0].reason = '💡'.repeat(301); },
    rows => { rows[0].evidenceIds = ['brand', 'brand']; },
    rows => { rows[0].evidenceIds = ['invented']; },
  ]) {
    const output = structuredClone(fixture.output);
    edit(output.results);
    assert.throws(() => scoreBinaryBenchmark(benchmark, output), /invalid_binary_response/);
  }
  const output = structuredClone(fixture.output);
  output.results[0].reason = '💡'.repeat(300);
  assert.equal(scoreBinaryBenchmark(benchmark, output).findings[0].points, 3);
});

test('single guarded call records request size, timing, score and provider neurons', async () => {
  const allowance = ledger();
  let time = 0;
  const benchmark = prepareBinaryBenchmark(fixture);
  const run = await runBinaryBenchmark(fixture, { env, allowance, now: () => time,
    fetch: async (url, request) => {
      if (url === config.gatewayEndpoint) return gateway();
      assert.equal(url, config.endpoint);
      assert.equal(request.headers['cf-aig-gateway-id'], 'default');
      assert.equal(request.headers['cf-aig-skip-cache'], 'true');
      assert.equal(Buffer.byteLength(request.body), benchmark.requestBytes);
      assert.deepEqual(JSON.parse(request.body).response_format, benchmark.input.response_format);
      const reserved = allowance.calls[1][1].costs.aiNeurons;
      const minimum = Math.ceil(((benchmark.requestBytes + 2048) * config.inputNeuronsPerMillion +
        config.maxTokens * config.outputNeuronsPerMillion) / 1_000_000) + 64;
      assert.ok(reserved >= minimum);
      time += 24;
      return providerResponse(fixture.output);
    },
  });
  assert.equal(run.inferenceRequests, 1);
  assert.equal(run.timeoutMs, 60_000);
  assert.equal(run.timeToHttpResponseMs, 24);
  assert.equal(run.modelElapsedMs, 24);
  assert.equal(run.elapsedMs, 24);
  assert.equal(run.neurons, 0.3);
  assert.equal(run.report.earnedPoints, fixture.expected.earnedPoints);
  assert.equal(run.reservationSettled, true);
  assert.deepEqual(allowance.calls.map(([method]) => method), ['reserve', 'reserve', 'settle', 'settle']);
});

test('usage admission denial prevents an inference request', async () => {
  const allowance = ledger();
  const reserve = allowance.reserve;
  allowance.reserve = async request => request.costs.aiNeurons ? { accepted: false } : reserve(request);
  const run = await runBinaryBenchmark(fixture, { env, allowance, fetch: async url => {
    assert.equal(url, config.gatewayEndpoint);
    return gateway();
  } });
  assert.equal(run.failure, 'admission_failed');
  assert.equal(run.inferenceRequests, 0);
  assert.equal(run.neurons, null);
});

test('timeout aborts the only model request and preserves unknown usage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const allowance = ledger();
  const requestStarted = Promise.withResolvers();
  const running = runBinaryBenchmark(fixture, { env, allowance, fetch: async (url, options) => {
    if (url === config.gatewayEndpoint) return gateway();
    requestStarted.resolve(options.signal);
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const signal = await requestStarted.promise;
  t.mock.timers.tick(59_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  const run = await running;
  assert.equal(signal.aborted, true);
  assert.equal(run.failure, 'model_timeout');
  assert.equal(run.inferenceRequests, 1);
  assert.equal(run.modelElapsedMs, 60_000);
  assert.equal(run.timeToHttpResponseMs, null);
  assert.equal(run.neurons, null);
  assert.equal(allowance.calls.filter(([method]) => method === 'settle').length, 1);
});
