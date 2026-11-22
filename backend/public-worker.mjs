import service, { handleAuditRequest, runPreparation } from './service.mjs';
import { runPreparedAudit } from './prepared-assessment-consumer.mjs';
import { createAuditQueueRuntime } from './audit-queue-runtime.mjs';
import { createPublicEgress, normalizePublicTarget } from './public-egress.mjs';

// The fallback only permits offline Node tests to import this module; Workers
// supplies the actual RPC superclass and exposes this entrypoint via binding.
const { WorkerEntrypoint } = await import('cloudflare:workers').catch(() => ({WorkerEntrypoint: class {}}));

export class AuditContinuation extends WorkerEntrypoint {
  async prepare(auditId) {
    if (this.env.AUDIT_QUEUE_MODE === 'enabled') return;
    this.ctx.waitUntil(runPreparation({
      env: this.env,
      auditId,
      onPrepared: async id => {
        // Start sibling RPCs so each step has its own CPU budget and does not
        // increase the depth of the service binding call chain.
        let result;
        do {
          result = await this.env.AUDIT_SELF.assess(id);
        } while (result.status === 'yield');
      },
    }).catch(() => {}));
  }

  async assess(auditId) {
    if (this.env.AUDIT_QUEUE_MODE === 'enabled') return {status:'skipped'};
    const work = runPreparedAudit({env: this.env, auditId});
    this.ctx.waitUntil(work);
    return work;
  }
}

const egress = createPublicEgress();
const ALLOWED_ORIGIN = 'https://aeo-scoring-preview-20261105-kk7.pages.dev';
const ROUTE = '/api/v1/audits';
const UNLOCK = '/api/v1/preview-access';
const passwordFormat = /^[A-Za-z0-9_-]{8,128}$/;
const encoder = new TextEncoder();
const accessChallenge = encoder.encode('aeo-preview-access-v1');

async function matchesPassword(provided, expected) {
  if (!passwordFormat.test(provided)) return false;
  const algorithm = { name: 'HMAC', hash: 'SHA-256' };
  const [signingKey, verificationKey] = await Promise.all([
    crypto.subtle.importKey('raw', encoder.encode(provided), algorithm, false, ['sign']),
    crypto.subtle.importKey('raw', encoder.encode(expected), algorithm, false, ['verify']),
  ]);
  const signature = await crypto.subtle.sign('HMAC', signingKey, accessChallenge);
  return crypto.subtle.verify('HMAC', verificationKey, signature, accessChallenge);
}

function accessError(status, code, message) {
  return Response.json({ version: '1', error: { code, message, retryAfterSeconds: null } }, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

async function handleProtectedRequest(request, env, ctx, path, method) {
  if (request.method === method) {
    if (env.AUDIT_PUBLIC_ACCESS === 'enabled') {
      if (path === UNLOCK) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      return handleBoundAuditRequest(request, env, ctx);
    }
    const expected = env.AUDIT_PREVIEW_PASSWORD;
    if (typeof expected !== 'string' || !passwordFormat.test(expected)) {
      return accessError(503, 'service_unavailable', 'Testing access is unavailable.');
    }
    const authorization = request.headers.get('authorization') ?? '';
    const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!await matchesPassword(provided, expected)) {
      return accessError(401, 'preview_password_required', 'Enter the shared testing password.');
    }
    if (path === UNLOCK) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  }
  if (path === UNLOCK) return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
  return handleBoundAuditRequest(request, env, ctx);
}

function handleBoundAuditRequest(request, env, ctx) {
  const queueRequired = env.AUDIT_QUEUE_MODE === 'enabled';
  const enqueueAudit = queueRequired && env.AUDIT_QUEUE?.send
    ? id => createAuditQueueRuntime(env).start(id)
    : undefined;
  return handleAuditRequest(request, env, ctx, {egress,normalizeUrl:normalizePublicTarget,requireBrowser:true,queueRequired,enqueueAudit});
}

function routeMethod(path) {
  if (path === ROUTE || path === UNLOCK) return 'POST';
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
    const path = new URL(request.url).pathname;
    const method = routeMethod(path);
    const origin = request.headers.get('origin');
    const preflight = request.method === 'OPTIONS' && origin && request.headers.has('access-control-request-method');
    if (preflight && method) {
      const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
        .split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
      const allowed = origin === ALLOWED_ORIGIN && request.headers.get('access-control-request-method') === method &&
        requestedHeaders.every(header => header === 'authorization' || (method === 'POST' && header === 'content-type'));
      const headers = new Headers({ 'cache-control': 'no-store' });
      vary(headers, 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      if (allowed) {
        headers.set('access-control-allow-origin', ALLOWED_ORIGIN);
        headers.set('access-control-allow-methods', method);
        if (requestedHeaders.length) headers.set('access-control-allow-headers', method === 'POST' ? 'Authorization, Content-Type' : 'Authorization');
      }
      return new Response(null, { status: allowed ? 204 : 403, headers });
    }
    const response = await handleProtectedRequest(request, env, ctx, path, method);
    if (!method) return response;
    const headers = new Headers(response.headers);
    vary(headers, 'Origin');
    if (origin === ALLOWED_ORIGIN && request.method === method) {
      headers.set('access-control-allow-origin', ALLOWED_ORIGIN);
      headers.set('access-control-expose-headers', 'Retry-After');
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async queue(batch, env) {
    await createAuditQueueRuntime(env).consume(batch);
  },
  scheduled: service.scheduled,
};
