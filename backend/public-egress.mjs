import { normalizeTarget } from './retrieval.mjs';

// This transport relies on Cloudflare's global_fetch_strictly_public runtime
// boundary. Deploy only in the isolated Worker described by its configuration.
export function createPublicEgress({ fetcher = globalThis.fetch } = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('Fetch implementation required');
  return {
    fetch(input, options = {}) {
      const url = normalizeTarget(input);
      if (options.method !== 'GET' || options.redirect !== 'manual') {
        throw new TypeError('Only manual GET requests are permitted');
      }
      return fetcher(url, {
        method: 'GET', redirect: 'manual', cache: 'no-store',
        headers: { 'user-agent': 'AEOAuditBot/1.0', accept: 'text/html,text/plain;q=0.9' },
        signal: options.signal,
      });
    },
  };
}
