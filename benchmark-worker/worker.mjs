import { inspectSnapshot } from '../scripts/feasibility.mjs';

// The admission service is deliberately not implemented or provisioned here.
// It must atomically authenticate and consume a global, expiring permit before
// returning 204. Without that independently reviewed service this is unusable.
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
  if (request.method !== 'POST' || !match || url.search || request.body !== null) return new Response('Not found', { status: 404 });
  if (!env?.BENCH_ADMISSION || typeof env.BENCH_ADMISSION.fetch !== 'function') return new Response('Unavailable', { status: 503 });
  let admission;
  try {
    // The service validates access, fixed expiry and global permit count. The
    // original request carries its authentication; no credential is stored here.
    admission = await env.BENCH_ADMISSION.fetch(request);
  } catch {
    return new Response('Unavailable', { status: 503 });
  }
  if (admission.status !== 204) return new Response('Unavailable', { status: 503 });
  try {
    const html = match[1] === 'error' ? 'x'.repeat(1048577) : snapshot(match[1]);
    const result = inspectSnapshot({ html, url: 'https://example.invalid/product', method: 'raw', observedAt: '2026-01-01T00:00:00Z' });
    return Response.json({ workload: match[1], bytes: html.length, fields: result.productFields.length, complete: result.coverage.complete });
  } catch {
    if (match[1] === 'error') return Response.json({ workload: 'error', rejected: true });
    return new Response('Extraction failed', { status: 500 });
  }
}

export default { fetch: handle };
