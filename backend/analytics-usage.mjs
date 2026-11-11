// Cloudflare adaptive analytics are estimates and may lag actual account usage.
// An empty successful aggregate is treated as zero in this estimated mode.
const LIMIT = 1024 * 1024;
const TIMEOUT = 10_000;
const QUERY = `query Usage {
  viewer { accounts(filter: {accountTag: $account}) {
    workers: workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests cpuTimeUs } }
    d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { rowsRead rowsWritten } }
    storage: d1StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: $storageStart, datetime_lt: $end}) { dimensions { databaseId } max { databaseSizeBytes } }
    ai: aiInferenceAdaptiveGroups(limit: 1, filter: {datetime_geq: $dayStart, datetime_lt: $end}) { sum { totalNeurons } }
  } }
}`;

async function json(fetcher, url, token, body, source = 'subscriptions') {
  const controller = new AbortController();
  let timer;
  const work = async () => {
    const response = await fetcher(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`${source}_http_${response.status}`);
    }
    if (!response.body?.getReader) throw new Error('analytics response unavailable');
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) { void reader.cancel(); throw new Error('analytics response too large'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('analytics timeout')); }, TIMEOUT); })]);
  } finally { clearTimeout(timer); }
}

function amount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.ceil(value))) throw new Error('invalid analytics amount');
  return value;
}
function aggregate(rows, fields) {
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('invalid analytics aggregate');
  if (!rows.length) return fields.map(() => 0);
  if (!rows[0]?.sum) throw new Error('invalid analytics aggregate');
  return fields.map(field => amount(rows[0].sum[field]));
}
const iso = ms => new Date(ms).toISOString();
const day = ms => iso(ms).slice(0, 10);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;

export async function collectAnalyticsUsage({ accountId, subscriptionId, token, fetch: fetcher = globalThis.fetch, now = Date.now() } = {}) {
  if (typeof token === 'string') token = token.trim();
  if (!/^[0-9a-f]{32}$/.test(accountId ?? '') || !/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId ?? '') ||
      typeof token !== 'string' || !token || typeof fetcher !== 'function' || !Number.isSafeInteger(now) || now < 86400000 || now > 8640000000000000) throw new Error('invalid analytics configuration');
  const base = 'https://api.cloudflare.com/client/v4';
  const subs = await json(fetcher, `${base}/accounts/${accountId}/subscriptions`, token);
  if (subs?.success !== true || !Array.isArray(subs.result) || !(subs.errors === null || Array.isArray(subs.errors) && subs.errors.length === 0)) throw new Error('invalid subscription response');
  const pagination = subs.result_info;
  if (pagination && (!Number.isInteger(pagination.total_count) || pagination.total_count !== subs.result.length || pagination.page !== undefined && pagination.page !== 1)) throw new Error('incomplete subscriptions');
  const matches = subs.result.filter(item => item?.id === subscriptionId);
  if (matches.length !== 1) throw new Error('subscription mismatch');
  const cycleStart = timestamp(matches[0].current_period_start), cycleEnd = timestamp(matches[0].current_period_end);
  if (!Number.isSafeInteger(cycleStart) || !Number.isSafeInteger(cycleEnd) || cycleStart < 0 || cycleStart > now || cycleEnd <= now || now - cycleStart > 31 * 86400000) throw new Error('invalid subscription period');
  const aiDay = day(now);
  const variables = { account: accountId, start: iso(cycleStart), end: iso(now), dayStart: `${aiDay}T00:00:00.000Z`, storageStart: iso(now - 86400000) };
  const query = QUERY.replace(/\$(account|start|end|dayStart|storageStart)\b/g, (_, name) => JSON.stringify(variables[name]));
  const result = await json(fetcher, `${base}/graphql`, token, { query }, 'analytics');
  if (result?.errors?.some(error => /not authorized|authorization denied|permission/i.test(error?.message ?? ''))) {
    throw new Error('analytics_authorization_denied');
  }
  if (!result || !(result.errors === undefined || result.errors === null || Array.isArray(result.errors) && result.errors.length === 0) || !Array.isArray(result.data?.viewer?.accounts) || result.data.viewer.accounts.length !== 1) throw new Error('invalid analytics response');
  const a = result.data.viewer.accounts[0];
  const [requests, cpuUs] = aggregate(a.workers, ['requests', 'cpuTimeUs']);
  const [d1Reads, d1Writes] = aggregate(a.d1, ['rowsRead', 'rowsWritten']);
  const [aiNeurons] = aggregate(a.ai, ['totalNeurons']);
  if (!Array.isArray(a.storage) || a.storage.length >= 10000) throw new Error('invalid storage aggregate');
  const databases = new Map();
  for (const row of a.storage) {
    const id = row?.dimensions?.databaseId;
    if (typeof id !== 'string' || !id) throw new Error('invalid database identity');
    const size = amount(row?.max?.databaseSizeBytes);
    databases.set(id, Math.max(databases.get(id) ?? 0, size));
  }
  const storage = [...databases.values()].reduce((sum, size) => sum + size, 0);
  const usage = { requests: Math.ceil(requests), cpuMs: Math.ceil(cpuUs / 1000), d1Reads: Math.ceil(d1Reads), d1Writes: Math.ceil(d1Writes), d1StorageBytes: Math.ceil(storage), aiNeurons: Math.ceil(aiNeurons) };
  if (Object.values(usage).some(value => !Number.isSafeInteger(value))) throw new Error('analytics amount overflow');
  return { cycleStart, cycleEnd, aiDay, observedAt: now, usage, mode: 'estimated' };
}
