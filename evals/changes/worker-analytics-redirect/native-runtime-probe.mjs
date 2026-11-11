import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from '../../../backend/node_modules/miniflare/dist/src/index.js';

const collector = readFileSync(new URL('../../../backend/analytics-usage.mjs', import.meta.url), 'utf8')
  .replace('export async function collectAnalyticsUsage', 'async function collectAnalyticsUsage');
const script = collector + `
export default {
  async fetch() {
    const result = await collectAnalyticsUsage({ accountId: 'a'.repeat(32), subscriptionId: 'sub', token: 'fixture' });
    return Response.json({ mode: result.mode, usage: result.usage });
  }
};`;
const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true, script, compatibilityDate: '2026-11-05',
  compatibilityFlags: ['global_fetch_strictly_public', 'cache_option_enabled'],
  outboundService(request) {
    if (request.url.endsWith('/subscriptions')) {
      return Response.json({ success: true, errors: [], result: [{ id: 'sub',
        current_period_start: new Date(Date.now() - 86400000).toISOString(),
        current_period_end: new Date(Date.now() + 86400000).toISOString(),
      }] });
    }
    assert.equal(new URL(request.url).pathname, '/client/v4/graphql');
    return Response.json({ data: { viewer: { accounts: [{ workers: [], d1: [], storage: [], ai: [] }] } } });
  },
}));
try {
  const response = await runtime.dispatchFetch('http://localhost');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, 'estimated');
  assert.deepEqual(Object.values(result.usage), [0, 0, 0, 0, 0, 0]);
  console.log(JSON.stringify({ passed: true, source: 'local_native_runtime', externalRequests: 0 }));
} finally { await runtime.dispose(); }
