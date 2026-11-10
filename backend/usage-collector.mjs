import { METRICS } from './allowance-policy.mjs';

// Diagnostic acquisition only. The v1 alpha API supplies no completeness
// watermark. Neither fetch time nor charge-period end establishes freshness.
const LIMIT = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const units = Object.freeze({ requests: 'count', cpuMs: 'ms', d1Reads: 'rows', d1Writes: 'rows', d1StorageBytes: 'bytes', aiNeurons: 'neurons' });
const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;

async function getJson(fetcher, url, token) {
  const controller = new AbortController();
  let timer;
  const work = async () => {
  try {
    const response = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      // Do not let an unread error body keep the connection open.
      if (response.body) void response.body.cancel().catch(() => {});
      return { error: `http_${response.status}` };
    }
    if (!response.body || typeof response.body.getReader !== 'function') return { error: 'invalid_body' };
    const reader = response.body.getReader();
    let length = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) { await reader.cancel(); return { error: 'response_too_large' }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!data || data.success !== true || !(data.errors === null || Array.isArray(data.errors) && data.errors.length === 0) || !('result' in data)) return { error: 'invalid_envelope' };
    return { data };
  } catch { return { error: 'transport_or_parse_error' }; }
  };
  try {
    return await Promise.race([work(), new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ error: 'timeout' }); }, TIMEOUT_MS); })]);
  } finally { clearTimeout(timer); }
}

// Mapping must be reviewed by an operator. Exact strings are deliberately not
// supplied here: display labels alone do not establish billing semantics.
function validMapping(mapping) {
  return mapping && mapping.version === 1 && mapping.operatorReviewed === true && Array.isArray(mapping.entries) && mapping.entries.every(e =>
    e && typeof e.serviceFamily === 'string' && e.serviceFamily.length > 0 && typeof e.serviceName === 'string' && e.serviceName.length > 0 &&
    typeof e.consumedUnit === 'string' && METRICS.includes(e.metric) && e.unit === units[e.metric] && Number.isSafeInteger(e.multiplier) && e.multiplier > 0) &&
    new Set(mapping.entries.map(e => JSON.stringify([e.serviceFamily, e.serviceName, e.consumedUnit]))).size === mapping.entries.length;
}

export async function collectUsage({ accountId, subscriptionId, token, fetch: fetcher = globalThis.fetch, now = Date.now(), mapping } = {}) {
  const receipt = { status: 'blocked', fetchedAt: now, accountId: null, subscriptionId: null, cycle: null,
    diagnostics: [], metrics: Object.fromEntries(METRICS.map(metric => [metric, null])) };
  if (!/^[0-9a-f]{32}$/.test(accountId ?? '') || typeof subscriptionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId) ||
      typeof token !== 'string' || !token || typeof fetcher !== 'function' || !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
    receipt.diagnostics.push('invalid_configuration'); return receipt;
  }
  receipt.accountId = accountId; receipt.subscriptionId = subscriptionId;
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const responses = await Promise.all(['/subscriptions', '/billable-usage/info', '/billable-usage'].map(path => getJson(fetcher, base + path, token)));
  const [subscriptions, info, usage] = responses;
  for (const [i, name] of ['subscriptions', 'info', 'usage'].entries()) if (responses[i].error) receipt.diagnostics.push(`${name}_${responses[i].error}`);
  if (subscriptions.data) {
    const envelope = subscriptions.data;
    const list = envelope.result;
    const pagination = envelope.result_info;
    const complete = !pagination || Number.isInteger(pagination.total_count) && pagination.total_count === list?.length && (pagination.page === undefined || pagination.page === 1);
    const matching = Array.isArray(list) ? list.filter(s => s?.id === subscriptionId) : [];
    if (!complete) receipt.diagnostics.push('subscriptions_incomplete');
    else if (matching.length !== 1) receipt.diagnostics.push('subscription_mismatch');
    else {
      const start = stamp(matching[0].current_period_start), end = stamp(matching[0].current_period_end);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= now && now < end) receipt.cycle = { start, end };
      else receipt.diagnostics.push('invalid_current_cycle');
    }
  }
  if (info.data) {
    const result = info.data.result;
    if (!result || result.covered !== true || !Array.isArray(result.subscriptions) || result.subscriptions.filter(s => s?.id === subscriptionId && !s.end_timestamp).length !== 1) receipt.diagnostics.push('info_not_covered_or_subscription_mismatch');
  }
  if (!validMapping(mapping)) receipt.diagnostics.push('mapping_not_reviewed');
  if (usage.data && !Array.isArray(usage.data.result)) receipt.diagnostics.push('invalid_usage');
  if (usage.data && Array.isArray(usage.data.result) && validMapping(mapping) && receipt.cycle) {
    // This is a sum of returned rows, not total usage. It cannot establish a
    // zero for missing rows, a storage stock, or a current UTC-day AI total.
    const overflowed = new Set();
    for (const row of usage.data.result) {
      if (!row || row.BillingAccountId !== accountId || row.SubscriptionId !== subscriptionId || stamp(row.BillingPeriodStart) !== receipt.cycle.start) { receipt.diagnostics.push('usage_identity_or_cycle_mismatch'); continue; }
      const start = stamp(row.ChargePeriodStart), end = stamp(row.ChargePeriodEnd);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < receipt.cycle.start || end <= start || end > receipt.cycle.end ||
          typeof row.ConsumedQuantity !== 'number' || !Number.isFinite(row.ConsumedQuantity) || row.ConsumedQuantity < 0) { receipt.diagnostics.push('invalid_usage_row'); continue; }
      const entry = mapping.entries.find(e => e.serviceFamily === row.ServiceFamilyName && e.serviceName === row.ServiceName && e.consumedUnit === row.ConsumedUnit);
      if (!entry) { receipt.diagnostics.push('unmapped_usage_row'); continue; }
      if (entry.metric === 'aiNeurons' || entry.metric === 'd1StorageBytes') { receipt.diagnostics.push('unsupported_metric_window'); continue; }
      if (overflowed.has(entry.metric)) continue;
      const value = row.ConsumedQuantity * entry.multiplier;
      if (!Number.isSafeInteger(value)) { receipt.diagnostics.push('invalid_converted_quantity'); continue; }
      const previous = receipt.metrics[entry.metric]?.observedQuantity ?? 0;
      if (!Number.isSafeInteger(previous + value)) { receipt.metrics[entry.metric] = null; overflowed.add(entry.metric); receipt.diagnostics.push('quantity_overflow'); continue; }
      receipt.metrics[entry.metric] = { observedQuantity: previous + value, unit: entry.unit, scope: { kind: 'returned_billing_period_rows', billingPeriodStart: receipt.cycle.start, partial: true }, coverage: null, watermark: null };
    }
  }
  receipt.diagnostics.push('authoritative_coverage_and_watermarks_unavailable');
  receipt.diagnostics = [...new Set(receipt.diagnostics)];
  return receipt;
}
