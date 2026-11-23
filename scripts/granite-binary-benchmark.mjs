import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAnalyticsAllowanceGuard } from '../backend/analytics-allowance.mjs';
import { GRANITE_MODEL_CONFIG } from '../backend/granite-provider.mjs';
import { prepareBinaryBenchmark, runBinaryBenchmark, scoreBinaryBenchmark } from './granite-binary-harness.mjs';

const projectUsageLedger = '0e155397-a210-47a5-907f-dfc4505bb7d7';

function liveAllowance(env) {
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
  return createAnalyticsAllowanceGuard(db, { accountId, subscriptionId, token });
}

async function main([mode, inputPath, outputPath]) {
  if (!['offline', 'live'].includes(mode) || !inputPath || !outputPath) {
    throw new Error('Usage: node scripts/granite-binary-benchmark.mjs offline|live <input.json> <new-output.json>');
  }
  const fixture = JSON.parse(readFileSync(inputPath, 'utf8'));
  // Claim a new private destination before a paid call to prevent accidental reruns.
  writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 });
  let result;
  try {
    if (mode === 'live') {
      result = await runBinaryBenchmark(fixture, { env: process.env, allowance: liveAllowance(process.env) });
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
