import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assert, json, validatePlan } from './evaluation.mjs';
const walk = dir => readdirSync(dir).flatMap(name => {
  if (['.git', 'node_modules', 'reports'].includes(name)) return [];
  const file = path.join(dir, name); return statSync(file).isDirectory() ? walk(file) : [file];
});
const files = walk('.');
for (const file of files.filter(file => file.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert(result.status === 0, `Syntax check failed: ${file}\n${result.stderr}`);
}
for (const file of files.filter(file => file.endsWith('.json'))) json(file);
for (const file of files.filter(file => /^evals\/changes\/.+\/plan\.json$/.test(file))) validatePlan(json(file));
const markdown = files.filter(file => file.endsWith('.md'));
const stems = new Set(markdown.map(file => path.basename(file, '.md')));
for (const file of markdown) {
  const content = readFileSync(file, 'utf8');
  assert(!/[^\S\r\n]+$/m.test(content), `Trailing whitespace: ${file}`);
  for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = path.basename(match[1].split('|')[0].split('#')[0]);
    assert(stems.has(target), `Broken vault link in ${file}: ${target}`);
  }
}
const weights = readFileSync('AEO Scoring Vault/01 Specification/AEO Rubric Weights.md', 'utf8');
const rows = [...weights.matchAll(/^\| ([SC]\d) \|[^\n]*?\| (\d+) \|$/gm)];
assert(rows.length === 13, 'Expected all 13 rubric criteria');
assert(rows.filter(row => row[1][0] === 'S').reduce((a,row)=>a+Number(row[2]),0) === 40, 'Structure must total 40');
assert(rows.filter(row => row[1][0] === 'C').reduce((a,row)=>a+Number(row[2]),0) === 60, 'Content must total 60');
const workflow = readFileSync('.github/workflows/pr-evaluation.yml', 'utf8');
assert(workflow.includes('pull_request:') && workflow.includes('synchronize') && workflow.includes('opened'), 'Every PR must trigger evaluation');
assert(!/pull_request_target|paths-ignore:|^\s+paths:|secrets\./m.test(workflow.replace(/path: \|[\s\S]*?retention-days: 7/, '')), 'No privileged trigger, path exemptions, or deployment secrets');
assert(workflow.includes('contents: read') && workflow.includes('persist-credentials: false'), 'Read-only checkout required');
for (const match of workflow.matchAll(/uses: (\S+)/g)) assert(/@[a-f0-9]{40}$/.test(match[1]), 'Pin actions to full commit SHAs');
for (const command of ['npm run ci:checks', 'npm run ci:gate']) assert(workflow.includes(`run: ${command}`), `Missing CI command ${command}`);
const scripts = json('package.json').scripts;
const hasApp = files.some(file => /^(src|web|app)\//.test(file) && /\.(tsx?|jsx?)$/.test(file));
if (hasApp) for (const name of ['lint','typecheck','build']) {
  assert(typeof scripts[name] === 'string' && !/^(echo|true|exit 0)\b/.test(scripts[name]), `App code requires a real ${name} script`);
  assert(readFileSync('scripts/ci-checks.mjs', 'utf8').includes("['lint', 'typecheck', 'build']"), 'App checks must be registered in the CI runner');
}
console.log(`Checked ${files.length} files, JavaScript syntax, JSON, vault links, rubric weights, and workflow policy.`);
