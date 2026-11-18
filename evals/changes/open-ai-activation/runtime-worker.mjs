// Temporary private validation endpoint. Deploy only with strictly-public egress and CPU 1000 ms.
import { createAnalyticsAllowanceGuard } from '../../../backend/analytics-allowance.mjs';
import { createR2AllowanceGuard } from '../../../backend/allowance-r2.mjs';
import { createSnapshotStore } from '../../../backend/snapshot-store.mjs';
import { createPublicEgress } from '../../../backend/public-egress.mjs';
import { retrieve, extract } from '../../../backend/retrieval.mjs';
import { scoreAudit } from '../../../backend/scoring.mjs';
import { assessRetainedRubric, restoreRubricAssessment } from '../../../backend/ai-rubric-assessment.mjs';

const targets = Object.freeze({
  kokatat: 'https://kokatat.com/naiad-pfd-lvhnai',
  synthetic: 'https://fixture.example/products/shorts',
  'native-known': 'https://fixture.example/products/shorts',
});
const fixture = '<!doctype html><html><head><title>Everyday Shorts</title><meta name="description" content="Everyday cotton shorts"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Everyday Shorts","description":"Cotton shorts with a relaxed fit and drawstring waist.","offers":{"@type":"Offer","price":"45","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script></head><body><main><h1>Everyday Shorts</h1><p>Cotton shorts with a relaxed fit and drawstring waist.</p><p>Machine wash cold. Available in sizes S, M and L.</p></main></body></html>';
const costs = Object.freeze({ requests: 1, cpuMs: 2000, d1Reads: 10000, d1Writes: 100, d1StorageBytes: 512 * 1024 });
const encoder = new TextEncoder();
async function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('authorization') || '')), crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${secret}`))]);
  return crypto.subtle.timingSafeEqual(a, b);
}
async function body(request) {
  if (!request.body) return null;
  const reader = request.body.getReader(); let size = 0, text = '', timedOut = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const timer = setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}); }, 2000);
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1024) return null; text += decoder.decode(part.value, { stream: true }); }
    if (timedOut) return null;
    const value = JSON.parse(text + decoder.decode());
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.caseId === 'string' ? value.caseId : null;
  } catch { return null; } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function response(value, status = 200) { return Response.json(value, { status, headers: { 'cache-control': 'no-store' } }); }
function fixtureEgress() { return { async fetch(url) { const path = new URL(url).pathname; return new Response(path === '/robots.txt' ? 'User-agent: *\nAllow: /' : path === '/products/shorts' ? fixture : '', { status: path === '/robots.txt' || path === '/products/shorts' ? 200 : 404, headers: { 'content-type': path === '/products/shorts' ? 'text/html' : 'text/plain' } }); } }; }
// Never return provider request echoes, token IDs, logs, or transport metadata.
function traceOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return {};
  const result = {};
  if (Object.hasOwn(output, 'response')) result.response = output.response;
  if (Array.isArray(output.choices)) result.choices = output.choices.slice(0, 1).map(choice => ({
    ...(typeof choice?.finish_reason === 'string' ? { finish_reason: choice.finish_reason } : {}),
    ...(typeof choice?.message?.content === 'string' ? { message: { content: choice.message.content } } : {}),
  }));
  if (output.usage && typeof output.usage === 'object') {
    result.usage = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'neurons']) {
      if (Number.isFinite(output.usage[key]) && output.usage[key] >= 0) result.usage[key] = output.usage[key];
    }
  }
  return result;
}
// Known, synthetic responses exercise the real decoders without accessing Workers AI.
export function knownResponseRunner() {
  const groups = ['C2.essential','C2.supporting','C4.intended-use','C4.compatibility','C4.limitations','C4.selection'];
  let calls = 0;
  return { async run(_model, input) {
    if (++calls > 40) throw Error('Simulated call cap');
    const system = input.messages[0].content, payload = JSON.parse(input.messages[1].content);
    let result;
    if (system.includes('Extract relevant exact quotations')) {
      const source = payload.source, quote = source.scope === 'product' && source.text.includes('Everyday Shorts') ? 'Everyday Shorts' : null;
      result = { evidence: quote ? [{sourceId:source.id,quote}] : [], primaryEvidence: quote ? [{sourceId:source.id,quote}] : [] };
    } else if (system.includes('Identify only the primary product category')) {
      result = {status:'classified',category:'Shorts',evidence:payload.primaryObservations.slice(0,1)};
    } else if (system.includes('Independently of any individual product page')) {
      result = {slots:groups.map((group,i)=>({id:`fixture-${i}`,group,label:`Question ${i}`,relevance:'Useful for shoppers',full:'Complete answer',partial:'Partial answer',zero:'No answer',missingExpectation:'A complete answer',applicability:'always',condition:null,conditionWhy:null}))};
    } else if (system.includes('Inspect this entire source section independently')) {
      result = {sourceId:payload.source.id,checks:[...payload.checks.map(x=>x.id),...payload.slots.map(x=>x.id)].map(id=>({id,status:'unknown',evidence:[]})),claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[]};
    } else if (system.includes('Judge every listed check')) {
      result = {judgments:[...payload.checks.map(x=>x.id),...payload.profile.slots.map(x=>x.id)].map(id=>({id,status:'not_measured',fraction:null,reason:'Synthetic control withholds judgment.',evidence:[]})),c5:{claims:[],comparisons:[]}};
    } else throw Error('Unexpected simulated stage');
    return {response:result};
  } };
}
// Simulated calls never touch real AI allowance or claim provider usage.
function simulatedAllowance() {
  let reservations=0;
  return {async reserve({costs}) { if (!Number.isSafeInteger(costs?.aiNeurons) || costs.aiNeurons < 0 || ++reservations > 40) return {accepted:false}; return {accepted:true,duplicate:false}; }, async settle() { return {accepted:true}; }};
}
function defaultDependencies(env) {
  const { AUDIT_DB: db, AUDIT_BILLING_ACCOUNT_ID: accountId, AUDIT_BILLING_SUBSCRIPTION_ID: subscriptionId, AUDIT_USAGE_READ_TOKEN: token } = env;
  if (!db || !env.AUDIT_SNAPSHOTS || !env.AUDIT_AI?.run || !/^[a-f0-9]{32}$/.test(accountId || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId || '') || typeof token !== 'string' || !token || !/^[A-Za-z0-9_-]{16,100}$/.test(env.AUDIT_VALIDATION_RUN_ID || '')) throw Error('configuration');
  const allowance = createAnalyticsAllowanceGuard(db, { accountId, subscriptionId, token });
  return { allowance, snapshots: createSnapshotStore({ db, bucket: env.AUDIT_SNAPSHOTS, allowance: createR2AllowanceGuard(db, { accountId, token }) }), retrieve, extract, score: scoreAudit, assess: assessRetainedRubric, replay: restoreRubricAssessment, egress: createPublicEgress(), AI: env.AUDIT_AI, HTMLRewriter: globalThis.HTMLRewriter };
}
// Injected dependencies exist only for offline tests; requests cannot supply them.
export function createValidationHandler({ dependencies = defaultDependencies } = {}) {
  return async function fetch(request, env) {
    const expiry = Number(env.AUDIT_VALIDATION_EXPIRES_AT), now = Date.now();
    if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + 3600000) return response({ error: 'not_found' }, 404);
    const path = new URL(request.url);
    if (request.method !== 'POST' || path.search || !['/validate', '/control'].includes(path.pathname)) return response({ error: 'not_found' }, 404);
    if (!await authorized(request, env.AUDIT_VALIDATION_SECRET)) return response({ error: 'unauthorized' }, 401);
    const caseId = await body(request);
    if (path.pathname === '/control' ? caseId !== 'control' : !Object.hasOwn(targets, caseId)) return response({ error: 'invalid_case' }, 400);
    let d, admission;
    try { d = dependencies(env); admission = await d.allowance.reserve({ id: `${env.AUDIT_VALIDATION_RUN_ID}:${caseId}`, costs }); } catch { return response({ error: 'admission_unavailable' }, 503); }
    if (!admission?.accepted || admission.duplicate !== false) return response({ error: 'admission_denied' }, 429);
    const reservationId = `${env.AUDIT_VALIDATION_RUN_ID}:${caseId}`;
    async function finish(value) {
      try { const settlement = await d.allowance.settle({ id: reservationId }); return response({ ...value, settlement: settlement?.accepted === true ? 'accepted' : 'unavailable' }, settlement?.accepted === true ? 200 : 502); }
      catch { return response({ ...value, settlement: 'unavailable' }, 502); }
    }
    const providerTrace = [];
    let sourceEvidence = null;
    try {
      if (caseId === 'control') return await finish({ caseId, status: 'ok', aiCalls: 0 });
      const auditId = crypto.randomUUID(), deadlineAt = Date.now() + 25000;
      let calls = 0, providerCalls = 0, traceBytes = 0;
      const simulated = caseId === 'native-known';
      const runner = simulated ? knownResponseRunner() : d.AI;
      const AI = { async run(...args) {
        if (++calls > 40) throw Error('Call cap'); if (!simulated) providerCalls++;
        try {
          const output = await runner.run(...args);
          if (!simulated && providerTrace.length < 40) {
            try {
              const encoded = JSON.stringify(traceOutput(output)), size = encoder.encode(encoded).length;
              if (encoded && traceBytes + size <= 64 * 1024) { providerTrace.push({ output: JSON.parse(encoded) }); traceBytes += size; }
              else providerTrace.push({ omitted: 'size_limit' });
            } catch { providerTrace.push({ omitted: 'serialization_failed' }); }
          }
          return output;
        } catch (error) {
          if (!simulated && providerTrace.length < 40) {
            const safe = {};
            if (['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError'].includes(error?.name)) safe.name = error.name;
            if (Number.isSafeInteger(error?.status) && error.status >= 0 && error.status <= 999) safe.status = error.status;
            if (Number.isSafeInteger(error?.code)) safe.code = error.code;
            providerTrace.push({ error: safe });
          }
          throw error;
        }
      } };
      const observed = await d.retrieve(targets[caseId], { egress: (caseId === 'synthetic' || simulated) ? fixtureEgress() : d.egress, captureHtml: true, observeSitemap: true, observeGuides: true, consumeHtml: page => d.extract(page, { HTMLRewriter: d.HTMLRewriter }) });
      const extracted = observed.extracted ?? await d.extract(observed, { HTMLRewriter: d.HTMLRewriter });
      const snapshot = { ...observed, observedAt: new Date().toISOString() };
      const retention = await d.snapshots.preserve({ auditId, snapshot, extracted, rawHtml: snapshot.rawHtml });
      const captured = await d.snapshots.read(auditId);
      const { rawHtml: originalHtml, extracted: ignoredExtracted, body: ignoredBody, ...originalMetadata } = snapshot;
      const originalBytes = typeof originalHtml === 'string' ? encoder.encode(originalHtml) : originalHtml;
      if (!(originalBytes instanceof Uint8Array) || !(captured.rawHtml instanceof Uint8Array) || originalBytes.length !== captured.rawHtml.length || originalBytes.some((byte,i)=>byte!==captured.rawHtml[i]) || JSON.stringify(originalMetadata) !== JSON.stringify(captured.snapshot) || JSON.stringify(extracted) !== JSON.stringify(captured.extracted)) throw Error('retention_mismatch');
      captured.snapshot.rawHtml = captured.rawHtml;
      const candidateSource = { snapshot: captured.snapshot, extracted: captured.extracted };
      if (encoder.encode(JSON.stringify(candidateSource)).length <= 128 * 1024) sourceEvidence = candidateSource;
      const preReport = d.score(captured.snapshot, captured.extracted, { requireAiAssessment: true });
      let profileRetained = false;
      const assessment = await d.assess({ AI, allowance: simulated ? simulatedAllowance() : d.allowance, snapshot: captured.snapshot, extracted: captured.extracted, report: preReport, deadlineAt, calibrationApproved: true, onProfile: async categoryProfile => { await d.snapshots.saveAssessment({ auditId, kind: 'profile', artifact: categoryProfile }); profileRetained = true; } });
      let report = preReport, replay = null, evidence = null;
      if (assessment.status === 'assessed') {
        if (!profileRetained) throw Error('profile');
        await d.snapshots.saveAssessment({ auditId, kind: 'facts', artifact: assessment.replayArtifact });
        report = d.score(captured.snapshot, captured.extracted, { aiAssessment: assessment.assessment });
        if (assessment.limitation) report.coverage.limitations.push(assessment.limitation);
        const [profile, artifact] = await Promise.all([d.snapshots.readAssessment(auditId, 'profile'), d.snapshots.readAssessment(auditId, 'facts')]);
        const callsBeforeReplay = calls;
        const restored = await d.replay(captured.snapshot, captured.extracted, artifact);
        const replayReport = d.score(captured.snapshot, captured.extracted, { aiAssessment: restored });
        if (assessment.limitation) replayReport.coverage.limitations.push(assessment.limitation);
        let mutationRejected = false;
        try { await d.replay({ ...captured.snapshot, observedAt: 'changed' }, captured.extracted, artifact); } catch { mutationRejected = true; }
        replay = { reportEqual: JSON.stringify(report) === JSON.stringify(replayReport), profileEqual: JSON.stringify(profile) === JSON.stringify(restored.profile), mutationRejected, noAI: calls === callsBeforeReplay };
        evidence = { profile, artifact, extracted: captured.extracted };
        if (encoder.encode(JSON.stringify(evidence)).length > 128 * 1024) evidence = null;
      } else {
        
        report.status = 'incomplete'; report.score = null; report.coverage.limitations.push(assessment.reason);
      }
      return await finish({ caseId, auditId, retention, report, ai: { status: assessment.status, stages: assessment.stages ?? [], calls, providerCalls, simulated, profileRetained }, providerTrace, replay, evidence, sourceEvidence });
    } catch { const settled = await finish({ caseId, error: 'validation_failed', providerTrace, sourceEvidence }); return new Response(settled.body, { status: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
  };
}
export default { fetch: createValidationHandler() };
