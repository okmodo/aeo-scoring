import { createAuditService } from '../service.mjs';

const product = 'https://synthetic.example/product';
const cases = {
  'large-late': { kib: 768, evidence: 'late' },
  'over-cap-early': { kib: 1280, evidence: 'early' },
  'over-cap-late': { kib: 1280, evidence: 'late' },
  'over-cap-open-script': { kib: 1024, evidence: 'open' },
};
const encoder = new TextEncoder();
const filler = encoder.encode('<!--' + 'x'.repeat(16 * 1024 - 7) + '-->');
const evidence = '<main><h1>Probe Shoe</h1><p>Example product.</p></main>' +
  '<script type="application/ld+json">' + JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product',
    url: product, name: 'Probe Shoe', description: 'Example product.',
    image: 'https://synthetic.example/shoe.png',
  }) + '</script>';

function page({ kib, evidence: placement }) {
  const first = encoder.encode('<html><body>' + (placement === 'early' ? evidence : ''));
  const open = placement === 'open';
  const blocks = kib / 16 - (open ? 1 : 0);
  const last = encoder.encode(open
    ? '<!--' + 'x'.repeat(16 * 1024 - first.byteLength - 512 - 7) + '-->' +
      evidence.replace('</script>', ' '.repeat(1024) + '</script>') + '</body></html>'
    : (placement === 'late' ? evidence : '') + '</body></html>');
  let chunk = -1;
  let emittedBytes = 0;
  return {
    body: new ReadableStream({
      pull(controller) {
        const next = chunk++;
        const value = next < 0 ? first : next < blocks ? filler : next === blocks ? last : null;
        if (value) {
          emittedBytes += value.byteLength;
          controller.enqueue(value);
        } else controller.close();
      },
    }),
    bytes: blocks * filler.byteLength + first.byteLength + last.byteLength,
    get emittedBytes() { return emittedBytes; },
  };
}

async function tokenMatches(candidate, expected) {
  if (!expected || expected.length !== 64 || candidate?.length !== 64) return false;
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  const [a, b] = await Promise.all([digest(candidate), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export default {
  async fetch(request, env) {
    const name = new URL(request.url).pathname.slice(1);
    const expires = Number(env.PROBE_EXPIRES_AT);
    if (request.method !== 'POST' || !Object.hasOwn(cases, name) || !Number.isFinite(expires) ||
        expires < Date.now() || expires - Date.now() > 3600000 ||
        !await tokenMatches(request.headers.get('x-probe-token'), env.PROBE_TOKEN)) {
      return new Response(null, { status: 404 });
    }

    const input = page(cases[name]);
    let audit;
    let background;
    const store = {
      reserve: async (record) => {
        audit = { ...record, status: 'pending', completedAt: null, report: null, error: null };
        return { kind: 'created', audit };
      },
      finish: async (_id, updates) => { audit = { ...audit, ...updates }; },
      get: async () => audit,
    };
    const egress = {
      fetch: async (url) => {
        if (url === product) return new Response(input.body, {
          headers: { 'content-type': 'text/html', 'content-length': String(input.bytes) },
        });
        if (url === 'https://synthetic.example/robots.txt') return new Response('User-agent: *\nAllow: /\n', {
          headers: { 'content-type': 'text/plain' },
        });
        return new Response(null, { status: 404 });
      },
    };
    const handle = createAuditService({ store, egress, secret: env.PROBE_TOKEN, HTMLRewriter });
    const requestUrl = 'https://synthetic-worker.example/api/v1/audits';
    const submitted = await handle(new Request(requestUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: product }),
    }), { address: '192.0.2.1', defer: task => { background = task; } });
    if (submitted.status !== 202 || !background) return new Response(null, { status: 500 });
    await background;
    const response = await handle(new Request(requestUrl + '/' + audit.id));
    const result = await response.json();
    const report = result.report;
    return Response.json({
      case: name,
      bytes: input.bytes,
      emittedBytes: input.emittedBytes,
      status: result.status,
      score: report?.score ?? null,
      error: result.error?.code ?? null,
      checks: report?.criteria.flatMap(criterion => criterion.subchecks)
        .filter(check => check.status === 'measured').map(check => check.id) ?? [],
      evidence: report?.evidence.map(item => item.excerpt) ?? [],
      limitations: report?.coverage.limitations ?? [],
    }, { headers: { 'cache-control': 'no-store' } });
  },
};
