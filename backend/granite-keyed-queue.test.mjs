import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { createAuditQueueRuntime, AUDIT_QUEUE_NAME, AUDIT_DEAD_QUEUE_NAME } from './audit-queue-runtime.mjs';
import { AUDIT_QUEUE_HORIZON_MS } from './audit-queue.mjs';
import { GRANITE_MODEL_CONFIG } from './granite-provider.mjs';
import { runPreparedAudit } from './prepared-assessment-consumer.mjs';
import { createPreparedAssessmentJobs } from './prepared-assessment-jobs.mjs';
import { scorePreparedDomainStructure } from './browser-support.mjs';
import { buildLiveReportModel } from '../src/live-report/model.ts';
import { createAuditService } from './service.mjs';
import { createStore } from './store.mjs';
import { createSnapshotStore } from './snapshot-store.mjs';
import { createBrowserContentWorkflow } from './browser-content-workflow.mjs';
import { prepareKeyedAudit } from './granite-keyed-prepared.mjs';
import { scoreBinaryBenchmark } from '../scripts/granite-binary-harness.mjs';
import { assessBinaryPolicy } from './rubric-policy.mjs';
import { inspectProductJsonLdPresence } from './structure-schema.mjs';
import { scoreReference } from '../scripts/scoring-foundations.mjs';
import rubricV3 from '../config/rubric.v3.mjs';
import { presentRubricV3 } from './rubric-presentation.mjs';
import { scoreAudit } from './scoring.mjs';
import { extract } from './retrieval.mjs';
import { derivePreparedObservations } from './prepared-derived.mjs';
import { HtmlTestRewriter } from './html-product-test-helper.mjs';
import { OPEN_RUBRIC_RELEASE_ID } from './ai-rubric-assessment.mjs';
import { CONTENT_FACTS_RELEASE_ID } from './content-facts-runner.mjs';
import { PIPELINE_VERSION } from './pipeline-state.mjs';
import { keyedGraniteEnabled, preparedAssessmentPolicy } from './prepared-assessment-policy.mjs';

const url = 'https://example.com/solar-kettle';
const html = `<!doctype html><html><head><title>Solar kettle</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Solar kettle"}</script></head><body><main>
<article class="product-detail"><h1>Solar kettle</h1><h2>Description</h2>
<p>This insulated solar kettle warms six cups of water during outdoor trips.<span class="bopis">Store text excluded from keyed evidence.</span></p>
<h2>Details</h2><ul><li>Brand: Example Outfitters</li><li>Material: Steel</li><li>Care: Hand wash only.</li></ul>
<aside><p>Recommended: other products</p></aside></article></main></body></html>`;
const encoder = new TextEncoder();
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  byte => byte.toString(16).padStart(2, '0')).join('');

async function keyedScenario(t, { interrupt = false, providerFailure = false, providerTimeout = false, invalidProvider = false, exhaustRetries = false, interruptStructure = false, missingAnswer = false, oldCache = false, retrievalFailure = false, exported, previous, finalizeExport, browserExport, failFinalizationSend = false, pastQueueHorizon = false } = {}) {
  if (providerTimeout) t.mock.timers.enable({apis:['setTimeout']});
  const sql = new DatabaseSync(previous?.database ?? exported?.database ?? finalizeExport?.database ?? ':memory:');
  t.after(() => sql.close());
  if (!previous) sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  let oldDigestWritten = false;
  const db = { prepare(query) {
    return { bind(...params) {
      if (interrupt && query.startsWith('INSERT OR IGNORE INTO model_question_results')) {
        sql.prepare("UPDATE model_attempts SET results_digest='old-validator-digest' WHERE status='received'").run();
        oldDigestWritten = true;
        throw Object.assign(new Error('Suspended after saving the old scoring digest'), { code: 'job_lease_lost' });
      }
      if ((exhaustRetries || oldDigestWritten) && query.startsWith('UPDATE model_attempts SET results_digest'))
        throw Object.assign(new Error('Suspended after raw D1 capture'), { code: 'job_lease_lost' });
      if (interruptStructure && query.startsWith("UPDATE prepared_assessment_checkpoints SET status='completed'") &&
          params[3] === 'programmatic-structure-v1')
        throw Object.assign(new Error('Suspended before saving the structure results'), { code: 'job_lease_lost' });
      const statement = sql.prepare(query);
      const args = params.length && /\?\d+/.test(query)
        ? [Object.fromEntries(params.map((value, index) => [String(index + 1), value]))] : params;
      return { query, first: async () => statement.get(...args) ?? null,
        all: async () => ({ results: statement.all(...args) }),
        run: async () => ({ meta: { changes: Number(statement.run(...args).changes) } }) };
    } };
  }, async batch(statements) {
    sql.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await (/^SELECT/i.test(statement.query) ? statement.all() : statement.run()));
      sql.exec('COMMIT');
      return results;
    } catch (error) {
      sql.exec('ROLLBACK');
      throw error;
    }
  } };
  let time = previous ? previous.time + 121000 : Date.UTC(2026, 10, 20);
  let submissions = 0;
  let domainRequests = 0;
  let sendFailures = 0;
  const now = () => time;
  const allowance = { reserve: async () => ({ accepted: true, duplicate: false }), settle: async () => ({ accepted: true }) };
  const messages = [], objects = new Map((previous?.objects ?? []).map(([key, bytes]) => [key, Uint8Array.from(atob(bytes), ch => ch.charCodeAt(0))]));
  const snapshots = createSnapshotStore({ db, now, allowance, bucket: {
    put: async (key, value) => objects.set(key, value.slice()),
    get: async key => { const value = objects.get(key); return value && { size: value.length, body: new Response(value).body }; },
    delete: async key => objects.delete(key),
  } });
  const workflow = createBrowserContentWorkflow({ db, snapshots, guard: {
    ...allowance, start: allowance.reserve, cancelUnstarted: async () => {},
  }, now, binding: { quickAction: async () => retrievalFailure ? new Response(null, {status: 502}) :
    Response.json({ success: true, result: html, meta: { finalUrl: url, status: 200 } }, { headers: { 'X-Browser-Ms-Used': '100' } }) },
  preprocess: async ({ rawHtml, sourceObjectKey, expiresAt }) => {
    const bytes = encoder.encode(html);
    return { html: bytes, preprocessing: { version: 'simplified-html-v1', representation: 'cleaned_rendered_html',
      originalCapturePreserved: true, sourceObjectKey, sourceSha256: await hash(rawHtml), sourceBytes: rawHtml.length,
      expiresAt, preparedAt: now(), outputBytes: bytes.length, outputSha256: await hash(bytes) } };
  } });
  const fetch = async (_url, request) => {
    if (previous) assert.fail('Continuation attempted another provider request');
    assert.equal(sql.prepare(`SELECT status FROM prepared_assessment_checkpoints
      WHERE checkpoint_key='programmatic-structure-v1'`).get().status, 'completed');
    if (request.method === 'GET') return Response.json({ success: true, result: { id: 'default', workers_ai_billing_mode: 'postpaid' } });
    submissions++;
    const body = JSON.parse(request.body), wire = body.response_format.json_schema;
    const meta = JSON.parse(body.messages[0].content.split('\n\n').at(-1));
    assert.equal(wire.properties.results.required.length, 13);
    assert.deepEqual(wire.properties.results.required, meta.questions.map(item => item.id));
    assert.doesNotMatch(body.messages[0].content, /Recommended|Store text excluded/);
    const results = Object.fromEntries(meta.questions.map(question => {
      const evidenceIds = question.passKinds.flatMap(kind => {
        const hit = meta.evidence.find(item => item.kind === kind && question.eligibleEvidenceIds.includes(item.id));
        return hit ? [hit.id] : [];
      });
      return [question.id, { answer: 'pass', reason: 'The product source supports the finding.', evidenceIds }];
    }));
    results['C3.availability'] = {answer:'fail',reason:'Granite could not confirm availability.',evidenceIds:[]};
    results['C2.essential'] = {answer:'pass',reason:'Granite accepted the product specifications.',evidenceIds:['unavailable-citation']};
    if (missingAnswer) delete results['C1.configuration'];
    if (providerTimeout) {
      assert.equal(GRANITE_MODEL_CONFIG.timeoutMs, 60_000);
      setImmediate(() => t.mock.timers.tick(GRANITE_MODEL_CONFIG.timeoutMs));
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), {once:true}));
    }
    if (providerFailure) return new Response('Provider unavailable', { status: 502 });
    const output = { results, category: { label: 'Solar camp kettles', evidenceId: meta.categoryEvidenceIds[0] } };
    return Response.json({ success: true, result: { response: JSON.stringify(output),
      usage: { prompt_tokens: 100, completion_tokens: 100, neurons: 5 } } });
  };
  const env = {
    AUDIT_DB: db, AUDIT_USAGE_READ_TOKEN: 'fixture', AUDIT_SNAPSHOTS: {}, AUDIT_BROWSER: {},
    AUDIT_QUEUE_MODE: 'enabled', AUDIT_QUEUE: { send: async body => {
      if (failFinalizationSend && body.kind === 'finalize_report' && sendFailures++ === 0) throw Error('fixture send failure');
      messages.push(structuredClone(body));
    } },
    AUDIT_AI_PROVIDER: invalidProvider ? 'unavailable' : 'granite', AUDIT_GRANITE_KEYED: 'enabled', AUDIT_AI_GATEWAY_TOKEN: 'fixture',
    AUDIT_RUBRIC_RELEASE: OPEN_RUBRIC_RELEASE_ID, AUDIT_CONTENT_RELEASE: CONTENT_FACTS_RELEASE_ID, AUDIT_PIPELINE_RELEASE: PIPELINE_VERSION,
  };
  const jobs = createPreparedAssessmentJobs(db, { now });

  const runtime = createAuditQueueRuntime(env, { now, allowance, queueAllowance: allowance, workflow, snapshots,
    derive: (input, options) => derivePreparedObservations(input, { ...options, HTMLRewriter: HtmlTestRewriter }),
    inspectDomain: value => scorePreparedDomainStructure(value, { fetcher: async (target, request) => {
      assert.ok(!previous, 'Continuation must reuse the previous resource results');
      assert.equal(request.redirect, 'manual');
      domainRequests++;
      const files = {
        '/robots.txt': 'User-agent: *\nDisallow: /private',
        '/sitemap.xml': `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url}</loc></url></urlset>`,
        '/llms.txt': '# Example Outfitters\n\nWe sell solar kettles and related outdoor equipment.\n\n[Product](' + url + ')',
      };
      const body = files[new URL(target).pathname];
      assert.ok(body, 'Unexpected domain request');
      const headers = { 'content-type': new URL(target).pathname.endsWith('.xml') ? 'application/xml' : 'text/plain' };
      return new Response(body, { headers });
    } }),
    assess: options => runPreparedAudit({ ...options, jobs, fetch }),
  });
  const policyVersion = preparedAssessmentPolicy('granite', keyedGraniteEnabled(env));
  const handle = createAuditService({ store: createStore(db, { policyVersion, queueEnabled: true }), policyVersion,
    allowance, egress: { fetch() { assert.fail('Unexpected page retrieval'); } }, secret: 'x'.repeat(32),
    normalizeUrl: value => value, now, browserFlow: workflow, requireBrowser: true, snapshotStore: snapshots,
    pipelineDb: db, enqueueAudit: auditId => runtime.start(auditId),
  });
  const options = { address: '192.0.2.1', defer: () => assert.fail('Queue work must be detached from the request') };
  const deliver = async (body, queue = AUDIT_QUEUE_NAME) => {
    let decision;
    await runtime.consume({ queue, messages: [{ body, ack() { decision = 'ack'; }, retry() { decision = 'retry'; } }] });
    return decision;
  };
  let submitted = previous?.submitted;
  let assessMessage = previous?.assessMessage;
  if (!previous) {
    if (oldCache) {
      const material = 'audit-v1:rubric-3.0.0:categories-1.2:scoring-2.2.1:content-facts-1.0.0:ai-0:calibrated-0:pipeline-retained-ai-1:open-rubric-off:retrieval-browser-content-v3:assessment-prepared-assessment-granite-keyed-v1:queue-v1:';
      sql.prepare(`INSERT INTO audits (id,url,cache_key,status,created_at,expires_at,completed_at,cache_until,report_json)
        VALUES ('8b1fb85d-af64-4d45-b1e3-78191ec55b59',?,?,'incomplete',?,?,?,?,'{"score":{"total":2}}')`)
        .run(url, await hash(encoder.encode(material + url)), time-2000,time+86400000,time-1000,time+3600000);
    }
    const response = await handle(new Request('https://worker/api/v1/audits', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }), options);
    assert.equal(response.status, 202);
    submitted = await response.json();
    assert.equal(submitted.status, 'pending');
    assert.equal(await deliver(messages.shift()), 'ack');
    if (retrievalFailure) {
      assert.equal(messages.length, 0);
      assert.equal(submissions, 0);
      const result = await handle(new Request('https://worker' + submitted.statusUrl), options);
      assert.equal(result.status, 200);
      const audit = await result.json();
      assert.equal(audit.status, 'unable_to_assess');
      assert.equal(audit.report, null);
      assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM audit_check_results').get().n, 0);
      return;
    }

    assert.equal(await deliver(messages.shift()), 'ack');
    assessMessage = messages.shift();
  }
  let decision = previous?.finalizeMessage ? null : await deliver(assessMessage);
  const diagnostics = () => JSON.stringify({queue:sql.prepare("SELECT state,code FROM audit_queue_jobs").get(),prepared:sql.prepare("SELECT state,code FROM prepared_assessment_jobs").get(),attempt:sql.prepare("SELECT status,outcome FROM model_attempts").get()});
  if (interrupt) {
    assert.equal(decision, 'retry', diagnostics());
    assert.equal(submissions, 1);
    assert.equal(sql.prepare('SELECT status FROM model_attempts').get().status, 'received');
    assert.equal(sql.prepare('SELECT results_digest FROM model_attempts').get().results_digest, 'old-validator-digest');
    assert.equal(sql.prepare('SELECT status FROM prepared_assessment_checkpoints WHERE checkpoint_key=\'granite-keyed\'').get().status, 'started');
    assert.equal(sql.prepare('SELECT status FROM audits').get().status, 'pending');
    const state = { time, submitted, assessMessage, objects: [...objects].map(([key, value]) => [key, Buffer.from(value).toString('base64')]) };
    if (exported) writeFileSync(exported.path, JSON.stringify({ ...state, database: exported.database }), { flag: 'wx', mode: 0o600 });
    return state;
  }
  if (interruptStructure) {
    assert.equal(decision, 'retry', diagnostics());
    assert.equal(sql.prepare('SELECT status FROM prepared_assessment_checkpoints').get().status, 'started');
    time += 121000;
    assert.equal(await deliver(assessMessage, AUDIT_DEAD_QUEUE_NAME), 'ack');
    const report = JSON.parse(sql.prepare('SELECT report_json FROM audits').get().report_json);
    const checks = report.criteria.flatMap(group => group.subchecks).flatMap(row => row.components);
    assert.equal(checks.find(check => check.id === 'S2.syntax').points, 2);
    assert.equal(checks.find(check => check.id === 'S5.search').status, 'not_measured');
    assert.equal(submissions, 0);
    assert.equal(domainRequests, 3);
    return;
  }
  if (exhaustRetries) {
    assert.equal(decision, 'retry', diagnostics());
    sql.prepare("UPDATE prepared_assessment_jobs SET attempts=5").run();
    time += 121000;
    decision = await deliver(assessMessage);
  }
  const reportRequest = async () => {
    const response = await handle(new Request('https://worker' + submitted.statusUrl), options);
    assert.equal(response.status, 200);
    return response.json();
  };
  if (!previous?.finalizeMessage) {
    assert.equal(decision, failFinalizationSend ? 'retry' : 'ack', diagnostics());
    if (failFinalizationSend) {
      assert.equal(sql.prepare('SELECT state FROM audit_queue_jobs').get().state, 'dispatching');
      assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM audit_check_results').get().n, 39);
      assert.equal(messages.length, 0);
    }
    assert.equal(await deliver(assessMessage), 'ack');
  }
  assert.equal(submissions, previous || invalidProvider ? 0 : 1, diagnostics());
  const finalizeMessage = previous?.finalizeMessage ?? messages.shift();
  assert.equal(finalizeMessage.kind, 'finalize_report');
  assert.equal(finalizeMessage.rubricVersion, '3.0.0');
  assert.equal(messages.length, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM audit_check_results').get().n, 39);
  if (pastQueueHorizon) time += AUDIT_QUEUE_HORIZON_MS;
  const staged = await reportRequest();
  assert.equal(staged.status, 'pending');
  assert.equal(staged.report, null);
  assert.ok(staged.checksCompletedAt);
  assert.ok(staged.progress.events.some(event => event.stage === 'retrieval' && event.status === 'completed'));
  assert.ok(staged.progress.events.some(event => event.stage === 'preparation' && event.status === 'completed'));
  assert.ok(staged.progress.events.some(event => event.stage === 'scoring' && event.status === 'completed'));
  const stages=sql.prepare('SELECT state_json FROM audit_pipeline_state').get();
  const markers=JSON.parse(stages.state_json).map(event=>event.code);
  assert.ok(markers.indexOf('report_building') < markers.indexOf('report_incomplete'));
  assert.ok(markers.indexOf(providerFailure || providerTimeout ? (providerTimeout ? 'model_timeout' : 'model_provider_failure') : 'judgments_validated') < markers.indexOf('report_building'));
  if (finalizeExport) {
    writeFileSync(finalizeExport.path, JSON.stringify({ time, submitted, finalizeMessage, database: finalizeExport.database }),
      { flag: 'wx', mode: 0o600 });
    return;
  }
  time += 1000;
  assert.equal(await deliver(finalizeMessage), 'ack');
  const audit = await reportRequest();
  assert.equal(audit.checksCompletedAt, staged.checksCompletedAt);
  assert.ok(audit.progress.revision > staged.progress.revision);
  assert.equal(Date.parse(audit.completedAt), time);
  time += 1000;
  assert.equal(await deliver(finalizeMessage), 'ack');
  assert.deepEqual(await reportRequest(), audit);
  if (oldCache) {
    const cached = await handle(new Request('https://worker/api/v1/audits', { method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({url}) }), options);
    assert.equal(cached.status,200);
    const body = await cached.json();
    assert.equal(body.cache.hit,true);
    assert.equal(body.id,submitted.id);
    const historical = await handle(new Request('https://worker/api/v1/audits/8b1fb85d-af64-4d45-b1e3-78191ec55b59'),options);
    assert.equal(historical.status,200);
    assert.equal((await historical.json()).report.score.total,2);
  }

  assert.equal(messages.length, 0);
  if (browserExport) writeFileSync(browserExport, JSON.stringify({ submitted, staged, audit }), { mode: 0o600 });
  assert.equal(audit.status, 'incomplete');
  assert.equal(audit.report.scoreBasis, 'earned_points');
  const stored = sql.prepare('SELECT component_id, result_json FROM audit_check_results').all();
  const results = new Map(stored.map(row => [row.component_id, JSON.parse(row.result_json)]));
  const earned = {structure: 0, content: 0};
  for (const group of audit.report.criteria) for (const row of group.subchecks) for (const component of row.components) {
    assert.deepEqual(results.get(component.id), component);
    if (component.status === 'measured') earned[group.pillar] += component.points;
  }
  assert.equal(domainRequests, previous ? 0 : 3);
  for (const id of ['S5.search', 'S5.ai-retrieval', 'S6.usable', 'S6.inclusion', 'S7.identity', 'S7.links', 'S2.syntax']) {
    const finding = results.get(id);
    assert.equal(finding.status, 'measured', `${id}: ${finding.reason}`);
    assert.ok(finding.evidenceIds.length, id);
  }
  assert.deepEqual(audit.report.score, {...earned, total: earned.structure + earned.content});

  assert.equal(audit.report.rubricVersion, '3.0.0');
  assert.equal(audit.report.coverage.total, 24);
  if (invalidProvider || exhaustRetries) {
    const code = invalidProvider ? 'invalid_assessment_provider' : 'job_retry_exhausted';
    assert.ok(audit.report.coverage.pipeline.stages.some(stage => stage.stage === 'content' &&
      stage.status === 'failed' && stage.code === code));
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM model_attempts").get().n, invalidProvider ? 0 : 1);
    return;
  }
  if (providerFailure || providerTimeout) {
    const code = providerTimeout ? 'model_timeout' : 'model_provider_failure';
    assert.equal(sql.prepare('SELECT outcome FROM model_attempts').get().outcome, code);
    assert.equal(sql.prepare('SELECT status FROM prepared_assessment_checkpoints WHERE checkpoint_key=\'granite-keyed\'').get().status, 'uncertain');
    assert.ok(audit.report.coverage.pipeline.stages.some(stage => stage.stage === 'content' &&
      stage.status === 'failed' && stage.code === code));
    return;
  }
  assert.equal(audit.report.category, 'open-rubric');
  assert.equal(audit.report.coverage.assessment.category, 'Solar camp kettles');
  const checks = audit.report.criteria.flatMap(criterion => criterion.subchecks);
  const evidence = new Map(audit.report.evidence.map(item => [item.id, item]));
  const check = id => checks.find(item => item.id === id);
  const component = id => checks.flatMap(item => item.components).find(item => item.id === id);
  assert.equal(component('C1.explanation').points, 4);
  assert.equal(component('C3.availability').points, 0);
  assert.equal(component('C3.availability').reason, 'Granite could not confirm availability.');
  assert.equal(check('C1.essential-specs').points, 14);
  assert.deepEqual(component('C2.essential').evidenceIds, []);
  const frontend = buildLiveReportModel(audit);
  assert.equal(frontend.checks.find(row => row.id === 'C1.essential-specs').components[0].reason,
    'Granite accepted the product specifications.');
  assert.equal(frontend.checks.find(row => row.id === 'C3.price-stock').components.find(item => item.id === 'C3.availability').reason,
    'Granite could not confirm availability.');
  assert.equal(component('C2.essential').reason, 'Granite accepted the product specifications.');
  const storedModel = sql.prepare('SELECT question_id,answer,reason,points,validation_status FROM model_question_results ORDER BY question_id').all();
  for (const row of storedModel) {
    const reported = component(row.question_id);
    assert.equal(reported.points, row.points);
    if (row.answer) {
      assert.equal(reported.reason, row.reason);
      assert.equal(row.validation_status, 'recorded');
    }
  }
  const markup = check('S2.product-markup');
  assert.equal(markup.earnedPoints, 3);
  assert.equal(markup.points, 3);
  assert.equal(markup.fraction, 1);
  assert.deepEqual(markup.components.map(({ id, status }) => [id, status]),
    [['S2.json-ld', 'measured'], ['S2.syntax', 'measured']]);
  assert.equal(evidence.get(component('S2.json-ld').evidenceIds[0]).method, 'rendered');
  assert.ok(audit.report.fixes.every(fix => fix.checkIds.every(id => check(id))));
  assert.ok(checks.every(row => row.evidenceIds.every(id => evidence.has(id))));
  assert.equal(checks.reduce((points, row) => points + row.earnedPoints, 0), audit.report.earnedPoints);
  assert.ok(audit.report.evidence.some(item => item.excerpt.includes('warms six cups')));
  assert.doesNotMatch(JSON.stringify(audit), /response_body_base64|model_attempts|chatcmpl/);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM model_attempts').get().n, 1);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM model_question_results WHERE answer IS NOT NULL').get().n, missingAnswer ? 12 : 13);
  t.diagnostic(`Verified queue report with ${checks.filter(check => check.status === 'measured').length} measured checks and ${submissions} model submissions in this process`);
}

const exitStage = process.env.AEO_KEYED_QUEUE_EXIT_STAGE;
const durableExit = process.env.AEO_DURABLE_EXIT_STAGE;
if (durableExit === 'export') {
  test('export after staging D1 results before finalization', async t => keyedScenario(t, {
    finalizeExport: { database: process.env.AEO_DURABLE_DB, path: process.env.AEO_DURABLE_EXPORT },
  }));
} else if (durableExit === 'resume') {
  test('publish only from the durable D1 export', async t => keyedScenario(t, {
    previous: JSON.parse(readFileSync(process.env.AEO_DURABLE_EXPORT, 'utf8')),
  }));
} else if (exitStage === 'export') {
  test('export interrupted keyed queue', async t => keyedScenario(t, { interrupt: true,
    exported: { database: process.env.AEO_KEYED_QUEUE_DB, path: process.env.AEO_KEYED_QUEUE_EXPORT } }));
} else if (exitStage === 'resume') {
  test('resume keyed queue from export', async t => keyedScenario(t, {
    previous: JSON.parse(readFileSync(process.env.AEO_KEYED_QUEUE_EXPORT, 'utf8')),
  }));
} else {
  test('rubric v3 preserves pillar totals and distinguishes zero, unresolved, and evidenced exclusions', () => {
    const scoringComponents = rubricV3.criteria.flatMap(criterion => criterion.subchecks);
    const categories = { categories: [{ id: 'test-product' }] };
    const checks = Object.fromEntries(scoringComponents.map(({ id }) => [id, { status: 'measured', fraction: 1 }]));
    const input = { category: 'test-product', checks };
    const grade = () => scoreReference(rubricV3, categories, input);
    assert.equal(grade().finalScore, 100);
    checks['C3.shipping'] = { status: 'measured', fraction: 0.5, evidence: 'e1' };
    assert.throws(grade, /Invalid binary credit/);
    checks['C3.shipping'] = { status: 'not_applicable', rule: 'pickup_only', justification: 'Pickup only.' };
    assert.throws(grade, /Missing exclusion evidence/);
    Object.assign(checks['C3.shipping'], { evidence: 'e1', url, location: 'fulfillment terms' });
    assert.equal(grade().finalScore, 100);

    const unmeasured = { status: 'not_measured', reason: 'The product URL was outside the inspected sitemap branch.' };
    const report = presentRubricV3({
      criteria: rubricV3.criteria.map(criterion => ({
        ...criterion, complete: criterion.id !== 'S6',
        subchecks: criterion.subchecks.map(item => ({
          ...item, status: 'measured', fraction: 1, points: item.maxPoints, evidenceIds: [],
          ...(item.id === 'S6.inclusion' && { ...unmeasured, fraction: null, points: null }),
        })),
      })), coverage: {}, fixes: [],
    });
    assert.deepEqual(report.criteria.map(group => group.id), ['S1', 'S2', 'S4', 'S5', 'C1', 'C3', 'C5']);
    const total = pillar => report.criteria.filter(c => c.pillar === pillar).reduce((points, c) => points + c.maxPoints, 0);
    assert.deepEqual([total('structure'), total('content')], [40, 60]);
    const sitemap = report.criteria.find(c => c.id === 'S5').subchecks.find(c => c.id === 'S5.sitemap');
    assert.deepEqual([sitemap.status, sitemap.points, sitemap.fraction, sitemap.earnedPoints], ['not_measured', null, null, 1]);
    assert.deepEqual([report.coverage.total, report.coverage.measured, report.coverage.notMeasured], [24, 23, 1]);
  });

  test('JSON-LD presence distinguishes parsed markup, confirmed absence, and incomplete evidence', () => {
    const extraction = jsonLd => ({ jsonLd, coverage: { html: true, jsonLdTruncated: false } });
    const snapshot = { url };
    const presence = (jsonLd, bounds = snapshot) => inspectProductJsonLdPresence(bounds, extraction(jsonLd));
    const grouped = JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'ProductGroup' }] });
    assert.equal(presence([grouped]).fraction, 1);
    assert.equal(presence([]).fraction, 0);
    assert.equal(presence([], { url, htmlLimited: 'bytes' }).status, 'not_measured');
    assert.deepEqual([presence(['{malformed']).status, presence(['{malformed']).fraction], ['measured', 0]);
    assert.equal(presence(['{malformed'], { url, htmlLimited: 'bytes' }).status, 'not_measured');
  });

  test('a limited heuristic comparison cannot substitute for a verified shopper-visible inventory', () => {
    const snapshot = { url, observedAt: '2026-11-22T20:00:00Z', retrievalMethod: 'browser_api_content' };
    const productHtml = { complete: true, singleConfiguration: true, identity: 'Solar kettle',
      blocks: [
        { text: 'This product weighs 10 oz.', location: 'product description' },
        { text: 'This product weighs 12 oz.', location: 'specifications' },
      ] };
    const extracted = { productHtml, jsonLd: [], coverage: { html: true, jsonLdTruncated: false } };
    const options = { requireAiAssessment: true, initialExtracted: { jsonLd: [], coverage: { html: false } } };
    const consistency = result => result.criteria.find(group => group.id === 'C5').subchecks.find(check => check.id === 'C5.consistency');
    const result = consistency(scoreAudit(snapshot, extracted, options));
    assert.deepEqual([result.status, result.points], ['not_measured', null]);
    assert.equal(consistency(scoreAudit(snapshot, { ...extracted, productHtml: { ...productHtml, complete: false } }, options)).status, 'not_measured');
  });

  test('policy checks require all necessary terms and withhold ambiguous evidence', () => {
    const observation = (...excerpts) => ({
      status: 'measured', fraction: 0.5,
      policyTerms: [{ evidence: excerpts.map(excerpt => ({ url, location: 'product policy', excerpt })) }],
    });
    const context = { snapshot: { url } };
    const supported = observation('We ship to the United States for all products.', 'Free shipping.', 'Delivery takes 3 business days.');
    assert.equal(assessBinaryPolicy('shipping', supported, context).fraction, 1);
    assert.equal(assessBinaryPolicy('shipping', observation('Free shipping.'), context).status, 'not_measured');
    const returns = observation('All products are eligible if unused and may be returned within 30 days.', 'Use the original packaging.');
    assert.equal(assessBinaryPolicy('returns', returns, context).fraction, 1);
    assert.equal(assessBinaryPolicy('returns', observation('Unused items may be returned within 30 days.'), context).status, 'not_measured');
    assert.equal(assessBinaryPolicy('returns', { status: 'measured', fraction: 0, url, location: 'complete policy', excerpt: 'No terms were found.' }).fraction, 0);
    const withProduct = excerpt => ({
      ...context, extracted: { productHtml: { complete: true, blocks: [{ text: excerpt, location: 'fulfillment terms' }] } },
    });
    const pickup = withProduct('This product is available for in-store pickup only. Shipping is unavailable.');
    assert.equal(assessBinaryPolicy('shipping', null, pickup).rule, 'pickup_only');
    assert.equal(assessBinaryPolicy('shipping', null, withProduct('This product is not available for pickup only. Shipping is unavailable.')).status, 'not_measured');
    assert.equal(assessBinaryPolicy('returns', null, withProduct('This product is final sale.')).fraction, 1);
    assert.equal(assessBinaryPolicy('returns', null, withProduct('This product is not final sale.')).status, 'not_measured');
    const missing = withProduct('This product is ready to order.');
    missing.snapshot.policies = { shipping: {
      state: 'read', url: new URL('/shipping', url).href,
      extraction: { complete: true, blocks: [{ text: 'Delivery estimates are not provided for all products.' }] },
    } };
    assert.equal(assessBinaryPolicy('shipping', null, missing).fraction, 0);
    missing.snapshot.policies.shipping.extraction.complete = false;
    assert.equal(assessBinaryPolicy('shipping', null, missing).status, 'not_measured');
  });

  test('queue publishes saved Granite answers, including without citations, via the normal report API', async t => keyedScenario(t, { browserExport: process.env.AEO_DURABLE_BROWSER_EXPORT }));
  test('a legacy cached score does not suppress a new audit and the new report is reusable', async t => keyedScenario(t, {oldCache:true}));
  test('a missing Granite answer leaves the other D1 scores intact', async t => keyedScenario(t, { missingAnswer: true }));
  test('finalization dispatch failure retries without another model request', async t => keyedScenario(t, { failFinalizationSend: true }));
  test('staged checks remain visible when finalization delivery crosses the queue horizon', async t => keyedScenario(t, { pastQueueHorizon: true }));
  test('a provider failure is retained and exposed as an incomplete assessment', async t => keyedScenario(t, { providerFailure: true }));
  test('a model timeout keeps measured programmatic points in the published report', async t => keyedScenario(t, { providerTimeout: true }));
  test('an unsupported provider still publishes the programmatic findings', async t => keyedScenario(t, { invalidProvider: true }));
  test('assessment retry exhaustion publishes the saved programmatic findings', async t => keyedScenario(t, { exhaustRetries: true }));
  test('terminal delivery recovers product findings without another resource inspection', async t => keyedScenario(t, { interruptStructure: true }));
  test('a retrieval failure publishes no report or score', async t => keyedScenario(t, { retrievalFailure: true }));
  test('an interrupted attempt is durable and leaves the audit pending for redelivery', async t => keyedScenario(t, { interrupt: true }));
  test('the singular apparel label retains composition and measured dimensions', async () => {
    const page = '<main><article class="product-detail"><h1>Drawstring Short</h1><ul>' +
      '<li>Material: 98% cotton, 2% elastane</li><li>Fit: Relaxed Fit, Inseam 6 inches</li></ul></article></main>';
    const bytes = encoder.encode(page);
    const preprocessing = {
      version: 'simplified-html-v1', representation: 'cleaned_rendered_html',
      originalCapturePreserved: true, sourceSha256: 'a'.repeat(64),
      sourceObjectKey: 'retained/' + 'a'.repeat(36) + '/' + 'b'.repeat(36) + '/html',
      sourceBytes: bytes.length, outputBytes: bytes.length, outputSha256: await hash(bytes),
    };
    const input = {
      snapshot: { url, rawHtml: bytes, retrievalMethod: 'browser_api_content', preprocessing,
        browser: { initialExtracted: {}, renderedHtml: page, coverage: { initialAvailable: false, renderedLimited: false } } },
      extracted: {}, source: { preparedHash: 'c'.repeat(64) },
    };
    const derived = await extract({ body: page, htmlLimited: null }, { HTMLRewriter: HtmlTestRewriter, keyed: true });
    const { fixture } = await prepareKeyedAudit('synthetic', input, derived);
    const question = fixture.questions.find(item => item.id === 'C2.essential');
    assert.deepEqual(question.passKinds, ['composition', 'fit_dimension']);
    assert.deepEqual(question.eligibleEvidenceIds.map(id => fixture.evidence.find(item => item.id === id).kind),
      ['composition', 'fit_dimension']);
  });

  test('prepared evidence preserves the head title and only cites an unambiguous selected primary control', async () => {
    const selected = '<input type="radio" name="pf-option1" value="123" form="pf" data-option-position="1" data-option-name="Stone" checked>';
    const price = '<sale-price> <span>Sale price</span>$64</sale-price>';
    const quickBuy = '<aside><input type="radio" name="quick-option2" value="xs" checked="checked" data-option-name="XS"></aside>';
    const make = async (duplicate, unsupported = false) => {
      const page = '<html><head><title>Drawstring Short - Stone | Brand</title></head><body><main>' +
        '<product-rerender id="product-info-main"><h1>Drawstring Short - Stone</h1><variant-picker form-id="pf">' +
        '<fieldset data-option-name="Color">' + selected + '</fieldset></variant-picker>' +
        (unsupported ? '<sale-price> <b>Sale price</b>$64</sale-price>' : price) + quickBuy +
        '<svg><title>Brand</title></svg></product-rerender>' + (duplicate ? selected + price : '') + '</main></body></html>';
      const bytes = encoder.encode(page);
      const preprocessing = { version: 'simplified-html-v1', representation: 'cleaned_rendered_html',
        originalCapturePreserved: true, sourceSha256: 'a'.repeat(64),
        sourceObjectKey: 'retained/' + 'a'.repeat(36) + '/' + 'b'.repeat(36) + '/html',
        sourceBytes: bytes.length, outputBytes: bytes.length, outputSha256: await hash(bytes) };
      const input = { snapshot: { url, rawHtml: bytes, retrievalMethod: 'browser_api_content', preprocessing,
        browser: { initialExtracted: {}, renderedHtml: page, coverage: { initialAvailable: false, renderedLimited: false } } },
        extracted: {}, source: { preparedHash: 'c'.repeat(64) } };
      const derived = await extract({ body: page, htmlLimited: null }, { HTMLRewriter: HtmlTestRewriter, keyed: true });
      return prepareKeyedAudit('synthetic', input, derived);
    };
    const prepared = await make(false), fixture = prepared.fixture;
    assert.ok(fixture.evidence.some(item => item.kind === 'title' && item.quote === 'Drawstring Short - Stone | Brand'));
    assert.deepEqual(fixture.evidence.filter(item => item.kind === 'observed_option').map(item => item.quote), [selected]);
    assert.equal(fixture.evidence.some(item => item.quote.includes('quick-option2')), false);
    assert.ok(fixture.evidence.some(item => item.kind === 'price' && item.quote === price));
    const ambiguous = (await make(true)).fixture;
    assert.ok(ambiguous.evidence.some(item => item.kind === 'observed_option'));
    assert.ok(ambiguous.evidence.some(item => item.kind === 'price'));
    const unrelatedPrice = (await make(true, true)).fixture;
    assert.equal(unrelatedPrice.evidence.some(item => item.kind === 'price'), false);
    const selectedId = fixture.evidence.find(item => item.kind === 'observed_option').id;
    const priceId = fixture.evidence.find(item => item.kind === 'price').id;
    const output = { results: Object.fromEntries([['C1.configuration', selectedId], ['C3.price', priceId]]
      .map(([id, evidenceId]) => [id, { answer: 'pass', reason: 'Claimed pass', evidenceIds: [evidenceId] }])) };
    const findings = scoreBinaryBenchmark(prepared.benchmark, output).findings;
    for (const id of ['C1.configuration', 'C3.price'])
      assert.equal(findings.find(item => item.id === id).status, 'not_measured');
    assert.equal(fixture.evidence.some(item => ['selected_stock', 'currency', 'compatibility'].includes(item.kind)), false);
  });

  test('the keyed policy only applies to opted-in Granite queue audits', () => {
    const enabled = { AUDIT_AI_PROVIDER: 'granite', AUDIT_QUEUE_MODE: 'enabled', AUDIT_GRANITE_KEYED: 'enabled' };
    assert.equal(keyedGraniteEnabled(enabled), true);
    assert.equal(keyedGraniteEnabled({ ...enabled, AUDIT_QUEUE_MODE: 'disabled' }), false);
    assert.equal(keyedGraniteEnabled({ ...enabled, AUDIT_AI_PROVIDER: 'terra' }), false);
    assert.equal(keyedGraniteEnabled({ ...enabled, AUDIT_GRANITE_KEYED: '' }), false);
    assert.notEqual(preparedAssessmentPolicy('granite'), preparedAssessmentPolicy('granite', true));
  });
}
