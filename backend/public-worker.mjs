import service, { handleAuditRequest } from './service.mjs';
import { createPublicEgress, normalizePublicTarget } from './public-egress.mjs';

const egress = createPublicEgress();
const ALLOWED_ORIGIN = 'https://aeo-scoring-preview-20261105-kk7.pages.dev';
const ROUTE = '/api/v1/audits';

function routeMethod(path) {
  if (path === ROUTE) return 'POST';
  if (path.startsWith(ROUTE + '/') && !path.slice(ROUTE.length + 1).includes('/') && path.length > ROUTE.length + 1) return 'GET';
  return null;
}

function vary(headers, value) {
  const existing = headers.get('vary');
  if (existing === '*') return;
  const fields = existing ? existing.split(',').map(field => field.trim()) : [];
  for (const field of value.split(', ')) {
    if (!fields.some(current => current.toLowerCase() === field.toLowerCase())) fields.push(field);
  }
  headers.set('vary', fields.join(', '));
}

export default {
  async fetch(request, env, ctx) {
    const method = routeMethod(new URL(request.url).pathname);
    const origin = request.headers.get('origin');
    const preflight = request.method === 'OPTIONS' && origin && request.headers.has('access-control-request-method');
    if (preflight && method) {
      const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
        .split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
      const allowed = origin === ALLOWED_ORIGIN && request.headers.get('access-control-request-method') === method &&
        requestedHeaders.every(header => header === 'content-type');
      const headers = new Headers({ 'cache-control': 'no-store' });
      vary(headers, 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      if (allowed) {
        headers.set('access-control-allow-origin', ALLOWED_ORIGIN);
        headers.set('access-control-allow-methods', method);
        if (requestedHeaders.length) headers.set('access-control-allow-headers', 'Content-Type');
      }
      return new Response(null, { status: allowed ? 204 : 403, headers });
    }
    const response = await handleAuditRequest(request, env, ctx, { egress, normalizeUrl: normalizePublicTarget });
    if (!method) return response;
    const headers = new Headers(response.headers);
    vary(headers, 'Origin');
    if (origin === ALLOWED_ORIGIN && request.method === method) {
      headers.set('access-control-allow-origin', ALLOWED_ORIGIN);
      headers.set('access-control-expose-headers', 'Retry-After');
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  scheduled: service.scheduled,
};
