import { privateProviderError } from './private-provider-error.mjs';
// Private, fixed-input synthetic validation; all model admission remains in the normal runner.
import { assessWithContentFacts } from '../../../backend/content-facts-runner.mjs';
import { createAllowanceGuard } from '../../../backend/allowance-store.mjs';
import { scoreAudit } from '../../../backend/scoring.mjs';
import { assessContentFacts } from '../../../backend/fact-grading.mjs';
import { buildSemanticRequest } from '../../../backend/semantic-assessment.mjs';
import { inspectProductSchema } from '../../../backend/structure-assessment.mjs';
import { buildContentFactsRequest } from '../../../backend/content-facts.mjs';

const ids = new Set(['running-shoes', 'casual-daypacks', 'personal-flotation-devices', 'handbags', 'basic-tshirts']);
const encoder = new TextEncoder();
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('authorization') || '')),
    crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${secret}`)),
  ]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}
async function hasEmptyBody(request) {
  if (!request.body) return true;
  const reader = request.body.getReader();
  let timer;
  try {
    const read = async () => {
      for (let chunks = 0; chunks < 16; chunks++) {
        const { done, value } = await reader.read();
        if (done) return true;
        if (value?.byteLength) return false;
      }
      return false;
    };
    return await Promise.race([read(), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
  } catch { return false; }
  finally { clearTimeout(timer); reader.cancel().catch(() => {}); }
}
async function loadCases() {
  return (await import('./synthetic-cases.json', { with: { type: 'json' } })).default;
}
function preflight(item) {
  const prepared = buildSemanticRequest(item.snapshot, item.extracted, item.report, { product: inspectProductSchema(item.snapshot, item.extracted).product });
  return buildContentFactsRequest(prepared);
}
export function createSyntheticHandler({ cases = loadCases, guard = (db, options) => createAllowanceGuard(db, options), run = assessWithContentFacts, grade = assessContentFacts, score = scoreAudit, prepare = preflight, now = Date.now } = {}) {
  return async function fetch(request, env) {
    const url = new URL(request.url), match = /^\/validate\/([a-z-]+)$/.exec(url.pathname);
    if (request.method !== 'POST' || url.search || !match || !ids.has(match[1])) return new Response(null, { status: 404 });
    if (!await authorized(request, env.AUDIT_VALIDATION_SECRET)) return new Response(null, { status: 401 });
    if (!await hasEmptyBody(request)) return new Response(null, { status: 400 });
    const id = match[1], runId = env.RUN_ID;
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(runId) || !env.AUDIT_DB) return new Response(null, { status: 429 });
    let item, allowance, claim;
    try {
      const frozen = await cases();
      if (!Array.isArray(frozen) || frozen.length !== ids.size || new Set(frozen.map(entry => entry.id)).size !== ids.size || frozen.some(entry => !ids.has(entry.id))) throw new Error('Invalid cases');
      item = frozen.find(entry => entry.id === id);
      if (!/^[0-9a-f]{64}$/.test(item.requestHash) || await hash(await prepare(item)) !== item.requestHash) throw new Error('Input mismatch');
      allowance = guard(env.AUDIT_DB, { accountId: env.AUDIT_BILLING_ACCOUNT_ID, subscriptionId: env.AUDIT_BILLING_SUBSCRIPTION_ID });
      claim = await allowance.reserve({ id: `${runId}:${id}`, costs: { requests: 1, cpuMs: 2000, d1Reads: 10000, d1Writes: 10, d1StorageBytes: 4096 } });
    } catch { return new Response(null, { status: 503 }); }
    if (claim?.accepted !== true || claim.duplicate !== false) return new Response(null, { status: 429 });
    const started = now(), modelCalls = [];
    let active = 0, verified = false;
    const AI = env.AUDIT_AI && { async run(model, input) {
      const call = { model, input, output: null, invoked: false, inputHash: null };
      modelCalls.push(call);
      const ordinal = modelCalls.length;
      try {
        if (ordinal > (id === 'basic-tshirts' ? 2 : 1)) throw new Error('Call limit exceeded');
        call.inputHash = await hash(input);
        if (ordinal === 1) {
          if (call.inputHash !== item.requestHash) throw new Error('Input mismatch');
          verified = true;
        } else if (!verified) throw new Error('Input mismatch');
        call.invoked = true;
        active++;
        try { call.output = await env.AUDIT_AI.run(model, input); return call.output; }
        catch (error) { call.providerError = privateProviderError(error); throw error; }
        finally { active--; }
      } catch (error) { call.error = ['Call limit exceeded', 'Input mismatch'].includes(error?.message) ? error.message : 'Provider error'; throw error; }
    } };
    let assessmentResult, grading = null, scored = null, claimSettlement = null;
    try {
      assessmentResult = await run({ AI, allowance, snapshot: item.snapshot, extracted: item.extracted, report: item.report, calibrationApproved: true });
      if (assessmentResult?.facts) {
        grading = grade(item.snapshot, item.extracted, assessmentResult.facts);
        scored = score(item.snapshot, item.extracted, { validatedFacts: assessmentResult.facts });
      }
      if (active === 0) claimSettlement = await allowance.settle({ id: `${runId}:${id}` });
    } catch { return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } }); }
    return Response.json({ caseId: id, assessmentResult, grade: grading, score: scored, modelCalls, claimSettlement, elapsedMs: now() - started }, { status: claimSettlement?.accepted ? 200 : 503, headers: { 'cache-control': 'no-store' } });
  };
}
export default { fetch: createSyntheticHandler() };
