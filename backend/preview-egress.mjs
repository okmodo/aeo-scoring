// A limited preview boundary for operator-controlled destinations. This is not
// public-IP-pinning egress and must not be used for arbitrary submitted URLs.
export function createPreviewEgress({ productUrls, fetcher = globalThis.fetch } = {}) {
  if (!Array.isArray(productUrls) || !productUrls.length || typeof fetcher !== 'function') {
    throw new TypeError('Preview requires approved product URLs and a fetch implementation');
  }
  const allowed = new Set();
  for (const value of productUrls) {
    let url;
    try { url = new URL(value); } catch { throw new TypeError('Invalid preview product URL'); }
    if (typeof value !== 'string' || url.protocol !== 'https:' || url.username || url.password ||
        url.port || url.hash || url.toString() !== value || url.pathname === '/robots.txt' ||
        !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[') ||
        /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) {
      throw new TypeError('Preview product URL must be an exact public HTTPS URL');
    }
    allowed.add(value);
    allowed.add(new URL('/robots.txt', url).toString());
  }
  return {
    fetch(input, options = {}) {
      if (typeof input !== 'string' || !allowed.has(input) || options.method !== 'GET' || options.redirect !== 'manual') {
        throw Object.assign(new Error('Preview destination is not approved'), { code: 'preview_denied' });
      }
      return fetcher(input, {
        method: 'GET', redirect: 'manual',
        headers: { 'user-agent': 'AEOAuditBot/1.0', accept: 'text/html,text/plain;q=0.9' },
        signal: options.signal,
      });
    },
  };
}
