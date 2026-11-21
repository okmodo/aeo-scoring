import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the production RPC methods in workerd, with synthetic I/O standing in
// for the provider and checkpoint writes. No network model request is made.
// Local workerd does not enforce the hosted post-response cutoff: the original
// implementation also passes this test, so this is not a cutoff regression test.
test('prepared RPC survives a 30-second post-response boundary', { timeout: 45000 }, async () => {
  const { Miniflare, convertV4MiniflareOptions } = await import(process.env.MINIFLARE_MODULE || 'miniflare');
  const source = await readFile(new URL('./public-worker.mjs', import.meta.url), 'utf8');
  const entry = source.slice(source.indexOf('export class AuditContinuation'), source.indexOf('\nconst egress'));
  const script = `import { WorkerEntrypoint } from 'cloudflare:workers';
    let state = { phase: 'idle' };
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const runPreparation = async ({onPrepared}) => { await onPrepared('audit'); };
    const runPreparedAudit = async () => {
      state = { phase: 'before', started: Date.now() };
      await delay(1000);
      state.phase = 'provider';
      await delay(29500);
      state.phase = 'checkpoint';
      await delay(1000);
      state = { ...state, phase: 'completed', finished: Date.now() };
      return {status: 'completed'};
    };
    ${entry}
    export default { async fetch(request, env) {
      if (new URL(request.url).pathname === '/start') {
        await env.AUDIT_SELF.prepare('audit');
        return new Response('accepted', {status: 202});
      }
      return Response.json(state);
    }};`;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'prepared-timeout', modules: true, script, compatibilityDate: '2026-11-05', cf: false,
    serviceBindings: { AUDIT_SELF: {name: 'prepared-timeout', entrypoint: 'AuditContinuation'} },
  }));
  try {
    const start = Date.now();
    const response = await mf.dispatchFetch('http://localhost/start');
    assert.equal(response.status, 202);
    await response.text();
    assert.ok(Date.now() - start < 5000, '202 must return before assessment completes');
    let state;
    const end = Date.now() + 38000;
    do {
      state = await (await mf.dispatchFetch('http://localhost/status')).json();
      if (state.phase === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < end);
    assert.equal(state.phase, 'completed', JSON.stringify(state));
    assert.ok(state.finished - start > 30000, 'completion must cross the post-response boundary');
    assert.ok(state.finished - state.started >= 31500, 'provider and checkpoint delays must elapse');
  } finally {
    await mf.dispose();
  }
});
