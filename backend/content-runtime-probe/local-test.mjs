// Native Workers runtime behavior checks; this does not measure Cloudflare CPU.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'vite';
const bundle = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: new URL('./worker.mjs', import.meta.url).pathname, formats: ['es'] } } });
const { Miniflare, convertV4MiniflareOptions } = createRequire(new URL('../package.json', import.meta.url))('miniflare');
const secret = '0123456789abcdef0123456789abcdef';
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: (Array.isArray(bundle) ? bundle.flatMap(x => x.output) : bundle.output).find(x => x.type === 'chunk').code, compatibilityDate: '2026-11-09', bindings: { PROBE_SECRET: secret, PROBE_EXPIRES_AT: String(Date.now() + 600000) } }));
try {
  assert.equal((await runtime.dispatchFetch('https://probe.test/sync/complete', { method: 'POST' })).status, 404);
  for (const name of ['complete', 'partial', 'injection', 'large', 'truncated']) {
    const path = '/sync/' + name, timestamp = String(Date.now());
    const signature = createHmac('sha256', secret).update(`${timestamp}\nPOST\n${path}`).digest('hex');
    const result = await runtime.dispatchFetch('https://probe.test' + path, { method: 'POST', headers: { 'x-probe-timestamp': timestamp, 'x-probe-signature': signature } });
    assert.equal(result.status, 200, name + ': ' + await result.clone().text());
    const data = await result.json();
    assert.equal(data.case, name);
    if (name === 'injection') assert.equal(data.facts, 'rejected_unsafe');
    else assert.equal(data.facts, 'decoded');
    if (name === 'complete' || name === 'large') { assert.equal(data.status, 'complete'); assert.equal(data.score.total, 78.125); assert.ok(data.factCount > 20); assert.ok(data.blocks > 0); }
    if (name === 'truncated') { assert.equal(data.htmlLimited, 'bytes'); assert.equal(data.productComplete, false); }
    if (name === 'partial') assert.equal(data.factCount, 0);
  }
  const path = '/background/complete', timestamp = String(Date.now());
  const signature = createHmac('sha256', secret).update(`${timestamp}\nPOST\n${path}`).digest('hex');
  const background = await runtime.dispatchFetch('https://probe.test' + path, { method: 'POST', headers: { 'x-probe-timestamp': timestamp, 'x-probe-signature': signature } });
  assert.equal(background.status, 202);
  const altered = await runtime.dispatchFetch('https://probe.test/sync/partial', { method: 'POST', headers: { 'x-probe-timestamp': timestamp, 'x-probe-signature': signature } });
  assert.equal(altered.status, 404);
  console.log('Native runtime: authentication rejection, five fixed cases and background acceptance passed. CPU and background completion not measured.');
} finally { await runtime.dispose(); }
