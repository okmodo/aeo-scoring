import { normalizeTarget } from './retrieval.mjs';

export function normalizePublicTarget(input) {
  const url = normalizeTarget(input);
  if (/\.example\.?$/.test(new URL(url).hostname)) {
    throw Object.assign(new TypeError('Reserved example hostname'), { code: 'invalid_url' });
  }
  return url;
}

// This transport relies on Cloudflare's global_fetch_strictly_public runtime
// boundary. Deploy only in the isolated Worker described by its configuration.
export function createPublicEgress({ fetcher = globalThis.fetch } = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('Fetch implementation required');
  return {
    fetch(input, options = {}) {
      const url = normalizePublicTarget(input);
      if (options.method !== 'GET' || options.redirect !== 'manual') {
        throw new TypeError('Only manual GET requests are permitted');
      }
      const headers = { 'user-agent': 'AEOAuditBot/1.0', accept: 'text/html,text/plain;q=0.9,application/xml;q=0.8,text/xml;q=0.8,text/markdown;q=0.8' };
      for (const name of ['cookie', 'accept', 'accept-language']) {
        const value = options.browserHeaders?.[name];
        const max = name === 'cookie' ? 8192 : 512;
        if (typeof value === 'string' && value.length <= max && !/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) headers[name] = value;
      }
      return fetcher(url, {
        method: 'GET', redirect: 'manual', cache: 'no-store',
        headers,
        signal: options.signal,
      });
    },
  };
}
