import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';

export function assert(condition, message) { if (!condition) throw new Error(message); }
export function text(value) { return typeof value === 'string' && value.trim().length > 0; }
export function git(args, cwd = process.cwd()) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
export function json(file) { return JSON.parse(readFileSync(file, 'utf8')); }
export function validatePlan(plan) {
  assert(plan.version === 1, 'Unsupported plan version');
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plan.id), 'Invalid change ID');
  assert(text(plan.task), 'Task is required');
  assert(Array.isArray(plan.scope) && plan.scope.length > 0, 'Scope is required');
  for (const pattern of plan.scope) {
    assert(text(pattern) && !pattern.startsWith('/') && !pattern.includes('..') && !pattern.includes('\\'), 'Unsafe scope');
    const literal = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
    assert(literal.length > 0 && !literal.includes('*') && !literal.includes('?'), 'Use exact files or directory/** scopes');
  }
  assert(Array.isArray(plan.nonGoals) && plan.nonGoals.every(text) && plan.nonGoals.length > 0, 'Non-goals required');
  const ids = new Set();
  for (const category of ['outcomes', 'process', 'styleEfficiency']) {
    assert(Array.isArray(plan[category]) && plan[category].length > 0, `Missing ${category} goals`);
    for (const goal of plan[category]) {
      assert(text(goal.id) && !ids.has(goal.id), 'Duplicate or missing goal ID'); ids.add(goal.id);
      assert(text(goal.description) && text(goal.evidence), 'Goal needs description and evidence');
      assert(['automated', 'human'].includes(goal.verification), 'Unknown verification mode');
    }
  }
  assert(Array.isArray(plan.commands) && plan.commands.length > 0 && plan.commands.every(text), 'Verification commands required');
  // This small command grammar avoids executing arbitrary shell expressions from a PR.
  for (const command of plan.commands) assert(/^npm (?:test|run [a-z][a-z0-9:-]*)$/.test(command), 'Use a named npm script, without shell expressions');
  assert(typeof plan.exitTest?.required === 'boolean' && text(plan.exitTest.reason), 'Exit-test applicability required');
  return plan;
}
export function inScope(file, patterns) {
  return patterns.some(pattern => pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern);
}
export function evidenceFile(file) {
  return /^evals\/changes\/[a-z0-9-]+\/(run\.json|trace\.jsonl|exit-result\.json)$/.test(file);
}
export function changedFiles(base, cwd = process.cwd()) {
  const tracked = git(['diff', '--name-only', '-z', base, '--'], cwd).split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd).split('\0').filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}
// Check actual PR commits: endpoint trees lose reverted work and include newer base changes.
export function validatePlanHistory(base, plans, cwd = process.cwd()) {
  const planPattern = /^evals\/changes\/[a-z0-9-]+\/plan\.json$/;
  const byPath = new Map(plans.map(plan => [`evals/changes/${plan.id}/plan.json`, plan]));
  const introduced = new Map();
  const availableAt = new Map();
  const commits = git(['rev-list', '--reverse', '--topo-order', '--parents', `${base}..HEAD`], cwd).split('\n').filter(Boolean);
  for (const line of commits) {
    const [commit, ...parents] = line.split(' ');
    const available = new Set(parents.flatMap(parent => [...(availableAt.get(parent) ?? [])]));
    // Combined diffs include merge resolutions, but not work merely inherited from upstream.
    const files = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '--cc', '-z', commit], cwd).split('\0').filter(Boolean);
    const planning = files.filter(file => planPattern.test(file));
    for (const file of planning) {
      assert(byPath.has(file) && !introduced.has(file), 'Acceptance plan changed after its first commit');
      // An existing base plan cannot be reused or edited for a new PR.
      const basePlans = git(['ls-tree', '--name-only', base, '--', file], cwd);
      assert(!basePlans, 'Every PR needs a new task-specific evaluation plan');
      const original = git(['show', `${commit}:${file}`], cwd);
      assert(original === readFileSync(path.join(cwd, file), 'utf8').trim(), 'Acceptance plan changed after its first commit');
      introduced.set(file, commit);
    }
    if (planning.length) assert(files.every(file => planPattern.test(file)), 'The plan commit must contain plans only, before implementation');
    for (const file of files.filter(file => !evidenceFile(file) && !planPattern.test(file))) {
      assert([...available].some(planPath => inScope(file, byPath.get(planPath).scope)), `Implementation in this scope predates its plan: ${file} (${commit})`);
    }
    planning.forEach(file => available.add(file));
    availableAt.set(commit, available);
  }
  for (const file of byPath.keys()) assert(introduced.has(file), 'Commit the new plan before implementation');
}
export function digestFiles(files, cwd = process.cwd()) {
  const hash = createHash('sha256');
  for (const file of [...files].filter(file => !evidenceFile(file)).sort()) {
    assert(!path.isAbsolute(file) && !file.split('/').includes('..'), 'Unsafe digest path');
    const full = path.join(cwd, file);
    let stat;
    try { stat = lstatSync(full); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    let kind = 'missing', mode = null, content = Buffer.alloc(0);
    if (stat?.isSymbolicLink()) {
      kind = 'symlink'; content = readlinkSync(full, { encoding: 'buffer' });
    } else if (stat?.isFile()) {
      kind = 'file'; mode = stat.mode & 0o111 ? '100755' : '100644'; content = readFileSync(full);
    } else if (stat?.isDirectory()) {
      // A deleted Git leaf can now be a directory; changed descendants have their
      // own entries, while this marker binds the former leaf's current state.
      kind = 'directory';
    } else assert(!stat, `Unsupported source file type: ${file}`);
    // Typed, length-framed entries distinguish deletion, mode and link target without
    // following links or colliding with literal tombstone bytes in real source files.
    hash.update(JSON.stringify([file, kind, mode, content.length]) + '\0');
    hash.update(content); hash.update('\0');
  }
  return hash.digest('hex');
}
export function validateTrace(events, options = {}) {
  assert(Array.isArray(events) && events.length > 0, 'Trace must contain events');
  let prior = -Infinity;
  for (const event of events) {
    assert(text(event.tool) && text(event.action), 'Trace event needs tool and action');
    const timestamp = Date.parse(event.timestamp);
    assert(Number.isFinite(timestamp) && timestamp >= prior, 'Trace timestamps must be valid and ordered'); prior = timestamp;
    assert(Number.isFinite(event.durationMs) && event.durationMs >= 0, 'Invalid duration');
    assert(event.authorized === true, 'Unauthorized or unconfirmed operation');
    assert(event.realEvidence === true, 'Evidence must be real, not invented');
    assert(Array.isArray(event.sideEffects), 'Side effects must be recorded');
    assert(event.sideEffects.every(effect => options.allowedSideEffects?.includes(effect)), 'Unexpected side effect');
  }
  return true;
}
export function validateRun(plan, run, trace, digest) {
  assert(run.version === 1 && run.changeId === plan.id, 'Run/plan mismatch');
  assert(run.sourceDigest === digest, 'Stale evidence: changed source content needs evaluation');
  assert(text(run.sourceCommit) && text(run.recordedAt), 'Run provenance missing');
  assert(run.traceCoverage === 'evaluation-commands-only', 'Declare actual trace coverage');
  assert(text(run.traceLimitations), 'Trace limitations required');
  assert(run.agentMetrics && ['tokens', 'costUSD'].every(k => run.agentMetrics[k] === null || (Number.isFinite(run.agentMetrics[k]) && run.agentMetrics[k] >= 0)), 'Invalid agent metrics');
  assert(text(run.agentMetrics.note), 'Explain unavailable or sourced metrics');
  assert(Array.isArray(run.commands) && run.commands.length === plan.commands.length, 'Missing verification commands');
  for (let i = 0; i < plan.commands.length; i++) {
    const result = run.commands[i];
    assert(result.command === plan.commands[i] && result.exitCode === 0, 'Required command did not pass');
    assert(Number.isFinite(result.durationMs) && result.durationMs >= 0, 'Missing command duration');
    assert(text(result.outputSha256) && /^[a-f0-9]{64}$/.test(result.outputSha256), 'Command output hash missing');
    assert(trace[i]?.action === result.command && trace[i]?.exitCode === 0, 'Trace does not match command result');
  }
  assert(trace.length === plan.commands.length, 'Trace event count does not match run');
  validateTrace(trace, { allowedSideEffects: ['local-test-artifacts'] });
  return true;
}
export function validateHandoff(handoff) {
  assert(handoff.version === 1 && text(handoff.task), 'Invalid handoff');
  for (const field of ['decisions', 'constraints', 'completed', 'remaining', 'resumeCommands']) {
    assert(Array.isArray(handoff[field]) && handoff[field].length > 0 && handoff[field].every(text), `Handoff missing ${field}`);
  }
  assert(text(handoff.state), 'Handoff needs current state');
  return true;
}
export function validateExit(plan, result, digest) {
  if (!plan.exitTest.required) return true;
  assert(result?.version === 1 && result.changeId === plan.id && result.sourceDigest === digest, 'Missing or stale exit-test record');
  assert(result.kind === 'fresh-agent' && result.priorConversationProvided === false, 'Exit test must use a fresh agent without prior conversation');
  assert(result.status === 'passed' && text(result.agentId), 'Fresh-agent continuation did not pass');
  assert(text(result.exportSha256) && /^[a-f0-9]{64}$/.test(result.exportSha256), 'Export hash required');
  assert(text(result.interruptionPoint) && text(result.observedContinuation) && text(result.limitations), 'Exit-test evidence incomplete');
  return true;
}
