import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createGraniteResponseStore, retryModelWrite } from './granite-response-store.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAnalyticsAllowanceGuard } from '../backend/analytics-allowance.mjs';
import { GRANITE_MODEL_CONFIG } from '../backend/granite-provider.mjs';
import { prepareBinaryBenchmark, runBinaryBenchmark, scoreBinaryBenchmark } from './granite-binary-harness.mjs';

const projectUsageLedger = '0e155397-a210-47a5-907f-dfc4505bb7d7';

function liveServices(env) {
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_SUBSCRIPTION_ID: subscriptionId,
    CLOUDFLARE_BILLING_READ_TOKEN: token,
    CLOUDFLARE_D1_API_TOKEN: databaseToken } = env;
  if (!/^[a-f0-9]{32}$/.test(accountId ?? '') ||
      !new URL(GRANITE_MODEL_CONFIG.endpoint).pathname.startsWith('/client/v4/accounts/' + accountId + '/') ||
      ![subscriptionId, token, databaseToken, env.AUDIT_AI_GATEWAY_TOKEN].every(value => value?.trim())) {
    throw new Error('Missing live benchmark credentials or account scope');
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${projectUsageLedger}/query`;
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          const run = async () => {
            const response = await fetch(endpoint, {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
              headers: { Authorization: 'Bearer ' + databaseToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ sql, params }),
            });
            if (!response.ok) throw new Error('D1 usage ledger unavailable');
            const envelope = await response.json();
            if (envelope.success !== true || envelope.result?.[0]?.success !== true) throw new Error('D1 usage ledger query failed');
            return envelope.result[0];
          };
          return { run, first: async () => (await run()).results?.[0] ?? null };
        },
      };
    },
  };
  return { allowance: createAnalyticsAllowanceGuard(db, { accountId, subscriptionId, token }),
    store: createGraniteResponseStore(db) };
}

async function replay(fixture, savedPath, persistPath) {
  // Resolve the existing locked local D1 runtime from backend dependencies.
  const require = createRequire(new URL('../backend/package.json', import.meta.url));
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  const resourcePersistencePath = resolve(persistPath);
  mkdirSync(resourcePersistencePath, { recursive: true, mode: 0o700 });
  const runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true, script: 'export default {}', compatibilityDate: '2026-11-05', cf: false,
      d1Databases: { AUDIT_DB: 'granite-benchmark-replay' },
    }),
    resourcePersistencePath,
  });
  try {
    const db = await runtime.getD1Database('AUDIT_DB');
    const migration = readFileSync(new URL('../backend/migrations/0014-model-attempts.sql', import.meta.url), 'utf8');
    await db.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
    const benchmark = prepareBinaryBenchmark(fixture);
    const savedText = readFileSync(savedPath, 'utf8');
    const saved = JSON.parse(savedText);
    if (!Object.hasOwn(saved, 'output') && !saved.response) throw new Error('Expected saved benchmark output or capture');
    const output = saved.output;
    const body = output === undefined ? null : Buffer.from(JSON.stringify(output));
    if (!saved.response && body?.length > GRANITE_MODEL_CONFIG.outputMaxBytes) throw new Error('output_limit');
    if (saved.response?.bodyBase64 && Buffer.from(saved.response.bodyBase64, 'base64').length > GRANITE_MODEL_CONFIG.outputMaxBytes) throw new Error('output_limit');
    const response = saved.response ?? {
      outcome: 'replayed', origin: body ? 'saved_model_output' : null, bodyBase64: body?.toString('base64') ?? null,
      httpStatus: saved.httpStatus, modelElapsedMs: saved.modelElapsedMs, neurons: saved.neurons,
    };
    const id = 'granite-replay-' + createHash('sha256').update(JSON.stringify([fixture.capture, benchmark.body, savedText])).digest('hex');
    const store = createGraniteResponseStore(db);
    const now = Date.now();
    await store.prune(now);
    await retryModelWrite(() => store.begin({ id, kind: 'replay', capture: fixture.capture,
      model: saved.model ?? GRANITE_MODEL_CONFIG.model, gateway: saved.gateway ?? GRANITE_MODEL_CONFIG.gatewayId, benchmark, now }));
    await retryModelWrite(() => store.capture(id, response));
    const report = scoreBinaryBenchmark(benchmark, output);
    await retryModelWrite(() => store.finish(id, report));
    return { attemptId: id, inferenceRequests: 0, requestBytes: benchmark.requestBytes,
      priorNeurons: response.neurons ?? null, report };
  } finally { await runtime.dispose(); }
}

async function main([mode, inputPath, outputPath, savedPath, persistPath]) {
  if (!['offline', 'live', 'replay'].includes(mode) || !inputPath || !outputPath ||
      (mode === 'replay' && (!savedPath || !persistPath))) {
    throw new Error('Usage: node scripts/granite-binary-benchmark.mjs offline|live <input.json> <new-output.json> or replay <input.json> <new-output.json> <saved-result.json> <private-d1-directory>');
  }
  const fixture = JSON.parse(readFileSync(inputPath, 'utf8'));
  writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 });
  let result;
  try {
    if (mode === 'live') {
      const recoveryPath = outputPath + '.capture.json';
      result = await runBinaryBenchmark(fixture, { env: process.env, ...liveServices(process.env),
        onCapture: capture => writeFileSync(recoveryPath, JSON.stringify(capture), { flag: 'wx', mode: 0o600 }) });
      writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
      if (result.report && !result.localCaptureFailed) unlinkSync(recoveryPath);
    } else if (mode === 'replay') {
      result = await replay(fixture, savedPath, persistPath);
    } else {
      const benchmark = prepareBinaryBenchmark(fixture);
      result = { requestBytes: benchmark.requestBytes, report: scoreBinaryBenchmark(benchmark, fixture.output) };
    }
  } catch (error) {
    writeFileSync(outputPath, JSON.stringify({ failure: 'benchmark_error' }) + '\n');
    throw error;
  }
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ mode, outputPath, status: result.report?.status ?? 'failed',
    score: result.report?.score ?? null, neurons: result.neurons ?? null, failure: result.failure ?? null }));
  if (result.failure) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
