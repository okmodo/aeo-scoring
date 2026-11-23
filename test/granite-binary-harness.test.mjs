import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createGraniteResponseStore, retryModelWrite } from '../scripts/granite-response-store.mjs';
import { test } from 'node:test';
import { GRANITE_MODEL_CONFIG as config } from '../backend/granite-provider.mjs';
import { prepareBinaryBenchmark, runBinaryBenchmark, scoreBinaryBenchmark } from '../scripts/granite-binary-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../evals/fixtures/granite-binary-harness.json', import.meta.url)));
const migration = readFileSync(new URL('../backend/migrations/0014-model-attempts.sql', import.meta.url), 'utf8');
function localStore(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  sqlite.exec(migration);
  t.after(() => sqlite.close());
  const db = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...params) {
      const numbered = Object.fromEntries(params.map((value, index) => [String(index + 1), value]));
      return { run: async () => statement.run(numbered), first: async () => statement.get(numbered) ?? null };
    } };
  } };
  return { sqlite, store: createGraniteResponseStore(db) };
}
const keyed = output => ({ results: Object.fromEntries(output.results.map(({ id, ...row }) => [id, row])) });
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

test('the actual schema requires every question as a unique result key', () => {
  const { input, requestBytes } = prepareBinaryBenchmark(fixture);
  assert.equal(input.messages.length, 1);
  assert.match(input.messages[0].content, /one entry for every ID/);
  assert.doesNotMatch(input.messages[0].content, /\/partial|\/full|half credit/i);
  const results = input.response_format.json_schema.properties.results;
  assert.equal(results.type, 'object');
  assert.equal(results.additionalProperties, false);
  assert.deepEqual(results.required, fixture.questions.map(question => question.id));
  assert.deepEqual(Object.keys(results.properties), results.required);
  for (const [id, schema] of Object.entries(results.properties)) {
    assert.deepEqual(schema.required, ['answer', 'reason', 'evidenceIds']);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.answer.enum, ['pass', 'fail']);
    assert.equal(schema.properties.reason.maxLength, 300);
    const eligible = fixture.questions.find(check => check.id === id).eligibleEvidenceIds;
    assert.deepEqual(schema.properties.evidenceIds.items.enum ?? [], eligible);
  }
  assert.ok(requestBytes < config.requestMaxBytes);
});

test('the frozen response earns only evidenced points from the current rubric', () => {
  const report = scoreBinaryBenchmark(prepareBinaryBenchmark(fixture), fixture.output);
  const { findings, scope, unexpected, ...summary } = report;
  assert.equal(scope, 'benchmark_questions');
  assert.equal(unexpected, 0);
  assert.deepEqual({ ...summary, points: findings.map(finding => finding.points) }, fixture.expected);
  assert.equal(findings[3].validation, 'failure_unverified');
  assert.deepEqual(findings[4].verifiedAbsenceSourceIds, ['shipping']);
  assert.equal(findings[0].evidence[1].quote, 'Brand: Example Outfitters.');
  assert.deepEqual(scoreBinaryBenchmark(prepareBinaryBenchmark(fixture), keyed(fixture.output)), report);
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

test('missing and invalid answers leave independent results intact', () => {
  const benchmark = prepareBinaryBenchmark(fixture);
  const cases = [
    [rows => rows.pop(), 4, 'missing_answer'],
    [rows => { rows[1].id = rows[0].id; }, 0, 'duplicate_answer'],
    [rows => { rows[0].id = 'C6.alien'; }, 0, 'missing_answer'],
    [rows => { rows[0].answer = 'partial'; }, 0, 'invalid_answer'],
    [rows => { rows[0].reason = '💡'.repeat(301); }, 0, 'invalid_answer'],
    [rows => { rows[0].evidenceIds = ['brand', 'brand']; }, 0, 'invalid_answer'],
    [rows => { rows[0].evidenceIds = ['invented']; }, 0, 'ineligible_evidence'],
  ];
  for (const [edit, index, code] of cases) {
    const output = structuredClone(fixture.output);
    edit(output.results);
    const report = scoreBinaryBenchmark(benchmark, output);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.findings[index].validation, code);
    assert.equal(report.findings[index].points, null);
    assert.equal(report.findings[2].points, 14);
  }
  const output = structuredClone(fixture.output);
  output.results[0].reason = '💡'.repeat(300);
  assert.equal(scoreBinaryBenchmark(benchmark, output).findings[0].points, 3);
  assert.equal(scoreBinaryBenchmark(benchmark, {}).findings[0].validation, 'response_unavailable');
});

test('single guarded call records request size, timing, score and provider neurons', async t => {
  const allowance = ledger();
  let time = 0;
  const benchmark = prepareBinaryBenchmark(fixture);
  const { sqlite, store } = localStore(t);
  const run = await runBinaryBenchmark(fixture, { env, allowance, store, now: () => time,
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
      return providerResponse(keyed(fixture.output));
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
  const row = sqlite.prepare('SELECT * FROM model_attempts').get();
  assert.equal(row.status, 'incomplete');
  assert.equal(row.response_schema_version, 2);
  assert.equal(row.prompt_version, 'granite-binary-v2');
  assert.deepEqual(JSON.parse(Buffer.from(row.response_body_base64, 'base64')).result.response, JSON.stringify(keyed(fixture.output)));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM model_question_results').get().n, fixture.questions.length);
});

test('usage admission denial prevents an inference request', async t => {
  const allowance = ledger();
  const reserve = allowance.reserve;
  allowance.reserve = async request => request.costs.aiNeurons ? { accepted: false } : reserve(request);
  const { sqlite, store } = localStore(t);
  const run = await runBinaryBenchmark(fixture, { env, allowance, store, fetch: async url => {
    assert.equal(url, config.gatewayEndpoint);
    return gateway();
  } });
  assert.equal(run.failure, 'admission_failed');
  assert.equal(run.inferenceRequests, 0);
  assert.equal(run.neurons, null);
  assert.equal(sqlite.prepare('SELECT outcome FROM model_attempts').get().outcome, 'admission_failed');
});

test('timeout aborts the only model request and preserves unknown usage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const allowance = ledger();
  const requestStarted = Promise.withResolvers();
  const { sqlite, store } = localStore(t);
  const running = runBinaryBenchmark(fixture, { env, allowance, store, fetch: async (url, options) => {
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
  const attempt = sqlite.prepare('SELECT status,outcome,response_body_base64 FROM model_attempts').get();
  assert.deepEqual({ ...attempt }, { status: 'incomplete', outcome: 'model_timeout', response_body_base64: null });
});

test('HTTP failures and malformed bytes are stored within the existing byte bound', async t => {
  const { sqlite, store } = localStore(t);
  for (const [body, status, expectedBytes, truncated] of [
    [Buffer.from([0xff, 0x00]), 200, 2, 0],
    ['provider error', 502, 14, 0],
    ['x'.repeat(config.outputMaxBytes + 1), 200, config.outputMaxBytes, 1],
  ]) {
    const run = await runBinaryBenchmark(fixture, { env, allowance: ledger(), store,
      fetch: async url => url === config.gatewayEndpoint ? gateway() : new Response(body, { status }) });
    const attempt = sqlite.prepare('SELECT * FROM model_attempts WHERE attempt_id=?').get(run.attemptId);
    assert.equal(attempt.status, 'incomplete');
    assert.equal(attempt.http_status, status);
    assert.equal(attempt.response_truncated, truncated);
    const stored = Buffer.from(attempt.response_body_base64, 'base64');
    assert.equal(stored.length, expectedBytes);
    assert.deepEqual(stored, Buffer.from(body).subarray(0, expectedBytes));
    assert.ok(run.failure);
    if (truncated) assert.equal(run.failure, 'output_limit');
  }
});

test('D1 write retries preserve the same raw response and rows', async t => {
  const { sqlite, store } = localStore(t);
  const benchmark = prepareBinaryBenchmark(fixture);
  const params = { id: 'saved', kind: 'replay', model: config.model, gateway: config.gatewayId, benchmark, now: 100 };
  const output = { results: fixture.output.results.slice(0, 2) };
  const response = { outcome: 'replayed', origin: 'saved_model_output', bodyBase64: Buffer.from(JSON.stringify(output)).toString('base64') };
  const report = scoreBinaryBenchmark(benchmark, output);
  await store.begin(params);
  let tries = 0;
  await retryModelWrite(async () => {
    await store.capture(params.id, response);
    if (++tries === 1) throw new Error('D1 lost acknowledgment');
  });
  await store.finish(params.id, report);
  await store.begin(params);
  await store.capture(params.id, response);
  await store.finish(params.id, report);
  assert.equal(tries, 2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM model_attempts').get().n, 1);
  const rows = sqlite.prepare('SELECT * FROM model_question_results').all();
  assert.equal(rows.length, fixture.questions.length);
  assert.equal(rows.filter(row => row.validation_status === 'missing_answer' && row.answer === null).length, 3);
  const attempt = sqlite.prepare('SELECT * FROM model_attempts').get();
  assert.equal(attempt.status, 'incomplete');
  assert.equal(attempt.earned_points, 7);
  assert.equal(attempt.final_score, null);
  await assert.rejects(store.capture(params.id, { ...response, bodyBase64: '' }), /model_response_conflict/);
  const changed = structuredClone(report);
  changed.findings[0].reason = 'Different text with an identical score.';
  await assert.rejects(store.finish(params.id, changed), /model_results_conflict/);
  await store.prune(100 + 86_400_000);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM model_question_results').get().n, 0);
});


test('parseable token-limited output retains valid rows after the raw capture', async t => {
  const { sqlite, store } = localStore(t);
  const output = { results: fixture.output.results.slice(0, 2) };
  const run = await runBinaryBenchmark(fixture, { env, allowance: ledger(), store,
    fetch: async url => url === config.gatewayEndpoint ? gateway() : Response.json({ success: true, result: {
      choices: [{ message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, neurons: 0.3 },
    } }) });
  assert.equal(run.failure, 'model_output_invalid');
  assert.equal(run.report.measured, 2);
  assert.equal(run.report.score, null);
  assert.equal(run.neurons, 0.3);
  const result = sqlite.prepare('SELECT status,measured,unmeasured FROM model_attempts').get();
  assert.deepEqual({ ...result }, { status: 'incomplete', measured: 2, unmeasured: 3 });
});


test('keyed missing, malformed, and unexpected answers keep the other findings', () => {
  const output = keyed(fixture.output);
  delete output.results['C1.identity'];
  output.results['C1.explanation'] = null;
  output.results['C3.alien'] = { answer: 'pass', reason: 'Unexpected', evidenceIds: [] };
  const report = scoreBinaryBenchmark(prepareBinaryBenchmark(fixture), output);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.unexpected, 1);
  assert.equal(report.findings[0].validation, 'missing_answer');
  assert.equal(report.findings[1].validation, 'invalid_answer');
  assert.equal(report.findings[2].points, 14);
});
