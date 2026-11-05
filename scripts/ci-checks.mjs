import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assert, changedFiles, json, validatePlan, git } from './evaluation.mjs';

export function collectCommands(plans, scripts, appPresent, foundationsPresent = false, feasibilityPresent = false) {
  const required = ['npm run check', 'npm test', 'npm run test:exit'];
  if (appPresent) for (const name of ['lint', 'typecheck', 'build']) {
    assert(typeof scripts[name] === 'string', `App needs ${name}`);
    required.push(`npm run ${name}`);
  }
  if (appPresent) {
    assert(typeof scripts['test:preview'] === 'string' && scripts['test:preview'].trim() && !/^(echo|true|exit 0)\b/.test(scripts['test:preview'].trim()), 'App needs real test:preview');
    required.push('npm run test:preview');
  }
  if (foundationsPresent) {
    assert(typeof scripts['test:foundations'] === 'string' && scripts['test:foundations'].trim() && !/^(echo|true|exit 0)\b/.test(scripts['test:foundations'].trim()), 'Foundations need a real test:foundations script');
    required.push('npm run test:foundations');
  }
  if (feasibilityPresent) {
    assert(typeof scripts['test:feasibility'] === 'string' && scripts['test:feasibility'].trim() && !/^(echo|true|exit 0)\b/.test(scripts['test:feasibility'].trim()), 'Feasibility needs a real test:feasibility script');
    required.push('npm run test:feasibility');
  }
  for (const plan of plans) required.push(...validatePlan(plan).commands);
  assert(!required.some(command => /npm run (?:ci:checks|ci:gate|evaluate)$/.test(command)), 'Evaluation plans cannot recursively invoke the evaluator');
  return [...new Set(required)];
}
function main() {
  const base = process.env.EVALUATION_BASE || process.argv[2];
  assert(base, 'Set EVALUATION_BASE or pass a base ref');
  const files = changedFiles(base);
  const plans = files.filter(file => /^evals\/changes\/[a-z0-9-]+\/plan\.json$/.test(file) && existsSync(file)).map(file => json(file));
  const commands = collectCommands(plans, json('package.json').scripts, ['src','web','app'].some(dir => existsSync(dir)), existsSync('config/rubric.v1.json'), existsSync('scripts/feasibility.mjs'));
  mkdirSync('reports/ci', { recursive: true });
  const trace = [];
  let failed = false;
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i], timestamp = new Date().toISOString(), start = performance.now();
    const result = spawnSync('npm', command.split(' ').slice(1), { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: process.env });
    const durationMs = Math.round(performance.now() - start);
    const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? '');
    const exitCode = result.status ?? 1;
    writeFileSync(`reports/ci/command-${i + 1}.log`, output);
    trace.push({ timestamp, tool: 'npm', command, durationMs, exitCode, outputSha256: createHash('sha256').update(output).digest('hex') });
    console.log(`${exitCode === 0 ? 'PASS' : 'FAIL'} ${command} (${durationMs}ms)\n${output}`);
    if (exitCode !== 0) failed = true;
  }
  writeFileSync('reports/ci/trace.jsonl', trace.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync('reports/ci/run.json', JSON.stringify({ sourceCommit: git(['rev-parse','HEAD']), base, commands: trace, agentMetrics: { tokens: null, costUSD: null, note: 'Not supplied by agent host; offline checks use no model API.' }, status: failed ? 'failed' : 'passed' }, null, 2) + '\n');
  process.exitCode = failed ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
