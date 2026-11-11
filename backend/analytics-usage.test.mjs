import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAnalyticsUsage } from './analytics-usage.mjs';

const now = Date.parse('2026-11-11T12:00:00Z');
const config = { accountId: 'a'.repeat(32), subscriptionId: 'sub', token: 'secret', now };
const subscription = () => ({ success: true, errors: [], result: [{ id: 'sub', current_period_start: '2026-11-01T00:00:00Z', current_period_end: '2026-12-01T00:00:00Z' }] });
const analytics = () => ({ data: { viewer: { accounts: [{ workers: [{ sum: { requests: 12.2, cpuTimeUs: 1001 } }], d1: [{ sum: { rowsRead: 23, rowsWritten: 4 } }], storage: [{ dimensions: { databaseId: 'db' }, max: { databaseSizeBytes: 50 } }, { dimensions: { databaseId: 'db' }, max: { databaseSizeBytes: 30 } }], ai: [{ sum: { totalNeurons: 2.1 } }] }] } } });
function fetcher(sub = subscription(), data = analytics()) {
  return async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/graphql')) {
      const { query } = JSON.parse(options.body);
      assert.ok(query.includes(config.accountId));
      assert.ok(query.includes('2026-11-10T12:00:00.000Z'));
      assert.ok(!query.includes('scriptName'));
      return Response.json(data);
    }
    return Response.json(sub);
  };
}
test('collects account-wide estimated totals and billing cycle', async () => {
  const r = await collectAnalyticsUsage({ ...config, fetch: fetcher() });
  assert.deepEqual(r, { cycleStart: Date.parse('2026-11-01T00:00:00Z'), cycleEnd: Date.parse('2026-12-01T00:00:00Z'), aiDay: '2026-11-11', observedAt: now, mode: 'estimated', usage: { requests: 13, cpuMs: 2, d1Reads: 23, d1Writes: 4, d1StorageBytes: 50, aiNeurons: 3 } });
});
test('successful empty aggregates are zero estimates', async () => {
  const a = analytics(); Object.assign(a.data.viewer.accounts[0], { workers: [], d1: [], storage: [], ai: [] });
  const r = await collectAnalyticsUsage({ ...config, fetch: fetcher(subscription(), a) });
  assert.deepEqual(Object.values(r.usage), [0, 0, 0, 0, 0, 0]);
});
test('normalizes surrounding token whitespace and reports fixed API failure codes', async () => {
  const original = fetcher();
  await collectAnalyticsUsage({ ...config, token: ' secret\n', fetch: (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer secret');
    return original(url, options);
  } });
  await assert.rejects(collectAnalyticsUsage({ ...config, fetch: async () => new Response('', { status: 403 }) }), /subscriptions_http_403/);
  await assert.rejects(collectAnalyticsUsage({ ...config, fetch: async url => url.endsWith('/graphql')
    ? Response.json({ errors: [{ message: 'authorization denied' }] }) : Response.json(subscription()) }), /analytics_authorization_denied/);
});
test('rejects incomplete, malformed, erroneous and overflowing responses', async () => {
  const cases = [];
  let s = subscription(); s.result[0].id = 'other'; cases.push(fetcher(s));
  s = subscription(); s.result_info = { total_count: 2 }; cases.push(fetcher(s));
  let a = analytics(); a.errors = [{ message: 'bad' }]; cases.push(fetcher(subscription(), a));
  a = analytics(); a.data.viewer.accounts[0].workers[0].sum.requests = -1; cases.push(fetcher(subscription(), a));
  a = analytics(); a.data.viewer.accounts[0].storage = Array(10000).fill({}); cases.push(fetcher(subscription(), a));
  a = analytics(); a.data.viewer.accounts[0].ai[0].sum.totalNeurons = Number.MAX_SAFE_INTEGER + 1; cases.push(fetcher(subscription(), a));
  cases.push(async () => new Response('x'.repeat(1048577)));
  cases.push(async () => new Response('failure', { status: 403 }));
  for (const fetch of cases) await assert.rejects(collectAnalyticsUsage({ ...config, fetch }));
});
