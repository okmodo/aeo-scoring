import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { validatePlan, json, git, changedFiles, digestFiles, assert } from './evaluation.mjs';
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
assert(args.includes('--change') && args.includes('--base'), 'Usage: npm run evaluate -- --change <id> --base <ref>');
const id = value('--change');
assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id), 'Invalid change ID');
const base = value('--base'); git(['rev-parse', '--verify', base]);
const dir = `evals/changes/${id}`;
const plan = validatePlan(json(`${dir}/plan.json`));
assert(plan.id === id, 'Change ID mismatch');
const files = changedFiles(base);
const sourceDigest = digestFiles(files);
mkdirSync(`reports/${id}`, { recursive: true });
const commands = [], events = [];
let failed = false;
for (let i = 0; i < plan.commands.length; i++) {
  const command = plan.commands[i];
  const timestamp = new Date().toISOString(), start = performance.now();
  const result = spawnSync('npm', command.split(' ').slice(1), { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: process.env });
  const durationMs = Math.round(performance.now() - start);
  const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? '');
  writeFileSync(`reports/${id}/command-${i + 1}.log`, output);
  const exitCode = result.status ?? 1;
  commands.push({ command, exitCode, durationMs, outputSha256: createHash('sha256').update(output).digest('hex') });
  events.push({ timestamp, tool: 'npm', action: command, durationMs, exitCode, authorized: true, realEvidence: true, sideEffects: ['local-test-artifacts'] });
  console.log(`${exitCode === 0 ? 'PASS' : 'FAIL'} ${command} (${durationMs}ms)`);
  if (exitCode !== 0) { console.error(output); failed = true; }
}
const run = {
  version: 1, changeId: id, recordedAt: new Date().toISOString(), sourceCommit: git(['rev-parse', 'HEAD']), sourceDigest,
  traceCoverage: 'evaluation-commands-only', traceLimitations: 'Captured actual evaluation commands. Earlier development tool calls and permission judgment are not independently verified by this trace; review the development summary and PR.',
  agentMetrics: { tokens: null, costUSD: null, note: 'The agent host did not expose reliable per-task token or cost telemetry. No model API is called by these checks.' },
  commands,
};
assert(digestFiles(changedFiles(base)) === sourceDigest, 'Verification mutated source files; inspect and rerun');
writeFileSync(`${dir}/run.json`, JSON.stringify(run, null, 2) + '\n');
writeFileSync(`${dir}/trace.jsonl`, events.map(event => JSON.stringify(event)).join('\n') + '\n');
process.exitCode = failed ? 1 : 0;
