import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const fixture = JSON.parse(readFileSync('evals/fixtures/scenarios.json', 'utf8')).find(s => s.kind === 'handoff');
const entry = path.resolve('scripts/resume-handoff.mjs');
function resume(input) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'aeo-exit-'));
  try { return spawnSync(process.execPath, [entry], { cwd, input: JSON.stringify(input), encoding: 'utf8', env: { PATH: path.dirname(process.execPath), LANG: 'C' }, timeout: 5000 }); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
}
test('clean process can reconstruct interrupted state using only the exported payload', () => {
  const result = resume(fixture.input);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.state, fixture.expected.state);
  assert.equal(output.nextCommand, fixture.input.resumeCommands[0]);
  assert.deepEqual(output.remaining, fixture.input.remaining);
  assert.equal(output.kind, 'clean-process-smoke-only');
});
test('clean process rejects an export without remaining work', () => {
  const broken = structuredClone(fixture.input); delete broken.remaining;
  const result = resume(broken);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /remaining/);
});
test('clean process rejects a missing permission boundary', () => {
  const broken = structuredClone(fixture.input); broken.constraints = [];
  const result = resume(broken);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /constraints/);
});
