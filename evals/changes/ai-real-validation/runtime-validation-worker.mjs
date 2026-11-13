// Private, fixed-target release validation. The normal service retains all admission guards.
import { handleAuditRequest } from '../../../backend/service.mjs';
import { retrieve } from '../../../backend/retrieval.mjs';
import { createPublicEgress, normalizePublicTarget } from '../../../backend/public-egress.mjs';
import { createAllowanceGuard } from '../../../backend/allowance-store.mjs';
import { scoreAudit } from '../../../backend/scoring.mjs';
import { buildSemanticRequest } from '../../../backend/semantic-assessment.mjs';
import { buildContentFactsRequest } from '../../../backend/content-facts.mjs';
import { inspectProductSchema } from '../../../backend/structure-assessment.mjs';
const target = 'https://kokatat.com/naiad-pfd-lvhnai';
const encoder = new TextEncoder();

async function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const supplied = request.headers.get('authorization') || '';
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${secret}`)),
  ]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function readTarget(request) {
  if (!request.body) return false;
  const reader = request.body.getReader();
  let size = 0, text = '', timedOut = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const timer = setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}); }, 2000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) return false;
      if (done) break;
      size += value.byteLength;
      if (size > 2048) return false;
      text += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    return body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && body.url === target;
  } catch { return false; }
  finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// One persistent reservation per operator-supplied run ID; it includes no AI.
async function claimRun(env) {
  const id = env.AUDIT_VALIDATION_RUN_ID;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(id) || !env.AUDIT_DB) return false;
  try {
    const guard = createAllowanceGuard(env.AUDIT_DB, { accountId: env.AUDIT_BILLING_ACCOUNT_ID, subscriptionId: env.AUDIT_BILLING_SUBSCRIPTION_ID });
    const result = await guard.reserve({ id: `${id}:once`, costs: { requests: 1, cpuMs: 2000, d1Reads: 10000, d1Writes: 10, d1StorageBytes: 4096 } });
    return result?.accepted === true && result.duplicate === false;
  } catch { return false; }
}

async function inputHash(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function preparePreflight(snapshot) {
  const extracted = snapshot.extracted;
  if (!extracted || extracted.coverage?.usable !== true) throw new Error('Preflight extraction unavailable');
  const observed = { ...snapshot, observedAt: new Date().toISOString() };
  const report = scoreAudit(observed, extracted);
  const prepared = buildSemanticRequest(observed, extracted, report, { product: inspectProductSchema(observed, extracted).product });
  return buildContentFactsRequest(prepared);
}

async function settleRun(env) {
  const guard = createAllowanceGuard(env.AUDIT_DB, { accountId: env.AUDIT_BILLING_ACCOUNT_ID, subscriptionId: env.AUDIT_BILLING_SUBSCRIPTION_ID });
  return guard.settle({ id: `${env.AUDIT_VALIDATION_RUN_ID}:once` });
}

// Dependencies are injectable for offline protocol tests, never supplied by a request.
export function createValidationHandler({ handle = handleAuditRequest, retrievePage = retrieve, egress = createPublicEgress, claim = claimRun, settle = settleRun, preflight = preparePreflight } = {}) {
  return async function fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/v1/audits' || new URL(request.url).search) return new Response(null, { status: 404 });
    if (!await authorized(request, env.AUDIT_VALIDATION_SECRET)) return new Response(null, { status: 401 });
    if (!await readTarget(request)) return new Response(null, { status: 400 });
    let claimed = false;
    try { claimed = await claim(env); } catch { /* Fail closed. */ }
    if (claimed !== true) return new Response(null, { status: 429 });
    const modelCalls = [], pending = [];
    let snapshot = null, preflightProof = null, cachePhase = false, blockedCacheCalls = 0;
    const wrappedEnv = { ...env, AUDIT_AI: env.AUDIT_AI && { async run(model, input) {
      if (cachePhase) { blockedCacheCalls++; throw new Error('Provider disabled during cache verification'); }
      const call = { model, input, output: null, invoked: false, inputHash: null };
      modelCalls.push(call);
      const ordinal = modelCalls.length;
      try {
        call.inputHash = await inputHash(input);
        if (ordinal === 1) {
          const approved = env.AUDIT_VALIDATION_REQUEST_SHA256;
          if (typeof approved !== 'string' || !/^[0-9a-f]{64}$/.test(approved) || call.inputHash !== approved)
            throw new Error('Pre-reviewed model input changed');
        } else {
          throw new Error('Pre-reviewed model input changed');
        }
        call.invoked = true;
        call.output = await env.AUDIT_AI.run(model, input);
        return call.output;
      } catch (error) { call.error = error.message; throw error; }
    } } };
    const localCtx = { waitUntil(promise) { pending.push(promise); } };
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.set('content-type', 'application/json');
    const submissionRequest = new Request(request.url, { method: 'POST', headers, body: JSON.stringify({ url: target }) });
    const submissionResponse = await handle(submissionRequest, wrappedEnv, localCtx, {
      egress: egress(), normalizeUrl: normalizePublicTarget, allowsProduct: url => url === target,
      retrievePage: async (url, options) => {
        const value = await retrievePage(url, { ...options, observeSitemap: true, observeGuides: true });
        snapshot = value;
        const input = await preflight(value);
        const hash = await inputHash(input);
        const expected = env.AUDIT_VALIDATION_REQUEST_SHA256;
        const approved = typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected) && hash === expected;
        preflightProof = { input, inputHash: hash, approved };
        if (!approved) throw new Error('Pre-reviewed model input changed');
        return value;
      },
      contentCalibrationApproved: true,
    });
    const submission = await submissionResponse.json();
    const background = await Promise.allSettled(pending);
    if (background.some(result => result.status === 'rejected')) throw new Error('Operator work did not complete');
    if (!submissionResponse.ok || typeof submission.statusUrl !== 'string' || !/^\/api\/v1\/audits\/[0-9a-f-]{36}$/.test(submission.statusUrl))
      {
        const settlement = await settle(env);
        return Response.json({ submission, assessment: null, validation: { snapshot, preflight: preflightProof, modelCalls, cache: null, settlement } }, { status: settlement?.accepted ? submissionResponse.status : 502, headers: { 'cache-control': 'no-store' } });
      }
    const poll = new Request(new URL(submission.statusUrl, request.url), { headers });
    const assessmentResponse = await handle(poll, wrappedEnv, localCtx, {});
    const assessment = await assessmentResponse.json();
    const pollBackground = await Promise.allSettled(pending);
    if (pollBackground.some(result => result.status === 'rejected')) throw new Error('Poll work did not complete');
    let cache = null;
    if (assessmentResponse.ok && ['complete', 'incomplete'].includes(assessment.status)) {
      cachePhase = true;
      const callsBefore = modelCalls.filter(call => call.invoked).length;
      const cacheRequest = new Request(request.url, { method: 'POST', headers, body: JSON.stringify({ url: target }) });
      const cacheResponse = await handle(cacheRequest, wrappedEnv, localCtx, {
        egress: egress(), normalizeUrl: normalizePublicTarget, allowsProduct: url => url === target,
        retrievePage, contentCalibrationApproved: true,
      });
      const cached = await cacheResponse.json();
      const cacheBackground = await Promise.allSettled(pending);
      if (cacheBackground.some(result => result.status === 'rejected')) throw new Error('Cache work did not complete');
      cache = { status: cacheResponse.status, hit: cached.cache?.hit === true, sameid: cached.id === assessment.id && typeof assessment.id === 'string', noadditionalCalls: blockedCacheCalls === 0 && modelCalls.filter(call => call.invoked).length === callsBefore };
    }
    const settlement = await settle(env);
    const cachePassed = cache === null || (cache.status === 200 && cache.hit && cache.sameid && cache.noadditionalCalls);
    return Response.json({ submission, assessment, validation: { snapshot, preflight: preflightProof, modelCalls, cache, settlement } }, { status: cachePassed && settlement?.accepted ? assessmentResponse.status : 502, headers: { 'cache-control': 'no-store' } });
  };
}
export default { fetch: createValidationHandler() };
