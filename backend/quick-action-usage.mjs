import { collectAnalyticsUsage } from './analytics-usage.mjs';

export async function collectQuickActionUsage({accountId, subscriptionId, token, now = Date.now(), fetch: fetcher = (url, options) => globalThis.fetch(url, options)} = {}) {
  const period = await collectAnalyticsUsage({accountId, subscriptionId, token, now, fetch: fetcher});
  const start = new Date(now - 31 * 86_400_000).toISOString(), end = new Date(now).toISOString();
  const query = `query { viewer { accounts(filter:{accountTag:${JSON.stringify(accountId)}}) { time: browserRenderingBrowserTimeUsageAdaptiveGroups(limit:1,filter:{datetime_geq:${JSON.stringify(start)},datetime_lt:${JSON.stringify(end)}}) { sum { totalSessionDurationMs } } } } }`;
  const controller = new AbortController(); let timer;
  try {
    const graph = await Promise.race([(async () => {
      const response = await fetcher('https://api.cloudflare.com/client/v4/graphql', {method:'POST',redirect:'manual',signal:controller.signal,headers:{Authorization:`Bearer ${token.replace(/\s/g,'')}`,Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({query})});
      if (!response.ok || !response.body?.getReader) throw new Error('browser_usage_unavailable');
      const reader = response.body.getReader(), chunks = []; let length = 0;
      while (true) { const {done,value} = await reader.read(); if (done) break; length += value.byteLength; if (length > 1024 * 1024) { void reader.cancel(); throw new Error('browser_usage_too_large'); } chunks.push(value); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    })(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('browser_usage_timeout'));},10_000);})]);
    if (!graph || !(graph.errors == null || Array.isArray(graph.errors) && graph.errors.length === 0) || !Array.isArray(graph.data?.viewer?.accounts) || graph.data.viewer.accounts.length !== 1) throw new Error('invalid_browser_response');
    const rows = graph.data.viewer.accounts[0]?.time;
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('invalid_browser_aggregate');
    const amount = rows.length ? rows[0]?.sum?.totalSessionDurationMs : 0;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.ceil(amount))) throw new Error('invalid_browser_aggregate');
    return {accountId,cycleStart:period.cycleStart,cycleEnd:period.cycleEnd,observedAt:now,usageMs:Math.ceil(amount),complete:true};
  } finally { clearTimeout(timer); }
}
