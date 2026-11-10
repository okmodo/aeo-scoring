import test from 'node:test';
import assert from 'node:assert/strict';
import { collectUsage } from './usage-collector.mjs';

const accountId = '0123456789abcdef0123456789abcdef';
const subscriptionId = 'subscription_1';
const now = Date.parse('2026-11-10T12:00:00Z');
const start = '2026-11-04T00:00:00Z', end = '2026-12-04T00:00:00Z';
const mapping = { version: 1, operatorReviewed: true, entries: [{ serviceFamily: 'Example family', serviceName: 'Example requests', consumedUnit: 'Count', metric: 'requests', unit: 'count', multiplier: 1 }] };
const row = { BillingAccountId: accountId, SubscriptionId: subscriptionId, BillingPeriodStart: start, ChargePeriodStart: start, ChargePeriodEnd: '2026-11-05T00:00:00Z', ServiceFamilyName: 'Example family', ServiceName: 'Example requests', ConsumedUnit: 'Count', ConsumedQuantity: 25, PricingQuantity: 0, CumulatedPricingQuantity: 0 };
const envelope = result => ({ success: true, errors: [], messages: [], result });
function mock({ rows = [row], subs = [ { id: subscriptionId, current_period_start: start, current_period_end: end } ], info = { covered: true, subscriptions: [{ id: subscriptionId, start_timestamp: start, billing_cycle_anchor_timestamp: start }] }, fail, body, resultInfo } = {}) {
  return async url => {
    const key = url.endsWith('/info') ? 'info' : url.endsWith('/subscriptions') ? 'subscriptions' : 'usage';
    if (fail?.[key]) return new Response('sensitive server text', { status: fail[key] });
    const result = key === 'info' ? info : key === 'subscriptions' ? subs : rows;
    const data = envelope(result);
    if (key === 'subscriptions' && resultInfo) data.result_info = resultInfo;
    return new Response(key === 'usage' && body !== undefined ? body : JSON.stringify(data));
  };
}
const run = options => collectUsage({ accountId, subscriptionId, token: 'secret', now, mapping, ...options });

test('documented rows yield diagnostic observations, never verified totals', async () => {
  const result = await run({ fetch: mock() });
  assert.deepEqual(result.cycle, { start: Date.parse(start), end: Date.parse(end) });
  assert.deepEqual(result.metrics.requests, { observedQuantity: 25, unit: 'count', scope: { kind: 'returned_billing_period_rows', billingPeriodStart: Date.parse(start), partial: true }, coverage: null, watermark: null });
  assert.equal(result.metrics.aiNeurons, null);
  assert.equal(result.status, 'blocked');
  assert.equal(result.verified, undefined);
});

test('403 and 429 are sanitized and never retried', async () => {
  let count = 0;
  const fetch = mock({ fail: { subscriptions: 403, usage: 429 } });
  const result = await run({ fetch: async (...args) => { count++; return fetch(...args); } });
  assert.equal(count, 3);
  assert.ok(result.diagnostics.includes('subscriptions_http_403'));
  assert.ok(result.diagnostics.includes('usage_http_429'));
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('sensitive server text'), false);
  assert.equal(result.metrics.requests, null);
});

test('partial subscription listing, wrong subscription and uncovered info are blocked', async () => {
  const a = await run({ fetch: mock({ resultInfo: { page: 1, total_count: 2 } }) });
  assert.equal(a.cycle, null); assert.ok(a.diagnostics.includes('subscriptions_incomplete'));
  const b = await run({ fetch: mock({ subs: [{ id: 'other', current_period_start: start, current_period_end: end }], info: { covered: false, subscriptions: [] } }) });
  assert.ok(b.diagnostics.includes('subscription_mismatch'));
  assert.ok(b.diagnostics.includes('info_not_covered_or_subscription_mismatch'));
});

test('truncated, oversized, unknown, mismatched and wrong-unit data cannot become zero', async () => {
  for (const body of ['{"success":true', 'x'.repeat(1024 * 1024 + 1)]) {
    const result = await run({ fetch: mock({ body }) });
    assert.equal(result.metrics.requests, null);
  }
  for (const changed of [{ ConsumedUnit: 'Unknown' }, { BillingAccountId: 'wrong' }, { SubscriptionId: 'wrong' }, { BillingPeriodStart: '2026-10-04T00:00:00Z' }]) {
    const result = await run({ fetch: mock({ rows: [{ ...row, ...changed }] }) });
    assert.equal(result.metrics.requests, null);
    assert.equal(result.status, 'blocked');
  }
  const empty = await run({ fetch: mock({ rows: [] }) });
  assert.equal(empty.metrics.requests, null);
  const unreviewed = await run({ fetch: mock(), mapping: { ...mapping, operatorReviewed: false } });
  assert.equal(unreviewed.metrics.requests, null);
});

test('overflow cannot be replaced by a later partial sum', async () => {
  const rows = [{ ...row, ConsumedQuantity: Number.MAX_SAFE_INTEGER }, row, row];
  const result = await run({ fetch: mock({ rows }) });
  assert.equal(result.metrics.requests, null);
  assert.ok(result.diagnostics.includes('quantity_overflow'));
});


test('billing period rows cannot represent daily AI or current storage stock', async () => {
  const entries = [
    { serviceFamily: 'Example family', serviceName: 'AI', consumedUnit: 'neurons', metric: 'aiNeurons', unit: 'neurons', multiplier: 1 },
    { serviceFamily: 'Example family', serviceName: 'Storage', consumedUnit: 'bytes', metric: 'd1StorageBytes', unit: 'bytes', multiplier: 1 },
  ];
  const rows = entries.map(entry => ({ ...row, ServiceName: entry.serviceName, ConsumedUnit: entry.consumedUnit }));
  const result = await run({ fetch: mock({ rows }), mapping: { ...mapping, entries } });
  assert.equal(result.metrics.aiNeurons, null);
  assert.equal(result.metrics.d1StorageBytes, null);
  assert.ok(result.diagnostics.includes('unsupported_metric_window'));
});

test('frozen diagnostic fixture remains blocked and identifies partial row scope', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/usage-collector/diagnostic.v1.json', import.meta.url), 'utf8'));
  const fetch = async url => new Response(JSON.stringify(url.endsWith('/info') ? fixture.info : url.endsWith('/subscriptions') ? fixture.subscriptions : fixture.usage));
  const result = await collectUsage({ ...fixture, token: 'fixture-token', fetch });
  assert.equal(result.status, 'blocked');
  assert.equal(result.metrics.requests.observedQuantity, 25);
  assert.deepEqual(result.metrics.requests.scope, { kind: 'returned_billing_period_rows', billingPeriodStart: Date.parse('2026-11-04T00:00:00Z'), partial: true });
  assert.equal(result.metrics.aiNeurons, null);
  assert.equal(result.metrics.d1StorageBytes, null);
});
