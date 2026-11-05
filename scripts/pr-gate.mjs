import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { assert, json, git, changedFiles, digestFiles, evidenceFile, inScope, validatePlan, validatePlanHistory, validateRun, validateHandoff, validateExit } from './evaluation.mjs';
const base = process.env.EVALUATION_BASE || process.argv[2];
assert(base, 'Set EVALUATION_BASE to the PR base commit or pass a base ref');
git(['rev-parse', '--verify', base]);
const report = { version: 1, evaluatedCommit: git(['rev-parse', 'HEAD']), base, status: 'failed', changes: [], humanReview: 'Required independently; CI cannot prove all process or subjective behavior.' };
try {
  const files = changedFiles(base);
  assert(files.length > 0, 'No changes to evaluate');
  const planPaths = files.filter(file => /^evals\/changes\/[a-z0-9-]+\/plan\.json$/.test(file) && existsSync(file));
  assert(planPaths.length > 0, 'Every PR needs a new task-specific evaluation plan');
  const plans = planPaths.map(file => validatePlan(json(file)));
  const digest = digestFiles(files);
  for (const file of files.filter(file => !evidenceFile(file))) assert(plans.some(plan => inScope(file, plan.scope)), `Out-of-scope changed file: ${file}`);
  validatePlanHistory(base, plans);
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i], planPath = planPaths[i], dir = `evals/changes/${plan.id}`;
    assert(planPath === `${dir}/plan.json`, 'Plan path/ID mismatch');
    const run = json(`${dir}/run.json`);
    const trace = readFileSync(`${dir}/trace.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    validateRun(plan, run, trace, digest);
    validateHandoff(json(`${dir}/handoff.json`));
    validateExit(plan, plan.exitTest.required ? json(`${dir}/exit-result.json`) : null, digest);
    report.changes.push({ id: plan.id, outcomes: plan.outcomes, process: plan.process, styleEfficiency: plan.styleEfficiency, commands: run.commands, traceCoverage: run.traceCoverage, agentMetrics: run.agentMetrics, exitTest: plan.exitTest });
  }
  report.status = 'passed';
} catch (error) { report.error = error.message; process.exitCode = 1; }
mkdirSync('reports', { recursive: true });
writeFileSync('reports/pr-evaluation.json', JSON.stringify(report, null, 2) + '\n');
const summary = `## PR evaluation: ${report.status}\n\n${report.error ?? `${report.changes.length} change plan(s) checked against current source contents.`}\n\nIndependent review remains required for permission judgment, subjective quality, efficiency, trace gaps, and exit-test authenticity.\n`;
writeFileSync('reports/summary.md', summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
