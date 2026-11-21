import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AI_MODEL_CONFIG } from '../../../backend/ai-model-config.mjs';
import { OPEN_RUBRIC_RELEASE_ID } from '../../../backend/ai-rubric-assessment.mjs';
import { CONTENT_FACTS_RELEASE_ID } from '../../../backend/content-facts-runner.mjs';
import { HtmlTestRewriter } from '../../../backend/html-product-test-helper.mjs';
import { PIPELINE_VERSION } from '../../../backend/pipeline-state.mjs';
import { runPreparedAudit } from '../../../backend/prepared-assessment-consumer.mjs';
import { createSnapshotStore } from '../../../backend/snapshot-store.mjs';
import { mixedProvider } from '../../../backend/fixtures/prepared-consumer/provider.mjs';

const manifest = JSON.parse(await readFile(new URL('./exit-export.json', import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'aeo-fresh-agent-'));
const copiedDb = join(directory, 'retained.sqlite');
const auditId = manifest.auditId;
const now = () => manifest.now;

function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const positions = new Set(sql.match(/\?\d+/g));
      return {
        bind(...values) {
          const keys = [...positions];
          const args = keys.length
            ? [Object.fromEntries(keys.map(key => [key, values[Number(key.slice(1)) - 1]]))]
            : values;
          return {
            first: async () => statement.get(...args) ?? null,
            all: async () => ({ results: statement.all(...args) }),
            run: async () => ({ meta: { changes: statement.run(...args).changes } }),
          };
        },
      };
    },
  };
}

function reportCheck(report, id, expectedStatus, expectedFraction) {
  const check = report.criteria.flatMap(criterion => criterion.subchecks).find(check => check.id === id);
  assert.equal(check.status, expectedStatus, id);
  assert.equal(check.fraction, expectedFraction, id);
  const evidence = report.evidence.filter(item => check.evidenceIds.includes(item.id));
  if (expectedStatus === 'measured') assert(evidence.some(item => item.excerpt.includes('Solar kettle')), id);
  else assert.deepEqual(evidence, [], id);
  return { status: check.status, fraction: check.fraction, points: check.points, evidence };
}

async function replay(sqlite) {
  const stored = JSON.parse(await readFile(manifest.objectsPath, 'utf8'));
  const unavailable = [];
  const objects = new Map(stored
    .filter(([key]) => !/\/(html|inputs)$/.test(key))
    .map(([key, value]) => [key, Buffer.from(value, 'base64')]));
  const bucket = {
    async get(key) {
      if (/\/(html|inputs)$/.test(key)) {
        unavailable.push(key);
        throw Error('Original input unavailable');
      }
      const bytes = objects.get(key);
      if (bytes) return { size: bytes.length, body: new Response(bytes).body };
    },
    async put(key, value) { objects.set(key, Buffer.from(value)); },
    async delete(keys) { for (const key of [].concat(keys)) objects.delete(key); },
  };
  const reservations = new Map();
  const settlements = [];
  const allowance = {
    async reserve({ id, costs }) {
      assert(!reservations.has(id));
      reservations.set(id, costs);
      return { accepted: true, duplicate: false };
    },
    async settle({ id, costs }) {
      settlements.push({ id, costs });
      return { accepted: true };
    },
  };
  const db = d1Adapter(sqlite);
  const snapshots = createSnapshotStore({ db, bucket, allowance, now });
  const env = {
    AUDIT_DB: db,
    AUDIT_AI_GATEWAY_TOKEN: 'offline-fixture',
    AUDIT_RUBRIC_RELEASE: OPEN_RUBRIC_RELEASE_ID,
    AUDIT_CONTENT_RELEASE: CONTENT_FACTS_RELEASE_ID,
    AUDIT_PIPELINE_RELEASE: PIPELINE_VERSION,
  };
  const calls = [];
  const callErrors = [];
  async function fetch(url, request) {
    calls.push(null);
    try {
      const body = JSON.parse(request.body);
      const headers = new Headers(request.headers);
      assert.equal(url, AI_MODEL_CONFIG.endpoint);
      assert.equal(body.model, 'openai/gpt-6.1-terra');
      assert.equal(request.method, 'POST');
      assert.equal(headers.get('cf-aig-gateway-id'), 'openai');
      assert.equal(headers.get('cf-aig-max-attempts'), '1');
      assert.equal(headers.get('authorization'), 'Bearer offline-fixture');
      assert.deepEqual(Object.keys(body.input).sort(), ['input', 'reasoning', 'stream', 'text']);
      assert.equal(body.input.reasoning.effort, 'low');
      assert.equal(body.input.text.format.type, 'json_object');
      assert.equal(body.input.stream, false);
      assert(Array.isArray(body.input.input));
      const prompt = body.input.input[0].content;
      assert(!prompt.includes('Extract relevant exact quotations'), 'Completed extraction was reissued');
      assert(!request.body.includes('ORIGINAL_ONLY_SENTINEL'));
      calls[calls.length - 1] = prompt.match(/Identify only the primary|Independently of any individual|Inspect this entire source|Judge every listed check/)?.[0];
      const { response } = mixedProvider({ messages: body.input.input });
      return Response.json({ success: true, errors: [], result: {
        object: 'response', status: 'completed', error: null, incomplete_details: null,
        output: [{ type: 'message', status: 'completed', role: 'assistant', content: [
          { type: 'output_text', text: JSON.stringify(response) },
        ] }],
      } });
    } catch (error) {
      callErrors.push(error);
      throw error;
    }
  }

  const checkpoints = sqlite.prepare('SELECT * FROM prepared_assessment_checkpoints WHERE audit_id=? ORDER BY checkpoint_key');
  assert.deepEqual(checkpoints.all(auditId).map(row => ({ ...row })), [manifest.firstCheckpoint]);
  assert.equal(sqlite.prepare('SELECT prepared_state FROM retained_snapshots WHERE audit_id=?').get(auditId).prepared_state, 'ready');
  assert.equal(sqlite.prepare('SELECT state FROM prepared_assessment_jobs WHERE audit_id=?').get(auditId).state, 'waiting');
  const progress = [];
  for (let invocation = 0; invocation < 20; invocation++) {
    const count = calls.length;
    const result = await runPreparedAudit({ env, auditId, now, allowance, snapshots, fetch });
    assert.deepEqual(callErrors, []);
    const issued = calls.length - count;
    assert(issued <= 1);
    assert.deepEqual({ ...checkpoints.all(auditId)[0] }, manifest.firstCheckpoint);
    progress.push({ ...result, newHttpCalls: issued });
    if (result.status === 'completed') break;
    assert.equal(result.status, 'yield', JSON.stringify(result));
  }

  assert.equal(progress.at(-1).status, 'completed');
  const job = sqlite.prepare('SELECT state, code FROM prepared_assessment_jobs WHERE audit_id=?').get(auditId);
  assert.equal(job.state, 'complete');
  assert.equal(job.code, 'assessment_completed');
  const completed = checkpoints.all(auditId);
  assert.equal(completed.length, manifest.completedHttpCalls + calls.length);
  assert(completed.every(item => item.status === 'completed'));
  assert(calls.length > 0);
  assert.equal(unavailable.length, 0);
  const [profile, facts] = await Promise.all([
    snapshots.readAssessment(auditId, 'profile'),
    snapshots.readAssessment(auditId, 'facts'),
  ]);
  for (const costs of reservations.values()) assert(!Object.hasOwn(costs, 'aiNeurons'));
  for (const { id, costs } of settlements) {
    assert(reservations.has(id));
    assert(!Object.hasOwn(costs ?? {}, 'aiNeurons'));
  }
  assert.equal(profile.category, 'Solar kettle');
  assert.deepEqual(facts.profile, profile);
  const diagnostic = facts.diagnostics.find(item => item.context === 'judgment:C1.explanation');
  assert(diagnostic);
  const audit = sqlite.prepare('SELECT status, report_json FROM audits WHERE id=?').get(auditId);
  const report = JSON.parse(audit.report_json);
  assert.equal(audit.status, 'incomplete');
  assert.equal(report.status, 'incomplete');
  assert.equal(report.score, null);
  assert.equal(report.coverage.assessment.mode, 'ai_rubric');
  const checks = {
    'C1.identity': reportCheck(report, 'C1.identity', 'measured', 1),
    'S4.title': reportCheck(report, 'S4.title', 'measured', 1),
    'C1.explanation': reportCheck(report, 'C1.explanation', 'not_measured', null),
  };

  return {
    initialCheckpointUnchanged: true,
    originalInputReadAttempts: unavailable.length,
    completedCheckpoints: completed.length,
    providerRequests: calls,
    progress,
    aiNeuronReservationsOrSettlements: 0,
    retainedProfileCategory: profile.category,
    retainedDiagnostic: diagnostic,
    auditStatus: audit.status,
    reportScore: report.score,
    reportEarnedPoints: report.earnedPoints,
    checks,
  };
}

globalThis.HTMLRewriter = HtmlTestRewriter;
globalThis.fetch = async () => { throw Error('Unmocked fetch forbidden'); };

let sqlite;
try {
  await copyFile(manifest.dbPath, copiedDb);
  sqlite = new DatabaseSync(copiedDb);
  const observations = await replay(sqlite);
  const result = {
    version: 1,
    changeId: 'uncap-ai-continuation',
    kind: 'fresh-agent',
    priorConversationProvided: false,
    agentId: 'simplified_ai_fresh_exit',
    status: 'passed',
    interruptionPoint: manifest.interruptionPoint,
    observedContinuation: 'The assessment resumed from its unchanged first checkpoint, completed using only the prepared capture, retained the profile and facts, and published the expected incomplete report with a null score and supported findings.',
    limitations: 'This replay uses a SQLite D1 adapter, an in-memory R2 adapter, mock allowance guards, and mock Terra Responses. It does not measure live provider behavior, production billing, or real model quality.',
    observations,
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  await writeFile(new URL('./exit-result.json', import.meta.url), json);
  process.stdout.write(json);
} finally {
  try { sqlite?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
}
