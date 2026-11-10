// Isolated, fixed-input runtime experiment; no AI or database bindings.
import shirt from '../fixtures/complete-engine/complete-shirt.html?raw';
import support from '../fixtures/complete-engine/support.json';
import { referenceShirtResponse } from '../fixtures/content-facts/reference-shirt.mjs';
import { syntheticCases } from './cases.mjs';
import { extract, retrieve } from '../retrieval.mjs';
import { createPublicEgress } from '../public-egress.mjs';
import { scoreAudit } from '../scoring.mjs';
import { buildSemanticRequest } from '../semantic-assessment.mjs';
import { inspectProductSchema } from '../structure-assessment.mjs';
import { buildContentFactsRequest, decodeContentFacts } from '../content-facts.mjs';

const cases = syntheticCases(shirt);
const emptyFacts = '{"facts":[],"inspections":[]}';
const encoder = new TextEncoder();
const missing = () => new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
const summarize = (name, snapshot, extracted, report, extra = {}) => ({ case: name, status: report.status,
  measured: report.coverage.measured, notMeasured: report.coverage.notMeasured,
  blocks: extracted.productHtml.blocks.length, htmlLimited: snapshot.htmlLimited, score: report.score, ...extra });
function prepare(snapshot, extracted, report) {
  return buildSemanticRequest(snapshot, extracted, report, { product: inspectProductSchema(snapshot, extracted).product });
}
async function runCase(name) {
  const fixture = cases[name];
  const target = 'https://shop.example/products/everyday-tshirt';
  const egress = { async fetch(url) {
    return url === target ? new Response(fixture.html, { headers: { 'content-type': 'text/html' } }) : new Response(null, { status: 404 });
  } };
  const snapshot = await retrieve(target, { egress, timeoutMs: 8000, consumeHtml: page => extract(page) });
  Object.assign(snapshot, support, { observedAt: '2026-11-09T00:00:00.000Z' });
  const extracted = snapshot.extracted;
  if (fixture.limited && snapshot.htmlLimited !== fixture.limited) throw new Error('Stream cap was not applied');
  const baseline = scoreAudit(snapshot, extracted, { category: 'basic-tshirts' });
  const prepared = prepare(snapshot, extracted, { ...baseline, category: 'basic-tshirts' });
  let factsRequest;
  try { factsRequest = buildContentFactsRequest(prepared); }
  catch (error) {
    if (fixture.reject && /Unsafe source instructions/.test(error.message)) return summarize(name, snapshot, extracted, baseline, { facts: 'rejected_unsafe' });
    throw error;
  }
  if (fixture.reject) throw new Error('Unsafe fixture was accepted');
  const decoded = decodeContentFacts(prepared, factsRequest, name === 'partial' ? emptyFacts : referenceShirtResponse(factsRequest));
  const report = scoreAudit(snapshot, extracted, { category: 'basic-tshirts', validatedFacts: decoded });
  return summarize(name, snapshot, extracted, report, { facts: 'decoded', factCount: decoded.facts.length, productComplete: decoded.coverage.productComplete });
}
async function runPublic() {
  const snapshot = await retrieve('https://kokatat.com/naiad-pfd-lvhnai', {
    egress: createPublicEgress(), timeoutMs: 8000, observeSitemap: true, observeGuides: true,
    consumeHtml: page => extract(page),
  });
  snapshot.observedAt = new Date().toISOString();
  const extracted = snapshot.extracted;
  const report = scoreAudit(snapshot, extracted);
  // Only bounded visible product/policy observations; never include raw scripts or query strings.
  const prepared = buildSemanticRequest(snapshot, extracted, report);
  for (const source of prepared.payload.sources) {
    try { const clean = new URL(source.url); clean.search = ''; clean.hash = ''; source.url = clean.toString(); }
    catch { source.url = ''; }
  }
  if (prepared.payload.context.url) {
    const clean = new URL(prepared.payload.context.url); clean.search = ''; clean.hash = ''; prepared.payload.context.url = clean.toString();
  }
  const factsRequest = buildContentFactsRequest(prepared);
  // Only authenticated caller receives bounded, prepared source excerpts and metadata.
  // Never log or commit the response: it contains merchant descriptions.
  return { summary: summarize('kokatat', snapshot, extracted, report, { category: report.category, httpStatus: snapshot.status }), prepared, factsRequest };
}
export default {
  async fetch(request, env, ctx) {
    const now = Date.now(), expires = Number(env.PROBE_EXPIRES_AT);
    const timestamp = request.headers.get('x-probe-timestamp') || '', signature = request.headers.get('x-probe-signature') || '';
    const url = new URL(request.url);
    const match = /^\/(sync|background)\/(complete|partial|injection|large|truncated)$/.exec(url.pathname);
    const publicCase = url.pathname === '/sync/kokatat';
    if (request.method !== 'POST' || url.search || (!match && !publicCase) ||
        !Number.isSafeInteger(expires) || expires <= now || expires - now > 3600000 ||
        !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60000 ||
        !/^[a-f0-9]{64}$/.test(signature) || typeof env.PROBE_SECRET !== 'string' || env.PROBE_SECRET.length < 32) return missing();
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.PROBE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const bytes = Uint8Array.from(signature.match(/../g), byte => parseInt(byte, 16));
    if (!await crypto.subtle.verify('HMAC', key, bytes, encoder.encode(`${timestamp}\nPOST\n${url.pathname}`))) return missing();
    if (publicCase) {
      try { return Response.json(await runPublic(), { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return Response.json({ error: error.code || 'public_case_failed' }, { status: 502, headers: { 'cache-control': 'no-store' } }); }
    }
    if (match[1] === 'background') {
      ctx.waitUntil(runCase(match[2]).then(result => console.log(JSON.stringify({ probe: 'completed', ...result })))
        .catch(() => console.error(JSON.stringify({ probe: 'failed', case: match[2] }))));
      return Response.json({ accepted: true }, { status: 202, headers: { 'cache-control': 'no-store' } });
    }
    try { return Response.json(await runCase(match[2]), { headers: { 'cache-control': 'no-store' } }); }
    catch { return Response.json({ error: 'case_failed' }, { status: 500, headers: { 'cache-control': 'no-store' } }); }
  },
};
