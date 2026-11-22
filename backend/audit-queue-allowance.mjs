// Each compact message may incur an enqueue, three deliveries and a deletion
// in each of the main queue and DLQ. Keep in sync with both retry limits.
export const AUDIT_QUEUE_OPERATIONS_PER_SEND = 10;
export const AUDIT_QUEUE_PERIOD_LIMIT = 600_000;
const DAY = 86_400_000;
const MAX_RECEIPT_AGE = 5 * 60_000;
const LIMIT = 1024 * 1024;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;

async function json(fetcher, url, token, body) {
  const controller = new AbortController();
  let timer;
  const work = async () => {
    const response = await fetcher(url, {method: body ? 'POST' : 'GET', redirect:'manual', signal:controller.signal,
      headers:{Authorization:`Bearer ${token}`, Accept:'application/json', ...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {})});
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw Error('unavailable');
    }
    if (!response.body?.getReader) throw Error('unavailable');
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) { void reader.cancel(); throw Error('oversized'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  };
  try { return await Promise.race([work(), new Promise((_,reject) => { timer = setTimeout(() => {controller.abort(); reject(Error('timeout'));},10_000); })]); }
  finally { clearTimeout(timer); }
}

export async function collectAuditQueueUsage({accountId, subscriptionId, token, fetch: fetcher = (url, options) => globalThis.fetch(url, options), now = Date.now()} = {}) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? '') || !/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId ?? '') ||
      typeof token !== 'string' || !token.trim() || typeof fetcher !== 'function' || !Number.isSafeInteger(now) || now < DAY || now > 8640000000000000) throw Error('invalid configuration');
  token = token.replace(/\s/g, '');
  const base = 'https://api.cloudflare.com/client/v4';
  const subs = await json(fetcher, `${base}/accounts/${accountId}/subscriptions`, token);
  if (subs?.success !== true || !Array.isArray(subs.result) || !(subs.errors === null || Array.isArray(subs.errors) && !subs.errors.length)) throw Error('invalid subscriptions');
  const page = subs.result_info;
  if (page && (!Number.isInteger(page.total_count) || page.total_count !== subs.result.length || page.page !== undefined && page.page !== 1)) throw Error('incomplete subscriptions');
  const matches = subs.result.filter(item => item?.id === subscriptionId);
  if (matches.length !== 1) throw Error('subscription mismatch');
  const cycleStart = timestamp(matches[0].current_period_start), cycleEnd = timestamp(matches[0].current_period_end);
  if (!Number.isSafeInteger(cycleStart) || !Number.isSafeInteger(cycleEnd) || cycleStart < 0 || cycleStart > now || cycleEnd <= now || now - cycleStart > 31 * DAY) throw Error('invalid cycle');
  const query = `query QueueUsage { viewer { accounts(filter: {accountTag: ${JSON.stringify(accountId)}}) { queueMessageOperationsAdaptiveGroups(limit: 1, filter: {datetime_geq: ${JSON.stringify(new Date(cycleStart).toISOString())}, datetime_lt: ${JSON.stringify(new Date(now).toISOString())}}) { sum { billableOperations } } } } }`;
  const result = await json(fetcher, `${base}/graphql`, token, {query});
  if (!result || !(result.errors === undefined || result.errors === null || Array.isArray(result.errors) && !result.errors.length) || !Array.isArray(result.data?.viewer?.accounts) || result.data.viewer.accounts.length !== 1) throw Error('invalid analytics');
  const rows = result.data.viewer.accounts[0]?.queueMessageOperationsAdaptiveGroups;
  if (!Array.isArray(rows) || rows.length > 1) throw Error('invalid aggregate');
  const operations = rows.length ? rows[0]?.sum?.billableOperations : 0;
  if (typeof operations !== 'number' || !Number.isFinite(operations) || operations < 0 || !Number.isSafeInteger(Math.ceil(operations))) throw Error('invalid operations');
  return {accountId, subscriptionId, cycleStart, cycleEnd, observedAt:now, operations:Math.ceil(operations), mode:'estimated'};
}

export function createAuditQueueAllowance(db, config, {collect = collectAuditQueueUsage} = {}) {
  return {async reserve({now = Date.now()} = {}) {
    const {accountId, subscriptionId} = config ?? {};
    try {
      if (!Number.isSafeInteger(now) || now < DAY || typeof accountId !== 'string' || !accountId || typeof subscriptionId !== 'string' || !subscriptionId) throw Error('invalid request');
      const snapshot = await collect({...config, now});
      if (snapshot?.mode !== 'estimated' || snapshot.accountId !== accountId || snapshot.subscriptionId !== subscriptionId || snapshot.observedAt !== now ||
          !Number.isSafeInteger(snapshot.cycleStart) || !Number.isSafeInteger(snapshot.cycleEnd) || snapshot.cycleStart < 0 || snapshot.cycleStart > now || snapshot.cycleEnd <= now || now - snapshot.cycleStart > 31 * DAY ||
          !Number.isSafeInteger(snapshot.operations) || snapshot.operations < 0) throw Error('invalid snapshot');
      await db.prepare(`INSERT INTO audit_queue_receipts(account_id, subscription_id, cycle_start, cycle_end, observed_at, operations)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(account_id) DO UPDATE SET subscription_id=excluded.subscription_id, cycle_start=excluded.cycle_start,
          cycle_end=excluded.cycle_end, observed_at=excluded.observed_at,
          operations=CASE WHEN audit_queue_receipts.subscription_id=excluded.subscription_id AND audit_queue_receipts.cycle_start=excluded.cycle_start AND audit_queue_receipts.cycle_end=excluded.cycle_end THEN MAX(audit_queue_receipts.operations, excluded.operations) ELSE excluded.operations END
        WHERE audit_queue_receipts.observed_at <= excluded.observed_at`)
        .bind(accountId, subscriptionId, snapshot.cycleStart, snapshot.cycleEnd, now, snapshot.operations).run();
      // A single conditional upsert serializes competing admissions. Buckets
      // include the entire boundary day and the preceding 24 hours, covering
      // rollover deliveries while bounding reads to at most 33 daily rows.
      const dayStart = Math.floor(now / DAY) * DAY;
      const admitted = await db.prepare(`INSERT INTO audit_queue_reservations(account_id, day_start, operations)
        SELECT ?1, ?8, ?4 FROM audit_queue_receipts r
        WHERE r.account_id=?1 AND r.subscription_id=?2 AND r.cycle_start<=?3 AND r.cycle_end>?3
          AND r.observed_at<=?3 AND r.observed_at>=?3-?5
          AND r.operations + COALESCE((SELECT SUM(operations) FROM audit_queue_reservations q
            WHERE q.account_id=?1 AND q.day_start>=(CAST(r.cycle_start / ?6 AS INTEGER) * ?6)-?6 AND q.day_start<=?8),0) + ?4 <= ?7
        ON CONFLICT(account_id, day_start) DO UPDATE SET operations=operations+excluded.operations
        RETURNING day_start`).bind(accountId, subscriptionId, now, AUDIT_QUEUE_OPERATIONS_PER_SEND, MAX_RECEIPT_AGE, DAY, AUDIT_QUEUE_PERIOD_LIMIT, dayStart).first();
      return admitted ? {accepted:true, reason:null} : {accepted:false, reason:'allowance_exhausted'};
    } catch { return {accepted:false, reason:'invalid_evidence'}; }
  }};
}
