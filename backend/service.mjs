import { createStore } from './store.mjs';
import { createAllowanceGuard } from './allowance-store.mjs';
import { createAnalyticsAllowanceGuard } from './analytics-allowance.mjs';
import { RESERVED_INVOCATION_CPU_MS } from './allowance-policy.mjs';
import { extract, normalizeTarget, retrieve } from './retrieval.mjs';
import { scoreAudit } from './scoring.mjs';
import { assessWithContentFacts, CONTENT_FACTS_CALIBRATION_APPROVED, CONTENT_FACTS_RELEASE_ID } from './content-facts-runner.mjs';

const ROUTE = '/api/v1/audits';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BODY_LIMIT = 4096;
const encoding = new TextEncoder();
// Offline envelopes only. Production remains disabled until actual D1 query,
// index, rejected-request and account-wide ingress costs have been bounded.
const REPORT_LIMIT = 256 * 1024;
const INVOCATION_COSTS = Object.freeze({ requests: 1, cpuMs: RESERVED_INVOCATION_CPU_MS, d1Reads: 10000, d1Writes: 10, d1StorageBytes: 512 * 1024 });
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

async function cacheKey(url, semanticEnabled = false, calibrated = CONTENT_FACTS_CALIBRATION_APPROVED) {
  return hex(await crypto.subtle.digest('SHA-256', encoding.encode('audit-v1:rubric-1.0.0:categories-1.2:scoring-10:content-facts-1.0.0:ai-' + (semanticEnabled ? '1' : '0') + ':calibrated-' + (calibrated ? '1:' + CONTENT_FACTS_RELEASE_ID : '0') + ':' + url)));
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
  async function run(audit) {
    let snapshot;
    let report;
    try {
      snapshot = await retrievePage(audit.url, {
        egress, consumeHtml: page => extractPage(page, { HTMLRewriter }),
      });
      const observedAt = new Date(now()).toISOString();
      const extracted = snapshot.extracted ?? await extractPage(snapshot, { HTMLRewriter });
      if (extracted.coverage.usable !== true && !snapshot.htmlLimited) throw new Error('Unusable HTML');
      snapshot = { ...snapshot, observedAt };
      report = scorePage(snapshot, extracted);
      if (AI && extracted.productHtml && report.coverage?.notMeasured !== 0) {
        const contentFacts = await assessWithContentFacts({AI,allowance,now,snapshot,extracted,report,calibrationApproved:contentCalibrationApproved});
        if (contentFacts.status === 'assessed') {
          report = scorePage(snapshot, extracted, {validatedFacts: contentFacts.facts});
          if (contentFacts.limitation) report.coverage.limitations.push(contentFacts.limitation);
        }
        else report.coverage.limitations.push(contentFacts.reason);
      }
      if (encoding.encode(JSON.stringify(report)).byteLength > REPORT_LIMIT) throw new Error('Report exceeds storage limit');
    } catch (error) {
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
        if (!store || !egress?.fetch || typeof HTMLRewriter !== 'function' || typeof defer !== 'function' ||
            typeof secret !== 'string' || secret.length < 32 || typeof address !== 'string' ||
            !address || address.length > 64) return errorResponse(503, 'service_unavailable');
        const admission = await admit(INVOCATION_COSTS);
        if (!admission?.id) return admissionError(admission);
        reservationId = admission.id;
        const createdAt = now();
        const windowStart = Math.floor(createdAt / HOUR) * HOUR;
        const result = await store.reserve({
          id: crypto.randomUUID(), url, cacheKey: await cacheKey(url, Boolean(AI), contentCalibrationApproved),
          rateKey: await rateKey(secret, address, windowStart), now: createdAt,
          expiresAt: createdAt + DAY, windowStart, windowEnd: windowStart + HOUR, limit: 5, globalLimit: 60,
        });
        if (result.kind === 'limited') return errorResponse(429, 'rate_limited', result.retryAfter);
        if (result.kind === 'cached') {
          if (encoding.encode(JSON.stringify(result.audit)).byteLength > REPORT_LIMIT) return errorResponse(503, 'service_unavailable');
          return json(assessment(result.audit, true), 200);
        }
        // If persistence becomes unavailable, polling resolves the abandoned lease.
        backgroundDone = false;
        defer(run(result.audit).catch(() => {}).finally(async () => {
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
        const admission = await admit(POLL_COSTS);
        if (!admission?.id) return admissionError(admission);
        reservationId = admission.id;
        const audit = await store.get(id, now());
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

export function handleAuditRequest(request, env, ctx, { egress = env.AUDIT_EGRESS, allowsProduct, normalizeUrl, retrievePage, contentCalibrationApproved = env.AUDIT_CONTENT_RELEASE === CONTENT_FACTS_RELEASE_ID } = {}) {
  const db = env.AUDIT_DB;
  const accountId = env.AUDIT_BILLING_ACCOUNT_ID;
  const subscriptionId = env.AUDIT_BILLING_SUBSCRIPTION_ID;
  const analyticsToken = env.AUDIT_USAGE_READ_TOKEN;
  const billingScopeConfigured = typeof accountId === 'string' && /^[a-f0-9]{32}$/.test(accountId) &&
    typeof subscriptionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId);
  const service = createAuditService({
    store: db ? createStore(db) : null,
    allowance: db && billingScopeConfigured ? (
      typeof analyticsToken === 'string' && analyticsToken
        ? createAnalyticsAllowanceGuard(db, { accountId, subscriptionId, token: analyticsToken })
        : createAllowanceGuard(db, { accountId, subscriptionId })
    ) : undefined,
    egress, allowsProduct, normalizeUrl, retrievePage, contentCalibrationApproved, secret: env.AUDIT_RATE_SECRET, AI: env.AUDIT_AI, HTMLRewriter: globalThis.HTMLRewriter,
  });
  return service(request, {
    defer: ctx.waitUntil.bind(ctx),
    address: request.headers.get('cf-connecting-ip'),
  });
}

export default {
  fetch: handleAuditRequest,
  async scheduled(_event, env) {
    // Disabled until the D1 and ingress accounting envelope is independently bounded.
    void env;
  },
};
