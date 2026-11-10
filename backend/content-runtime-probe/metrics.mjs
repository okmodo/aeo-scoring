// Query only the isolated probe. Requires Workers Observability Write API permission.
const { CF_ACCOUNT_ID: account, CF_API_TOKEN: token, PROBE_NAME: name, PROBE_FROM_MS: from } = process.env;
if (!/^[a-f0-9]{32}$/.test(account || '') || !token || !/^aeo-content-runtime-probe-[a-z0-9-]+$/.test(name || '') || !/^\d{13}$/.test(from || '')) throw new Error('Set CF_ACCOUNT_ID, CF_API_TOKEN, PROBE_NAME and PROBE_FROM_MS');
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ queryId: 'aeo-content-runtime-probe', dry: true, timeframe: { from: Number(from), to: Date.now() }, view: 'invocations', limit: 100,
    parameters: { datasets: ['cloudflare-workers'], filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: name }] } }),
});
if (!response.ok) throw new Error(`Observability query failed: HTTP ${response.status}`);
const body = await response.json();
if (!body.success || !body.result?.invocations) throw new Error('No invocation data: check query status, permissions, indexing delay, and dashboard; do not infer zero CPU');
for (const [id, events] of Object.entries(body.result.invocations)) {
  for (const event of events) {
    const workers = event.$workers || {};
    if (workers.cpuTimeMs !== undefined) console.log(JSON.stringify({ id, cpuTimeMs: workers.cpuTimeMs, wallTimeMs: workers.wallTimeMs, outcome: workers.outcome, url: workers.event?.request?.url }));
  }
}
