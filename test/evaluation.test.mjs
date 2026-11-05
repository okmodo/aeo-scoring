import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  try {git('init','-q');git('commit','--allow-empty','-qm','baseline');const base=git('rev-parse','HEAD');callback({cwd,git,write,base});}
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
