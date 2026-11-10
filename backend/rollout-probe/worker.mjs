// Public, fixed synthetic pages for an expiring end-to-end audit check.
export default {
  fetch(request, env) {
    const expires = Number(env.FIXTURE_EXPIRES_AT);
    if (!Number.isFinite(expires) || expires < Date.now() || expires - Date.now() > 3600000 ||
        !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', {
      headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
    });
    const large = url.pathname === '/large-late';
    if (!large && url.pathname !== '/over-cap-early') return new Response(null, { status: 404 });
    const product = '<script type="application/ld+json">' + JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Product', url: url.href,
      name: 'Synthetic Streaming Shoe', description: 'Fixed fictional product for audit verification.',
      image: url.origin + '/shoe.png',
    }) + '</script>';
    const start = '<!doctype html><html><head><title>Synthetic Streaming Shoe</title></head><body><main><h1>Synthetic Streaming Shoe</h1><p>Fixed fictional product.</p></main>' + (large ? '' : product);
    const end = (large ? product : '') + '</body></html>';
    const filler = '<!--' + 'x'.repeat(16 * 1024 - 7) + '-->';
    const chunks = large ? 48 : 80;
    const size = new TextEncoder().encode(start + end).byteLength + chunks * filler.length;
    let index = -1;
    const body = new ReadableStream({
      pull(controller) {
        const position = index++;
        const chunk = position < 0 ? start : position < chunks ? filler : position === chunks ? end : null;
        if (chunk === null) controller.close();
        else controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(size), 'cache-control': 'no-store' },
    });
  },
};
