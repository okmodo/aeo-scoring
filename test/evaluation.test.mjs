import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { validatePlan, validateTrace, validateHandoff, validateRun, validateExit, digestFiles, changedFiles, inScope } from '../scripts/evaluation.mjs';
const scenarios = JSON.parse(readFileSync('evals/fixtures/scenarios.json', 'utf8'));
const template = JSON.parse(readFileSync('evals/templates/plan.json', 'utf8'));
const checksum = data => createHash('sha256').update(data).digest('hex');
const clone = value => structuredClone(value);

test('frozen scenarios retain their committed input and expected-effect checksum', () => {
  const expected = readFileSync('evals/fixtures/SHA256SUMS', 'utf8').trim().split(/\s+/)[0];
  assert.equal(checksum(readFileSync('evals/fixtures/scenarios.json')), expected);
  assert.equal(scenarios.length, 5);
  for (const category of ['happy', 'edge', 'failure']) assert.ok(scenarios.some(s => s.category === category));
});
for (const scenario of scenarios) test(`frozen scenario: ${scenario.id}`, () => {
  const run = () => scenario.kind === 'trace' ? validateTrace(scenario.input, { allowedSideEffects: ['local-test-artifacts'] }) : validateHandoff(scenario.input);
  if (scenario.expected.accepted) assert.equal(run(), true);
  else assert.throws(run, new RegExp(scenario.expected.error));
});
test('valid contract defines all evaluation categories and exit applicability', () => assert.equal(validatePlan(clone(template)).version, 1));
for (const category of ['outcomes','process','styleEfficiency']) test(`reject missing ${category} criteria`, () => {
  const bad = clone(template); bad[category] = []; assert.throws(() => validatePlan(bad), /Missing/);
});
test('reject arbitrary shell commands in a plan', () => {
  const bad = clone(template); bad.commands = ['npm test; deploy']; assert.throws(() => validatePlan(bad), /named npm script/);
});
test('reject traversal or unrestricted wildcard scopes', () => {
  for (const pattern of ['../secrets','/**','**','scripts/../x','scripts/*']) {
    const bad = clone(template); bad.scope = [pattern]; assert.throws(() => validatePlan(bad));
  }
});
test('scope directory boundary does not include similarly prefixed files', () => {
  assert.equal(inScope('scripts/check.mjs',['scripts/**']),true);
  assert.equal(inScope('scripts-elsewhere/check.mjs',['scripts/**']),false);
});
test('reject unapproved side effects even if marked authorized', () => {
  const event = clone(scenarios[0].input); event[0].sideEffects = ['deployment'];
  assert.throws(() => validateTrace(event,{allowedSideEffects:['local-test-artifacts']}),/Unexpected side effect/);
});
test('reject time reversal and invalid command duration', () => {
  const events = clone(scenarios[0].input); events.push({...events[0],timestamp:'2020-01-01T00:00:00Z'});
  assert.throws(() => validateTrace(events,{allowedSideEffects:['local-test-artifacts']}),/ordered/);
  events.pop(); events[0].durationMs = -1;
  assert.throws(() => validateTrace(events,{allowedSideEffects:['local-test-artifacts']}),/duration/);
});
function validRun(plan,digest) {
  const commands = plan.commands.map(command=>({command,exitCode:0,durationMs:1,outputSha256:'a'.repeat(64)}));
  const trace = commands.map(command=>({...clone(scenarios[0].input[0]),action:command.command}));
  return {run:{version:1,changeId:plan.id,sourceDigest:digest,sourceCommit:'b'.repeat(40),recordedAt:'2026-11-04T20:00:00Z',traceCoverage:'evaluation-commands-only',traceLimitations:'Earlier agent work was not observed.',agentMetrics:{tokens:null,costUSD:null,note:'Host telemetry unavailable.'},commands},trace};
}
test('unavailable metrics are explicit and valid; stale or failed evidence is rejected', () => {
  const p = clone(template), {run,trace} = validRun(p,'digest');
  assert.equal(validateRun(p,run,trace,'digest'),true);
  assert.throws(()=>validateRun(p,run,trace,'changed'),/Stale/);
  run.commands[0].exitCode=1; assert.throws(()=>validateRun(p,run,trace,'digest'),/did not pass/);
});
test('reject a run missing a required command or its trace event', () => {
  const p=clone(template), data=validRun(p,'d'); data.run.commands.pop();
  assert.throws(()=>validateRun(p,data.run,data.trace,'d'),/Missing verification/);
});
test('required exit test cannot be replaced by a subprocess smoke test', () => {
  const p=clone(template); p.exitTest.required=true;
  assert.throws(()=>validateExit(p,{version:1,changeId:p.id,sourceDigest:'d',kind:'clean-process-smoke-only'},'d'),/fresh agent/);
});
test('exit-test record must be current and describe the actual continuation', () => {
  const p=clone(template); p.exitTest.required=true;
  const record={version:1,changeId:p.id,sourceDigest:'d',kind:'fresh-agent',priorConversationProvided:false,status:'passed',agentId:'fixture-agent',exportSha256:'c'.repeat(64),interruptionPoint:'Before validation',observedContinuation:'Ran frozen checks',limitations:'Not a production deployment'};
  assert.equal(validateExit(p,record,'d'),true);
  assert.throws(()=>validateExit(p,record,'new'),/stale/);
  delete record.observedContinuation; assert.throws(()=>validateExit(p,record,'d'),/incomplete/);
});
const gate = path.resolve('scripts/pr-gate.mjs');
function sandbox(callback) {
  const cwd=mkdtempSync(path.join(tmpdir(),'aeo-gate-'));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
  const write=(file,body)=>{mkdirSync(path.dirname(path.join(cwd,file)),{recursive:true});writeFileSync(path.join(cwd,file),body);};
  try {git('init','-q');write('.git/info/exclude','reports/\n');git('commit','--allow-empty','-qm','baseline');const base=git('rev-parse','HEAD');callback({cwd,git,write,base});}
  finally {rmSync(cwd,{recursive:true,force:true});}
}
function gateFixture(ctx,{sameCommit=false}={}) {
  const p=clone(template);p.id='example';p.scope=['evals/**','feature.txt'];
  ctx.write('evals/changes/example/plan.json',JSON.stringify(p));
  if(!sameCommit){ctx.git('add','.');ctx.git('commit','-qm','plan before implementation');}
  ctx.write('feature.txt','initial behavior\n');ctx.git('add','.');ctx.git('commit','-qm','implementation');
  ctx.write('evals/changes/example/handoff.json',JSON.stringify(scenarios[4].input));
  const digest=digestFiles(changedFiles(ctx.base,ctx.cwd),ctx.cwd);
  const {run,trace}=validRun(p,digest);
  ctx.write('evals/changes/example/run.json',JSON.stringify(run));
  ctx.write('evals/changes/example/trace.jsonl',trace.map(e=>JSON.stringify(e)).join('\n')+'\n');
}
function runGate(ctx) {return spawnSync(process.execPath,[gate,ctx.base],{cwd:ctx.cwd,encoding:'utf8',env:{...process.env,EVALUATION_BASE:'',GITHUB_STEP_SUMMARY:''}});}
test('PR gate accepts separately planned, current, scoped evidence',()=>sandbox(ctx=>{
  gateFixture(ctx);const result=runGate(ctx);assert.equal(result.status,0,result.stdout+result.stderr);
}));
test('PR gate rejects source edited after evaluation',()=>sandbox(ctx=>{
  gateFixture(ctx);ctx.write('feature.txt','changed behavior\n');const result=runGate(ctx);assert.notEqual(result.status,0);assert.match(result.stdout,/Stale evidence/);
}));
test('PR gate rejects implementation bundled into the planning commit',()=>sandbox(ctx=>{
  gateFixture(ctx,{sameCommit:true});const result=runGate(ctx);assert.notEqual(result.status,0);assert.match(result.stdout,/plans only/);
}));
test('PR gate rejects changed plan after its introduction',()=>sandbox(ctx=>{
  gateFixture(ctx);const file='evals/changes/example/plan.json';const p=JSON.parse(readFileSync(path.join(ctx.cwd,file),'utf8'));p.task='Weakened after implementation';ctx.write(file,JSON.stringify(p));
  const result=runGate(ctx);assert.notEqual(result.status,0);assert.match(result.stdout,/changed after/);
}));
test('PR gate rejects unplanned scope and PRs with no new plan',()=>sandbox(ctx=>{
  ctx.write('feature.txt','unplanned');ctx.git('add','.');ctx.git('commit','-qm','unplanned');
  let result=runGate(ctx);assert.notEqual(result.status,0);assert.match(result.stdout,/new task-specific/);
  gateFixture(ctx);ctx.write('unexpected.txt','outside scope');result=runGate(ctx);assert.notEqual(result.status,0);assert.match(result.stdout,/Out-of-scope/);
}));
test('fingerprint changes for source but not evaluation-record refresh',()=>sandbox(ctx=>{
  ctx.write('feature.txt','one');const files=['feature.txt','evals/changes/example/run.json'];const before=digestFiles(files,ctx.cwd);
  ctx.write('evals/changes/example/run.json','{}');assert.equal(digestFiles(files,ctx.cwd),before);
  ctx.write('feature.txt','two');assert.notEqual(digestFiles(files,ctx.cwd),before);
}));

test('CI executes mandatory plus task-specific checks once, including app checks when present', async () => {
  const { collectCommands } = await import('../scripts/ci-checks.mjs');
  const p=clone(template);p.commands.push('npm run regression');
  assert.deepEqual(collectCommands([p],{},false),['npm run check','npm test','npm run test:exit','npm run regression']);
  assert.throws(()=>collectCommands([p],{},true),/App needs/);
  assert.ok(collectCommands([p],{lint:'real-lint',typecheck:'real-tsc',build:'real-build'},true).includes('npm run typecheck'));
  p.commands=['npm run ci:checks'];assert.throws(()=>collectCommands([p],{},false),/recursively/);
});
test('PR gate rejects implementation committed before its plan',()=>sandbox(ctx=>{
  ctx.write('feature.txt','earlier work');ctx.git('add','.');ctx.git('commit','-qm','implementation before plan');
  gateFixture(ctx);const result=runGate(ctx);assert.notEqual(result.status,0);assert.match(result.stdout,/predates its plan/);
}));

// Lifecycle fixtures contain synthetic validator records only, never real command evidence.
function addPlan(ctx, id, scope = ['feature.txt', 'evals/**']) {
  const p = clone(template); p.id = id; p.scope = scope;
  ctx.write(`evals/changes/${id}/plan.json`, JSON.stringify(p));
  ctx.git('add', '.'); ctx.git('commit', '-qm', `plan ${id}`);
  return p;
}
function refreshFixtureRecords(ctx, plans) {
  for (const p of plans) ctx.write(`evals/changes/${p.id}/handoff.json`, JSON.stringify(scenarios[4].input));
  const digest = digestFiles(changedFiles(ctx.base, ctx.cwd), ctx.cwd);
  for (const p of plans) {
    const {run, trace} = validRun(p, digest);
    run.traceLimitations = 'Synthetic validator fixture only; these records do not claim command execution.';
    ctx.write(`evals/changes/${p.id}/run.json`, JSON.stringify(run));
    ctx.write(`evals/changes/${p.id}/trace.jsonl`, trace.map(e => JSON.stringify(e)).join('\n') + '\n');
  }
}
function commitFiles(ctx, message) { ctx.git('add', '.'); ctx.git('commit', '-qm', message); }
function acceptsGate(ctx) { const result = runGate(ctx); assert.equal(result.status, 0, result.stdout + result.stderr); }
function rejectsGate(ctx, message) { const result = runGate(ctx); assert.notEqual(result.status, 0); assert.match(result.stdout, message); }

test('PR gate accepts overlapping follow-up plans with refreshed evidence for all active plans', () => sandbox(ctx => {
  gateFixture(ctx);
  const first = JSON.parse(readFileSync(path.join(ctx.cwd, 'evals/changes/example/plan.json')));
  // Evidence is normally a separate commit, so the follow-up plan remains plans-only.
  commitFiles(ctx, 'first evaluation fixture');
  const second = addPlan(ctx, 'follow-up');
  ctx.write('feature.txt', 'follow-up implementation'); commitFiles(ctx, 'implement follow-up');
  refreshFixtureRecords(ctx, [first, second]); acceptsGate(ctx);
  ctx.write('feature.txt', 'stale follow-up'); rejectsGate(ctx, /Stale evidence/);
}));
test('PR gate accepts the next independent PR without refreshing earlier PR evidence', () => sandbox(ctx => {
  gateFixture(ctx); commitFiles(ctx, 'first PR records'); ctx.base = ctx.git('rev-parse', 'HEAD');
  const second = addPlan(ctx, 'next-pr');
  ctx.write('feature.txt', 'next PR implementation'); commitFiles(ctx, 'next implementation');
  refreshFixtureRecords(ctx, [second]); acceptsGate(ctx);
}));
test('plans already present in the base cannot authorize new PR implementation', () => sandbox(ctx => {
  gateFixture(ctx); commitFiles(ctx, 'first PR records'); ctx.base = ctx.git('rev-parse', 'HEAD');
  const p = addPlan(ctx, 'unrelated-next-pr', ['evals/**', 'unrelated.txt']);
  ctx.write('feature.txt', 'new implementation covered only by the previous PR plan');
  commitFiles(ctx, 'unplanned new implementation'); refreshFixtureRecords(ctx, [p]);
  rejectsGate(ctx, /Out-of-scope|predates its plan/);
}));
test('PR gate ignores newer upstream work both before and after merging the base', () => sandbox(ctx => {
  ctx.git('branch', 'upstream');
  const p = addPlan(ctx, 'upstream-safe', ['feature.txt', 'common.txt', 'evals/**']);
  ctx.write('feature.txt', 'planned feature'); commitFiles(ctx, 'feature work');
  ctx.git('checkout', '-q', 'upstream');
  ctx.write('common.txt', 'new upstream work'); commitFiles(ctx, 'upstream work');
  ctx.base = ctx.git('rev-parse', 'HEAD'); ctx.git('checkout', '-q', '-');
  refreshFixtureRecords(ctx, [p]); acceptsGate(ctx);
  commitFiles(ctx, 'feature fixture evidence');
  ctx.git('merge', '--no-ff', '-qm', 'merge upstream', 'upstream');
  refreshFixtureRecords(ctx, [p]); acceptsGate(ctx);
}));
test('PR gate rejects implementation and revert before the plan, including paths absent from the final diff', () => sandbox(ctx => {
  ctx.write('feature.txt', 'early implementation'); commitFiles(ctx, 'early work');
  ctx.git('revert', '--no-edit', 'HEAD');
  const p = addPlan(ctx, 'late'); refreshFixtureRecords(ctx, [p]);
  rejectsGate(ctx, /predates its plan/);
  ctx.write('feature.txt', 'restored after plan'); commitFiles(ctx, 'restore early work');
  refreshFixtureRecords(ctx, [p]); rejectsGate(ctx, /predates its plan/);
}));
test('a plan on another branch cannot retroactively authorize an implementation commit', () => sandbox(ctx => {
  ctx.git('branch', 'planning');
  ctx.write('feature.txt', 'unplanned branch work'); commitFiles(ctx, 'early work');
  ctx.git('checkout', '-q', 'planning'); const p = addPlan(ctx, 'side-plan');
  ctx.git('checkout', '-q', '-'); ctx.git('merge', '--no-ff', '-qm', 'merge plan later', 'planning');
  refreshFixtureRecords(ctx, [p]); rejectsGate(ctx, /predates its plan/);
}));
test('merge resolutions that introduce scoped work still require an ancestor plan', () => sandbox(ctx => {
  ctx.git('branch', 'upstream');
  ctx.git('commit', '--allow-empty', '-qm', 'feature branch');
  ctx.git('checkout', '-q', 'upstream'); ctx.git('commit', '--allow-empty', '-qm', 'upstream branch');
  ctx.git('checkout', '-q', '-'); ctx.git('merge', '--no-ff', '--no-commit', 'upstream');
  ctx.write('feature.txt', 'work introduced by merge'); commitFiles(ctx, 'merge with unplanned work');
  const p = addPlan(ctx, 'late-resolution'); refreshFixtureRecords(ctx, [p]);
  rejectsGate(ctx, /predates its plan/);
}));
test('PR gate rejects intermediate plan edits even when reverted before evaluation', () => sandbox(ctx => {
  gateFixture(ctx); commitFiles(ctx, 'fixture evidence');
  const file = 'evals/changes/example/plan.json'; const original = readFileSync(path.join(ctx.cwd, file));
  const p = JSON.parse(original); p.task = 'temporary changed contract';
  ctx.write(file, JSON.stringify(p)); commitFiles(ctx, 'edit immutable plan');
  ctx.write(file, original); commitFiles(ctx, 'restore plan');
  refreshFixtureRecords(ctx, [JSON.parse(original)]); rejectsGate(ctx, /changed after/);
}));
test('deletion and a real file containing the old tombstone have different fingerprints and stale evidence', () => sandbox(ctx => {
  ctx.write('feature.txt', 'baseline'); commitFiles(ctx, 'source baseline'); ctx.base = ctx.git('rev-parse', 'HEAD');
  const p = addPlan(ctx, 'delete-file'); ctx.git('rm', 'feature.txt'); commitFiles(ctx, 'planned deletion');
  refreshFixtureRecords(ctx, [p]); acceptsGate(ctx);
  const deleted = digestFiles(['feature.txt'], ctx.cwd);
  ctx.write('feature.txt', '<deleted>'); assert.notEqual(digestFiles(['feature.txt'], ctx.cwd), deleted);
  rejectsGate(ctx, /Stale evidence/);
}));
test('executable mode changes invalidate source evidence', () => sandbox(ctx => {
  gateFixture(ctx); chmodSync(path.join(ctx.cwd, 'feature.txt'), 0o644);
  const p = JSON.parse(readFileSync(path.join(ctx.cwd, 'evals/changes/example/plan.json')));
  refreshFixtureRecords(ctx, [p]); acceptsGate(ctx);
  chmodSync(path.join(ctx.cwd, 'feature.txt'), 0o755); rejectsGate(ctx, /Stale evidence/);
}));
test('symlink fingerprints bind link identity and target rather than dereferenced contents', () => sandbox(ctx => {
  const file = path.join(ctx.cwd, 'feature.txt');
  ctx.write('.git/target-a', 'same content'); ctx.write('.git/target-b', 'same content');
  symlinkSync('.git/target-a', file); const first = digestFiles(['feature.txt'], ctx.cwd);
  unlinkSync(file); symlinkSync('.git/target-b', file);
  assert.notEqual(digestFiles(['feature.txt'], ctx.cwd), first);
  unlinkSync(file); ctx.write('feature.txt', 'same content');
  assert.notEqual(digestFiles(['feature.txt'], ctx.cwd), first);
  unlinkSync(file); const missing = digestFiles(['feature.txt'], ctx.cwd);
  symlinkSync('missing-target', file); assert.notEqual(digestFiles(['feature.txt'], ctx.cwd), missing);
}));
test('retargeting a symlink to equal contents invalidates source evidence', () => sandbox(ctx => {
  const p = addPlan(ctx, 'symlink');
  ctx.write('.git/target-a', 'same content'); ctx.write('.git/target-b', 'same content');
  const file = path.join(ctx.cwd, 'feature.txt'); symlinkSync('.git/target-a', file);
  commitFiles(ctx, 'add planned symlink'); refreshFixtureRecords(ctx, [p]); acceptsGate(ctx);
  unlinkSync(file); symlinkSync('.git/target-b', file); rejectsGate(ctx, /Stale evidence/);
}));
test('source evidence supports file-to-directory and directory-to-file replacements', () => sandbox(ctx => {
  ctx.write('feature.txt', 'baseline file'); commitFiles(ctx, 'file baseline');
  ctx.base = ctx.git('rev-parse', 'HEAD');
  const p = addPlan(ctx, 'reshape', ['feature.txt', 'feature.txt/**', 'evals/**']);
  unlinkSync(path.join(ctx.cwd, 'feature.txt'));
  ctx.write('feature.txt/child.txt', 'directory replacement'); commitFiles(ctx, 'file becomes directory');
  assert.deepEqual(changedFiles(ctx.base, ctx.cwd).filter(file => file.startsWith('feature.txt')), ['feature.txt', 'feature.txt/child.txt']);
  refreshFixtureRecords(ctx, [p]); acceptsGate(ctx);
  ctx.write('feature.txt/child.txt', 'updated child'); rejectsGate(ctx, /Stale evidence/);
  refreshFixtureRecords(ctx, [p]); commitFiles(ctx, 'first PR records');
  ctx.base = ctx.git('rev-parse', 'HEAD');
  const next = addPlan(ctx, 'reshape-back', ['feature.txt', 'feature.txt/**', 'evals/**']);
  rmSync(path.join(ctx.cwd, 'feature.txt'), { recursive: true });
  ctx.write('feature.txt', 'file replacement'); commitFiles(ctx, 'directory becomes file');
  refreshFixtureRecords(ctx, [next]); acceptsGate(ctx);
  ctx.write('feature.txt', 'updated replacement'); rejectsGate(ctx, /Stale evidence/);
}));
