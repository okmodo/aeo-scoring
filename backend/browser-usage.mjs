import { collectAnalyticsUsage } from './analytics-usage.mjs';

export const BROWSER_CYCLE_LIMIT_MS = 21_600_000;
export const BROWSER_CONCURRENCY_LIMIT = 6;
const LIMIT = 1024 * 1024;
const timeout = 10_000;

async function readJson(fetcher, url, token, body) {
  const controller = new AbortController();
  let timer;
  const work = async () => {
    const response = await fetcher(url, {method:body ? 'POST' : 'GET', redirect:'manual', signal:controller.signal,
      headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {})});
    if (!response.ok || !response.body?.getReader) throw new Error('browser_usage_unavailable');
    const reader = response.body.getReader(), chunks = []; let length = 0;
    while (true) { const {done,value} = await reader.read(); if (done) break; length += value.byteLength;
      if (length > LIMIT) { await reader.cancel(); throw new Error('browser_usage_too_large'); } chunks.push(value); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  };
  try {
    return await Promise.race([work(), new Promise((_,reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('browser_usage_timeout')); },timeout); })]);
  } finally { clearTimeout(timer); }
}
async function boundedList(listSessions, args) {
  let timer;
  try {
    return await Promise.race([listSessions(args), new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('browser_sessions_timeout')),timeout); })]);
  } finally { clearTimeout(timer); }
}
const valid = n => Number.isSafeInteger(n) && n >= 0;
function aggregate(rows, group, field) {
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('invalid_browser_aggregate');
  if (!rows.length) return 0;
  const n = rows[0]?.[group]?.[field];
  if (!valid(n)) throw new Error('invalid_browser_aggregate');
  return n;
}

// Session presence bound in 28-day units: each closed session can cross at
// most two extra date boundaries, plus its total duration in days. Active
// sessions are conservatively charged for every day. Sampling and lag apply.
export async function collectBrowserUsage({accountId, subscriptionId, token, fetch:fetcher = (url, options) => globalThis.fetch(url, options), listSessions, now = Date.now()} = {}) {
  if (!/^[0-9a-f]{32}$/.test(accountId ?? '') || typeof token !== 'string' || !token || typeof fetcher !== 'function') throw new Error('invalid_browser_configuration');
  token = token.replace(/\s/g,'');
  const period = await collectAnalyticsUsage({accountId,subscriptionId,token,fetch:fetcher,now});
  const start = new Date(now - 31 * 86_400_000).toISOString(), end = new Date(now).toISOString();
  const query = `query { viewer { accounts(filter:{accountTag:${JSON.stringify(accountId)}}) {
    time: browserRenderingBrowserTimeUsageAdaptiveGroups(limit:1,filter:{datetime_geq:${JSON.stringify(start)},datetime_lt:${JSON.stringify(end)}}) { count sum { totalSessionDurationMs } }
  } } }`;
  const base = 'https://api.cloudflare.com/client/v4';
  const [graph,sessions] = await Promise.all([
    readJson(fetcher,`${base}/graphql`,token,{query}),
    typeof listSessions === 'function' ? boundedList(listSessions,{accountId,now}) : readJson(fetcher,`${base}/accounts/${accountId}/browser-rendering/devtools/session`,token),
  ]);
  if (!graph || !(graph.errors == null || Array.isArray(graph.errors) && graph.errors.length === 0) || !Array.isArray(graph.data?.viewer?.accounts) || graph.data.viewer.accounts.length !== 1 || !Array.isArray(sessions)) throw new Error('invalid_browser_response');
  if (sessions.length >= 10000 || sessions.some(s => typeof s?.sessionId !== 'string' || !s.sessionId) || new Set(sessions.map(s => s.sessionId)).size !== sessions.length) throw new Error('invalid_browser_sessions');
  const a = graph.data.viewer.accounts[0];
  const sessionCount = a.time.length ? a.time[0].count : 0;
  if (!valid(sessionCount) || !Number.isSafeInteger(sessionCount + sessions.length)) throw new Error('invalid_browser_aggregate');
  const usageMs = aggregate(a.time,'sum','totalSessionDurationMs');
  const concurrencyUnits = 2 * sessionCount + Math.ceil(usageMs / 86_400_000) + 28 * sessions.length;
  if (!valid(concurrencyUnits)) throw new Error('invalid_browser_aggregate');
  return {accountId,cycleStart:period.cycleStart,cycleEnd:period.cycleEnd,observedAt:now,
    usageMs,concurrencyUnits,
    activeSessions:sessions.length,complete:true};
}

// The session-details endpoint returns a bare object. Cloudflare Playwright's
// documented examples use Unix milliseconds; reject seconds and future times.
export async function verifyBrowserClosed({accountId, sessionId, token, fetch:fetcher = (url, options) => globalThis.fetch(url, options), now = Date.now()} = {}) {
  if (!/^[0-9a-f]{32}$/.test(accountId ?? '') || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId ?? '') || typeof token !== 'string' || !token || !valid(now)) throw new Error('invalid_browser_configuration');
  const detail = await readJson(fetcher, `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/session/${sessionId}`, token.replace(/\s/g,''));
  if (!detail || detail.sessionId !== sessionId || !valid(detail.startTime) || !valid(detail.endTime) || detail.startTime < 1_000_000_000_000 || detail.endTime < detail.startTime || detail.endTime > now) throw new Error('browser_closure_unknown');
  return {sessionId,closed:true,durationMs:detail.endTime-detail.startTime,observedAt:now};
}
