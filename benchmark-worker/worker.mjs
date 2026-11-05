import { inspectSnapshot, SnapshotInputLimitError } from '../scripts/feasibility.mjs';

const sizes = Object.freeze({ small: 2048, medium: 131072, large: 1048576 });
const prefix = '<!doctype html><html><body><h1>Example product</h1><p itemprop="description">Synthetic description</p>';
const suffix = '</body></html>';

export function snapshot(size) {
  const entry = '<section><span itemprop="price">12.00</span><p>Product detail</p></section>';
  const target = sizes[size];
  if (!target) throw new Error('Unknown workload');
  const count = Math.max(0, Math.floor((target - prefix.length - suffix.length - 7) / entry.length));
  const content = prefix + entry.repeat(count);
  const padding = target - content.length - suffix.length;
  return content + '<!--' + 'x'.repeat(padding - 7) + '-->' + suffix;
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const match = /^\/(small|medium|large|error)$/.exec(url.pathname);
  if (request.method !== 'POST' || !match || url.search) return new Response('Not found', { status: 404 });
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(env?.BENCH_TOKEN || '') || !env?.BENCH_DB || typeof crypto.subtle.timingSafeEqual !== 'function') return new Response('Unavailable', { status: 503 });
  const encoder = new TextEncoder();
  if (!crypto.subtle.timingSafeEqual(encoder.encode(token), encoder.encode(env.BENCH_TOKEN))) return new Response('Unavailable', { status: 503 });
  if (request.body !== null) {
    const reader = request.body.getReader();
    try {
      const first = await reader.read();
      if (!first.done) {
        await reader.cancel();
        return new Response('Not found', { status: 404 });
      }
    } catch {
      return new Response('Not found', { status: 404 });
    } finally {
      reader.releaseLock();
    }
  }
  let admission;
  try {
    // One conditional SQLite UPDATE serializes permits on D1; the database
    // clock enforces expiry, independent of per-isolate mutable state.
    admission = await env.BENCH_DB.prepare('UPDATE budget SET remaining = remaining - 1 WHERE id = 1 AND remaining > 0 AND expires_at > unixepoch() RETURNING remaining').first();
  } catch {
    return new Response('Unavailable', { status: 503 });
  }
  if (!admission || !Number.isInteger(admission.remaining) || admission.remaining < 0 || admission.remaining > 29) return new Response('Unavailable', { status: 503 });
  try {
    const html = match[1] === 'error' ? 'x'.repeat(1048577) : snapshot(match[1]);
    const result = inspectSnapshot({ html, url: 'https://example.invalid/product', method: 'raw', observedAt: '2026-01-01T00:00:00Z' });
    return Response.json({ workload: match[1], bytes: html.length, fields: result.productFields.length, complete: result.coverage.complete });
  } catch (error) {
    if (match[1] === 'error' && error instanceof SnapshotInputLimitError) return Response.json({ workload: 'error', rejected: true });
    return new Response('Extraction failed', { status: 500 });
  }
}

export default { fetch: handle };
