import { inspectPolicies, inspectSupportingResources } from './retrieval.mjs';
import { createPublicEgress, normalizePublicTarget } from './public-egress.mjs';
import { assessSupport } from './support-assessment.mjs';

const structureIds = ['S5.search', 'S5.ai-retrieval', 'S6.usable', 'S6.inclusion', 'S7.identity', 'S7.links'];

function isPolicyLink(link, base) {
  if (!link || typeof link.url !== 'string') return false;
  let target;
  try { target = new URL(link.url, base); } catch { return false; }
  const path = target.pathname.toLowerCase();
  if (path === '/' || /^\/(?:collections?|products?|catalog|cart|checkout|search)(?:\/|$)/.test(path)) return false;
  const policyPath = /(?:^|[\/_-])(?:shipping|delivery|returns?|refunds?)(?:[\/_-]|$)/i.test(path);
  const policyLabel = /^(?:(?:shipping|delivery|returns?|refunds?)(?:\s*(?:&|and|\/)\s*(?:shipping|delivery|returns?|refunds?))?)(?:\s+(?:policy|policies|information|info|details))?$/i.test(typeof link.text === 'string' ? link.text.trim() : '');
  return policyPath || policyLabel;
}

// Inspect only policy links discovered in the retained product document.
export async function inspectPreparedPolicyLinks(input, links, { fetcher, HTMLRewriter, kinds = ['shipping', 'returns'] } = {}) {
  const product = normalizePublicTarget(input);
  const url = new URL(product);
  const egress = createPublicEgress({ fetcher });
  const controller = new AbortController();
  let requests = 0;
  const fetchBounded = async (target, signal) => {
    const normalized = normalizePublicTarget(target.href);
    if (new URL(normalized).origin !== url.origin || normalized === product || ++requests > 2 || signal.aborted) throw new Error('Policy request blocked');
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Policy request timed out'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const response = await Promise.race([egress.fetch(normalized, { method: 'GET', redirect: 'manual', signal }), aborted]);
      if (response.status >= 300 && response.status < 400) { response.body?.cancel().catch(() => {}); throw new Error('Policy redirect blocked'); }
      return response;
    } finally { signal.removeEventListener('abort', onAbort); }
  };
  try {
    return await inspectPolicies({ url, links: Array.isArray(links) ? links.filter(link => isPolicyLink(link, url)) : [], fetchBounded, signal: controller.signal, Rewriter: HTMLRewriter || globalThis.HTMLRewriter, kinds });
  } finally { controller.abort(); }
}

// Run only the bounded origin-level checks for an already admitted audit.
export async function scorePreparedDomainStructure(input, { fetcher } = {}) {
  const url = normalizePublicTarget(input);
  const egress = createPublicEgress({ fetcher });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  let requests = 0;
  const fetchBounded = async (target, signal) => {
    if (['/AGENTS.md', '/agents.md'].includes(target.pathname) || ++requests > 4 || controller.signal.aborted || signal.aborted) throw new Error('Support request blocked');
    const combined = AbortSignal.any([controller.signal, signal]);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Support request timed out'));
      combined.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const response = await Promise.race([egress.fetch(target.toString(), {method:'GET', redirect:'manual', signal:combined}), aborted]);
      if (response.status >= 300 && response.status < 400) { response.body?.cancel().catch(() => {}); throw new Error('Support redirect blocked'); }
      return response;
    } finally { combined.removeEventListener('abort', onAbort); }
  };
  try {
    const inspected = await inspectBrowserSupport({url}, {fetchBounded, signal:controller.signal});
    const checks = assessSupport(inspected);
    return Object.fromEntries(structureIds.map(id => [id, checks[id]]));
  } finally { clearTimeout(timer); controller.abort(); }
}

// The browser transport must route every request through the same public egress
// and session budget as the product capture. This layer never requests the page.
export async function inspectBrowserSupport(snapshot, { fetchBounded, signal, HTMLRewriter } = {}) {
  if (typeof fetchBounded !== 'function' || !signal) throw new TypeError('Bounded browser transport required');
  const product = normalizePublicTarget(snapshot.url);
  const origin = new URL(product).origin;
  const supportFetch = async (url, requestSignal) => {
    const target = normalizePublicTarget(url.toString());
    if (new URL(target).origin !== origin || target === product || signal.aborted || requestSignal.aborted) throw new Error('Supporting request blocked');
    return fetchBounded(new URL(target), requestSignal);
  };
  const inspected = await inspectSupportingResources(snapshot, {fetchBounded:supportFetch, signal, HTMLRewriter});
  // A missing default sitemap only proves absence when robots was inspected:
  // otherwise it may have declared a different sitemap we could not discover.
  const policy = inspected.crawlerPolicy;
  const robotsKnown = [404, 410].includes(policy?.httpStatus) ||
    (policy?.httpStatus === 200 && policy.observations?.every(item => item.status !== 'not_measured'));
  if (!robotsKnown && inspected.sitemap?.state === 'absent') {
    inspected.sitemap = { ...inspected.sitemap, state: 'unknown' };
  }
  return inspected;
}
