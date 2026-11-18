import { createStore } from './store.mjs';
import { createAllowanceGuard } from './allowance-store.mjs';
import { createAnalyticsAllowanceGuard } from './analytics-allowance.mjs';
import { RESERVED_INVOCATION_CPU_MS } from './allowance-policy.mjs';
import { extract, normalizeTarget, retrieve } from './retrieval.mjs';
import { scoreAudit, RUBRIC_VERSION, ENGINE_VERSION } from './scoring.mjs';
import { assessWithContentFacts, CONTENT_FACTS_CALIBRATION_APPROVED, CONTENT_FACTS_RELEASE_ID } from './content-facts-runner.mjs';
import { createPipelineState, PIPELINE_VERSION } from './pipeline-state.mjs';
import { createSnapshotStore } from './snapshot-store.mjs';
import { createR2AllowanceGuard } from './allowance-r2.mjs';
import { createBrowserWorkflow, BROWSER_RETRIEVAL_VERSION } from './browser-workflow.mjs';

const ROUTE = '/api/v1/audits';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BODY_LIMIT = 4096;
const encoding = new TextEncoder();
// Offline envelopes only. Production remains disabled until actual D1 query,
// index, rejected-request and account-wide ingress costs have been bounded.
const REPORT_LIMIT = 256 * 1024;
const INVOCATION_COSTS = Object.freeze({ requests: 1, cpuMs: RESERVED_INVOCATION_CPU_MS, d1Reads: 10000, d1Writes: 100, d1StorageBytes: 512 * 1024 });
const POLL_COSTS = Object.freeze({ requests: 1, cpuMs: RESERVED_INVOCATION_CPU_MS, d1Reads: 10000, d1Writes: 2, d1StorageBytes: 4096 });


const MESSAGES = {
  invalid_input: 'Enter a valid public HTTP or HTTPS product-page URL.',
  rate_limited: 'The audit limit has been reached. Try again after the indicated wait.',
  not_found: 'This assessment link is unknown or has expired.',
  service_unavailable: 'The audit service is temporarily unavailable.',
  method_not_allowed: 'This route does not support that request method.',
  robots_blocked: 'The site’s robots policy blocks this audit.',
  robots_unavailable: 'The site’s robots policy could not be verified.',
  retrieval_timeout: 'The page did not finish loading within the audit time limit.',
  retrieval_failed: 'The page could not be retrieved or inspected.',
  unsupported_content: 'The URL did not return a supported HTML page.',
  response_too_large: 'The page exceeded the audit size limit.',
  assessment_timeout: 'The audit did not finish. Submit the URL again to retry.',
};

function problem(code, retryAfterSeconds = null) {
  return { code, message: MESSAGES[code], retryAfterSeconds };
}

function json(body, status, extra = {}) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      ...extra,
    },
  });
}

function errorResponse(status, code, retryAfterSeconds = null, headers = {}) {
  if (retryAfterSeconds !== null) headers['retry-after'] = String(retryAfterSeconds);
  return json({ version: '1', error: problem(code, retryAfterSeconds) }, status, headers);
}

function timestamp(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function assessment(audit, hit = false) {
  return {
    version: '1', id: audit.id, status: audit.status, statusUrl: ROUTE + '/' + audit.id,
    submittedUrl: audit.url, assessedUrl: audit.assessedUrl ?? null,
    createdAt: timestamp(audit.createdAt), completedAt: timestamp(audit.completedAt),
    expiresAt: timestamp(audit.expiresAt),
    cache: { hit, validUntil: timestamp(audit.cacheUntil) },
    report: audit.report, error: audit.error ? problem(audit.error) : null,
  };
}

async function submission(request, normalizeUrl) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '') ||
      !request.body || Number(request.headers.get('content-length')) > BODY_LIMIT) {
    throw new Error('Invalid request body');
  }
  const reader = request.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, 2000);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error('Request body timed out');
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) throw new Error('Request body too large');
      text += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof body.url !== 'string') {
      throw new Error('Invalid submission');
    }
    return normalizeUrl(body.url);
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function cacheKey(url, semanticEnabled = false, calibrated = CONTENT_FACTS_CALIBRATION_APPROVED, retained = false, browser = false) {
  return hex(await crypto.subtle.digest('SHA-256', encoding.encode('audit-v1:rubric-' + RUBRIC_VERSION + ':categories-1.2:scoring-' + ENGINE_VERSION + ':content-facts-1.0.0:ai-' + (semanticEnabled ? '1' : '0') + ':calibrated-' + (calibrated ? '1:' + CONTENT_FACTS_RELEASE_ID : '0') + ':pipeline-' + (retained ? PIPELINE_VERSION : 'legacy') + (browser ? ':retrieval-'+BROWSER_RETRIEVAL_VERSION : '') + ':' + url)));
}

async function rateKey(secret, address, windowStart) {
  const key = await crypto.subtle.importKey('raw', encoding.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoding.encode(windowStart + ':' + address)));
}

function retrievalProblem(error) {
  const codes = {
    robots_denied: 'robots_blocked', robots_unknown: 'robots_unavailable',
    timeout: 'retrieval_timeout', too_large: 'response_too_large',
    unsupported_content: 'unsupported_content',
  };
  return Object.hasOwn(codes, error?.code) ? codes[error.code] : 'retrieval_failed';
}

export function createAuditService({
  store, allowance, egress, secret, HTMLRewriter, AI, allowsProduct, normalizeUrl = normalizeTarget, now = Date.now, retrievePage = retrieve,
  extractPage = extract, scorePage = scoreAudit, contentCalibrationApproved = CONTENT_FACTS_CALIBRATION_APPROVED,
  snapshotStore, pipelineDb, requireSnapshots = false, assessContent = assessWithContentFacts,
  browserFlow, requireBrowser = false,
}) {
  async function admit(costs) {
    if (typeof allowance?.reserve !== 'function') return 'unavailable';
    try {
      const id = crypto.randomUUID();
      const result = await allowance.reserve({ id, costs, now: now() });
      if (result?.accepted === true && result.duplicate === false) return { id };
      return result?.accepted === false && result.reason === 'allowance_exhausted' ? 'exhausted' : 'unavailable';
    } catch { return 'unavailable'; }
  }
  function admissionError(result) {
    return result === 'exhausted' ? errorResponse(429, 'rate_limited') : errorResponse(503, 'service_unavailable');
  }
  async function run(audit, {resumeBrowser = false, grant} = {}) {
    const deadlineAt = now() + 25_000;
    let snapshot;
    let extracted;
    let report;
    let aiAttempted = false, profileRetained = false;
    const retained = Boolean(snapshotStore) || requireSnapshots || Boolean(browserFlow);
    const pipeline = retained ? createPipelineState({ db: pipelineDb, auditId: audit.id, now }) : null;
    let stage = 'retrieval';
    try {
      if (browserFlow && !resumeBrowser) {
        await pipeline?.record('retrieval','running','browser_loading');
        await browserFlow.capture(audit,grant,pipeline);
        return;
      }
      if (resumeBrowser) {
        await pipeline?.load();
        stage = 'snapshot';
        const captured = await browserFlow.read(audit.id);
        snapshot = captured.snapshot;
        extracted = captured.extracted;
        if (!snapshot?.browser?.initialExtracted || !extracted || typeof extracted !== 'object') throw new Error('Invalid browser snapshot');
        report = scorePage(snapshot,extracted,{initialExtracted:snapshot.browser.initialExtracted});
      } else {
      await pipeline?.record('retrieval', 'running', 'downloading');
      snapshot = await retrievePage(audit.url, {
        egress, captureHtml: retained, consumeHtml: page => extractPage(page, { HTMLRewriter }),
      });
      const observedAt = new Date(now()).toISOString();
      extracted = snapshot.extracted ?? await extractPage(snapshot, { HTMLRewriter });
      if (extracted.coverage.usable !== true && !snapshot.htmlLimited) throw new Error('Unusable HTML');
      snapshot = { ...snapshot, observedAt };
      await pipeline?.record('retrieval', 'completed', 'downloaded');
      report = scorePage(snapshot, extracted);
      if (retained) {
        stage = 'snapshot';
        if (!snapshotStore) throw new Error('Snapshot storage unavailable');
        await snapshotStore.preserve({ auditId: audit.id, snapshot, extracted, rawHtml: snapshot.rawHtml });
        // Model input must come from the durable, integrity-checked snapshot.
        const captured = await snapshotStore.read(audit.id);
        if (!captured) throw new Error('Snapshot expired or unavailable');
        snapshot = captured.snapshot;
        extracted = captured.extracted;
        await pipeline.record('snapshot', 'completed', 'snapshot_retained');
      }
      }
      if (AI && extracted.productHtml && report.coverage?.notMeasured !== 0) {
        stage = 'content';
        await pipeline?.record('category', 'running', 'classification_started');
        aiAttempted = true;
        const contentFacts = await assessContent({AI,allowance,now,snapshot,extracted,report,deadlineAt,calibrationApproved:contentCalibrationApproved,
          ...(retained ? {onProfile: async categoryProfile => {
            await snapshotStore.saveAssessment({ auditId: audit.id, kind: 'profile', artifact: {version:'1',categoryProfile} });
            profileRetained = true;
            await pipeline.record('category', 'completed', 'profile_retained');
            await pipeline.record('content', 'running', 'facts_preparing');
          }} : {})});
        for (const item of (contentFacts.stages ?? []).slice(0, 4)) await pipeline?.record(item.stage, item.status, item.code);
        if (contentFacts.status === 'assessed') {
          if (retained) {
            stage = 'snapshot';
            if (!profileRetained) throw new Error('Assessment profile was not retained');
            await snapshotStore.saveAssessment({ auditId: audit.id, kind: 'facts', artifact: contentFacts.replayArtifact });
            await pipeline.record('snapshot', 'completed', 'assessment_retained');
            stage = 'content';
          }
          report = scorePage(snapshot, extracted, {validatedFacts: contentFacts.facts, categoryProfile: contentFacts.categoryProfile,
            ...(resumeBrowser ? {initialExtracted:snapshot.browser.initialExtracted} : {})});
          if (contentFacts.limitation) report.coverage.limitations.push(contentFacts.limitation);
        }
        else {
          if (contentFacts.categoryProfile && (!retained || profileRetained)) report = scorePage(snapshot, extracted, { categoryProfile: contentFacts.categoryProfile,
            ...(resumeBrowser ? {initialExtracted:snapshot.browser.initialExtracted} : {}) });
          if (retained) { report.status = 'incomplete'; report.score = null; }
          report.coverage.limitations.push(contentFacts.reason);
        }
        if (!contentFacts.stages?.length) await pipeline?.record('content', contentFacts.status === 'assessed' ? 'completed' : 'failed', contentFacts.status === 'assessed' ? 'facts_validated' : 'content_unavailable');
      } else if (retained) {
        await pipeline.record('content', 'skipped', AI ? 'no_assessable_product' : 'ai_unavailable');
      }
      stage = 'scoring';
      await pipeline?.record('scoring', 'completed', report.status === 'complete' ? 'report_complete' : 'report_incomplete');
      if (pipeline) report.coverage.pipeline = pipeline.summary();
      if (encoding.encode(JSON.stringify(report)).byteLength > REPORT_LIMIT) throw new Error('Report exceeds storage limit');
    } catch (error) {
      if (pipeline) {
        try { await pipeline.record(stage, 'failed', stage === 'retrieval' ? 'retrieval_failed' : stage === 'snapshot' ? 'snapshot_unavailable' : 'assessment_failed'); } catch { /* D1 may be unavailable; terminal report still records safe diagnostics. */ }
      }
      if (pipeline && stage !== 'retrieval' && report) {
        report.status = 'incomplete';
        report.score = null;
        report.coverage.limitations.push(stage === 'snapshot' ? (aiAttempted ? 'The assessment inputs or results could not be retained and verified; no final score is available.' : 'The downloaded page could not be retained and verified; AI assessment did not start.') : 'The assessment pipeline did not finish; unresolved checks remain unmeasured.');
        report.coverage.pipeline = pipeline.summary();
        const completedAt = now();
        await store.finish(audit.id, { status: 'incomplete', report, assessedUrl: snapshot.url, completedAt,
          cacheUntil: Math.min(completedAt + HOUR, audit.expiresAt) });
        return;
      }
      await store.finish(audit.id, {
        status: 'unable_to_assess', error: retrievalProblem(error), completedAt: now(),
      });
      return;
    }
    const completedAt = now();
    await store.finish(audit.id, {
      status: report.status, report, assessedUrl: snapshot.url,
      completedAt, cacheUntil: Math.min(completedAt + HOUR, audit.expiresAt),
    });
    if (resumeBrowser) await browserFlow.finish(audit.id);
  }

  return async function handle(request, { defer, address } = {}) {
    const path = new URL(request.url).pathname;
    let reservationId, requestDone = false, backgroundDone = true, settling = false;
    async function settleCompleted() {
      if (!reservationId || !requestDone || !backgroundDone || settling) return;
      settling = true;
      // CPU and other invocation costs remain at their conservative upper bounds.
      try { await allowance.settle?.({ id: reservationId }); } catch {}
    }
    try {
      if (path === ROUTE) {
        if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed', null, { allow: 'POST' });
        let url;
        try { url = await submission(request, normalizeUrl); } catch { return errorResponse(400, 'invalid_input'); }
        if (allowsProduct && !allowsProduct(url)) {
          const error = problem('invalid_input');
          error.message = 'This preview accepts only its approved demo product URL.';
          return json({ version: '1', error }, 400);
        }
        if (!store || !egress?.fetch || (!browserFlow && typeof HTMLRewriter !== 'function') || typeof defer !== 'function' || (requireBrowser && !browserFlow) ||
            typeof secret !== 'string' || secret.length < 32 || typeof address !== 'string' ||
            !address || address.length > 64) return errorResponse(503, 'service_unavailable');
        const admission = await admit(INVOCATION_COSTS);
        if (!admission?.id) return admissionError(admission);
        reservationId = admission.id;
        const createdAt = now();
        const windowStart = Math.floor(createdAt / HOUR) * HOUR;
        const result = await store.reserve({
          id: crypto.randomUUID(), url, cacheKey: await cacheKey(url, Boolean(AI), contentCalibrationApproved, Boolean(snapshotStore) || requireSnapshots, Boolean(browserFlow)),
          rateKey: await rateKey(secret, address, windowStart), now: createdAt,
          expiresAt: createdAt + DAY, windowStart, windowEnd: windowStart + HOUR, limit: 5, globalLimit: 60,
          ...(browserFlow ? {leaseMs:120000} : {}),
        });
        if (result.kind === 'limited') return errorResponse(429, 'rate_limited', result.retryAfter);
        if (result.kind === 'cached') {
          if (encoding.encode(JSON.stringify(result.audit)).byteLength > REPORT_LIMIT) return errorResponse(503, 'service_unavailable');
          return json(assessment(result.audit, true), 200);
        }
        let grant;
        try { grant = browserFlow ? await browserFlow.prepare(result.audit) : undefined; }
        catch {
          await store.finish(result.audit.id, {status:'unable_to_assess',error:'service_unavailable',completedAt:now()});
          return errorResponse(503,'service_unavailable');
        }
        if (browserFlow && !grant?.accepted) {
          await store.finish(result.audit.id,{status:'unable_to_assess',error:'service_unavailable',completedAt:now()});
          return grant?.reason==='allowance_exhausted' ? errorResponse(429,'rate_limited') : errorResponse(503,'service_unavailable');
        }
        // If persistence becomes unavailable, polling resolves the abandoned lease.
        backgroundDone = false;
        defer(run(result.audit,{grant}).catch(() => {}).finally(async () => {
          backgroundDone = true;
          await settleCompleted();
        }));
        return json(assessment(result.audit), 202, { location: ROUTE + '/' + result.audit.id });
      }

      if (path.startsWith(ROUTE + '/')) {
        if (request.method !== 'GET') return errorResponse(405, 'method_not_allowed', null, { allow: 'GET' });
        const id = path.slice(ROUTE.length + 1);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return errorResponse(404, 'not_found');
        if (!store) return errorResponse(503, 'service_unavailable');
        const admission = await admit(browserFlow ? {...POLL_COSTS,d1Writes:100,d1StorageBytes:512*1024} : POLL_COSTS);
        if (!admission?.id) return admissionError(admission);
        reservationId = admission.id;
        const audit = await store.get(id, now());
        if (browserFlow && audit?.status==='pending' && typeof defer==='function' && await browserFlow.claim(id)) {
          backgroundDone = false;
          defer(run(audit,{resumeBrowser:true}).catch(()=>{}).finally(async()=>{backgroundDone=true;await settleCompleted();}));
        }
        if (audit && encoding.encode(JSON.stringify(audit)).byteLength > REPORT_LIMIT) return errorResponse(503, 'service_unavailable');
        return audit ? json(assessment(audit), 200) : errorResponse(404, 'not_found');
      }

      return errorResponse(404, 'not_found');
    } catch {
      return errorResponse(503, 'service_unavailable');
    } finally {
      requestDone = true;
      await settleCompleted();
    }
  };
}

export function handleAuditRequest(request, env, ctx, { egress = env.AUDIT_EGRESS, allowsProduct, normalizeUrl, retrievePage, contentCalibrationApproved = env.AUDIT_CONTENT_RELEASE === CONTENT_FACTS_RELEASE_ID, requireBrowser = false } = {}) {
  const db = env.AUDIT_DB;
  const accountId = env.AUDIT_BILLING_ACCOUNT_ID;
  const subscriptionId = env.AUDIT_BILLING_SUBSCRIPTION_ID;
  const analyticsToken = env.AUDIT_USAGE_READ_TOKEN;
  const billingScopeConfigured = typeof accountId === 'string' && /^[a-f0-9]{32}$/.test(accountId) &&
    typeof subscriptionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId);
  let snapshotStore;
  if (db && billingScopeConfigured && analyticsToken && env.AUDIT_SNAPSHOTS) {
    snapshotStore = createSnapshotStore({ db, bucket: env.AUDIT_SNAPSHOTS,
      allowance: createR2AllowanceGuard(db, { accountId, token: analyticsToken }) });
  }
  let browserFlow;
  if (db && snapshotStore && billingScopeConfigured && analyticsToken && env.AUDIT_BROWSER) {
    try { browserFlow = createBrowserWorkflow({db, binding:env.AUDIT_BROWSER, snapshots:snapshotStore, egress, accountId, subscriptionId, token:analyticsToken}); }
    catch { /* Invalid browser capabilities fail closed below. */ }
  }
  const service = createAuditService({
    store: db ? createStore(db) : null,
    allowance: db && billingScopeConfigured ? (
      typeof analyticsToken === 'string' && analyticsToken
        ? createAnalyticsAllowanceGuard(db, { accountId, subscriptionId, token: analyticsToken })
        : createAllowanceGuard(db, { accountId, subscriptionId })
    ) : undefined,
    egress, allowsProduct, normalizeUrl, retrievePage,
    contentCalibrationApproved: contentCalibrationApproved && env.AUDIT_PIPELINE_RELEASE === PIPELINE_VERSION,
    snapshotStore, pipelineDb: db, requireSnapshots: Boolean(env.AUDIT_AI) || requireBrowser, browserFlow, requireBrowser,
    secret: env.AUDIT_RATE_SECRET, AI: env.AUDIT_AI, HTMLRewriter: globalThis.HTMLRewriter,
  });
  return service(request, {
    defer: ctx.waitUntil.bind(ctx),
    address: request.headers.get('cf-connecting-ip'),
  });
}

export async function cleanupRetainedSnapshots({ db, snapshots, allowance, now = Date.now() }) {
  const id = `snapshot-cleanup-${crypto.randomUUID()}`;
  const admission = await allowance.reserve({ id, now,
    costs: { requests: 1, cpuMs: RESERVED_INVOCATION_CPU_MS, d1Reads: 10000, d1Writes: 200, d1StorageBytes: 4096 } });
  if (!admission?.accepted || admission.duplicate !== false) return { status: 'skipped' };
  const result = await snapshots.cleanup({ limit: 10 });
  await db.prepare('DELETE FROM audit_pipeline_state WHERE audit_id IN (SELECT audit_id FROM audit_pipeline_state WHERE expires_at <= ?1 LIMIT 100)').bind(now).run();
  // Work records contain no browser allowance holds; those are managed only by the watchdog.
  await db.prepare('DELETE FROM browser_audit_work WHERE audit_id IN (SELECT audit_id FROM browser_audit_work WHERE expires_at <= ?1 LIMIT 100)').bind(now).run();
  await allowance.settle?.({ id });
  return { status: 'completed', ...result };
}

export async function runScheduledMaintenance(event, env, {now = Date.now(), allowance: injectedAllowance, makeWorkflow = createBrowserWorkflow, makeSnapshots = createSnapshotStore} = {}) {
    if (!env.AUDIT_DB || !env.AUDIT_USAGE_READ_TOKEN) return;
    const db = env.AUDIT_DB;
    const scope = { accountId: env.AUDIT_BILLING_ACCOUNT_ID, subscriptionId: env.AUDIT_BILLING_SUBSCRIPTION_ID, token: env.AUDIT_USAGE_READ_TOKEN };
    const allowance = injectedAllowance ?? createAnalyticsAllowanceGuard(db, scope);
    // Every scheduled invocation must reserve its Worker and D1 costs first.
    const id = `browser-watchdog-${crypto.randomUUID()}`;
    try {
      const admitted = await allowance.reserve({id, now, costs: {requests:1, cpuMs:RESERVED_INVOCATION_CPU_MS, d1Reads:10000, d1Writes:100, d1StorageBytes:4096}});
      if (!admitted?.accepted || admitted.duplicate !== false) return;
      if (env.AUDIT_BROWSER) {
        const workflow = makeWorkflow({db, binding:env.AUDIT_BROWSER, ...scope});
        await workflow.watchdog();
      }
      await allowance.settle?.({id});
    } catch { return; } // Unknown work retains its reservation.
    // Keep retained-data cleanup hourly even if a scheduled event fires off the hour.
    const scheduledTime = Number(event?.scheduledTime ?? now);
    if (new Date(scheduledTime).getUTCMinutes() !== 0 || !env.AUDIT_SNAPSHOTS) return;
    const snapshots = makeSnapshots({ db, bucket: env.AUDIT_SNAPSHOTS,
      allowance: createR2AllowanceGuard(db, scope) });
    await cleanupRetainedSnapshots({ db, snapshots, allowance, now });
}

export default {
  fetch: handleAuditRequest,
  scheduled: runScheduledMaintenance,
};
