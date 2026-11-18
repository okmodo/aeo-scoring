import { inspectSupportingResources } from './retrieval.mjs';
import { normalizePublicTarget } from './public-egress.mjs';

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
  return inspectSupportingResources(snapshot, {fetchBounded:supportFetch, signal, HTMLRewriter});
}
