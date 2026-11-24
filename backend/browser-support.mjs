import { inspectSupportingResources } from './retrieval.mjs';
import { createPublicEgress, normalizePublicTarget } from './public-egress.mjs';
import { assessSupport } from './support-assessment.mjs';

const structureIds = ['S5.search', 'S5.ai-retrieval', 'S6.usable', 'S6.inclusion', 'S7.identity', 'S7.links'];

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
