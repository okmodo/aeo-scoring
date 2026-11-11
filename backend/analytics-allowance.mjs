import { createAllowanceGuard } from './allowance-store.mjs';
import { MAX_EVIDENCE_AGE_MS, METRICS, validAmounts } from './allowance-policy.mjs';
import { collectAnalyticsUsage } from './analytics-usage.mjs';

const FAILURE_BACKOFF_MS = 30_000;
const maximums = Object.fromEntries(METRICS.map(key => [key, Number.MAX_SAFE_INTEGER]));
const validationErrors = new Set([
  'invalid analytics configuration', 'invalid subscription response', 'incomplete subscriptions',
  'subscription mismatch', 'invalid subscription period', 'invalid analytics response',
  'invalid analytics aggregate', 'invalid storage aggregate', 'invalid database identity',
  'invalid analytics amount', 'analytics amount overflow', 'analytics response unavailable',
  'analytics response too large', 'analytics timeout', 'Invalid analytics snapshot',
]);
function failureCode(error) {
  const message = error?.message ?? '';
  if (/^(subscriptions_http_[45]\d\d|analytics_http_[45]\d\d|analytics_authorization_denied)$/.test(message)) return message;
  if (validationErrors.has(message)) return message.toLowerCase().replaceAll(' ', '_');
  if (error instanceof SyntaxError) return 'analytics_parse_error';
  if (error instanceof TypeError) {
    if (/illegal invocation|incorrect this/i.test(message)) return 'analytics_fetch_receiver';
    if (/headers?|bytestring|character/i.test(message)) return 'analytics_invalid_header';
    if (/request context|different request|I\/O/i.test(message)) return 'analytics_request_context';
    return 'analytics_type_error';
  }
  return 'analytics_collection_failed';
}
const retainedUsageSql = 'json_object(' + METRICS.map(key => {
  const period = key === 'aiNeurons' ? 'ai_day = excluded.ai_day' :
    'cycle_start = excluded.cycle_start AND cycle_end = excluded.cycle_end';
  const current = `json_extract(excluded.usage_json, '$.${key}')`;
  const previous = `COALESCE(json_extract(allowance_receipts.usage_json, '$.${key}'), 0)`;
  const retained = key === 'd1StorageBytes' ? current :
    `CASE WHEN allowance_receipts.subscription_id = excluded.subscription_id AND ${period}
      THEN MAX(${previous}, ${current}) ELSE ${current} END`;
  return `'${key}', ${retained}`;
}).join(', ') + ')';

// The user accepts sampling and reporting delay. observed_at and watermarks
// record collection time here, without claiming provider completeness.
export function createAnalyticsAllowanceGuard(db, config, { collect = collectAnalyticsUsage } = {}) {
  const guard = createAllowanceGuard(db, config);
  return {
    async reserve(request) {
      const now = request.now ?? Date.now();
      const { accountId, subscriptionId } = config;
      let stage = 'read_snapshot';
      try {
        const previous = await db.prepare('SELECT * FROM allowance_receipts WHERE account_id = ?1')
          .bind(accountId).first();
        const age = now - previous?.observed_at;
        const sameScope = previous?.subscription_id === subscriptionId;
        if (sameScope && previous.diagnostic_status === 'analytics_unavailable' && age >= 0 && age < FAILURE_BACKOFF_MS) {
          return { accepted: false, reason: 'invalid_evidence' };
        }
        const current = sameScope && previous.active === 1 && previous.diagnostic_status === 'analytics_estimate' &&
          age >= 0 && age < MAX_EVIDENCE_AGE_MS && previous.cycle_start <= now && previous.cycle_end > now &&
          previous.ai_day === new Date(now).toISOString().slice(0, 10);
        if (!current) {
          stage = 'collect_snapshot';
          const snapshot = await collect({ ...config, now });
          stage = 'validate_snapshot';
          if (snapshot.mode !== 'estimated' || snapshot.observedAt !== now ||
              !Number.isSafeInteger(snapshot.cycleStart) || !Number.isSafeInteger(snapshot.cycleEnd) ||
              snapshot.cycleStart > now || snapshot.cycleEnd <= now ||
              snapshot.aiDay !== new Date(now).toISOString().slice(0, 10) ||
              !validAmounts(snapshot.usage, { max: maximums })) throw new Error('Invalid analytics snapshot');
          const watermarks = JSON.stringify(Object.fromEntries(METRICS.map(key => [key, now])));
          stage = 'persist_snapshot';
          await db.prepare(`INSERT INTO allowance_receipts
            (account_id, generation, active, subscription_id, cycle_start, cycle_end, ai_day, observed_at,
             usage_json, watermarks_json, diagnostic_status)
            VALUES (?1, 1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'analytics_estimate')
            ON CONFLICT(account_id) DO UPDATE SET generation = generation + 1, active = 1,
              subscription_id = excluded.subscription_id, cycle_start = excluded.cycle_start,
              cycle_end = excluded.cycle_end, ai_day = excluded.ai_day, observed_at = excluded.observed_at,
              usage_json = ${retainedUsageSql}, watermarks_json = excluded.watermarks_json,
              diagnostic_status = excluded.diagnostic_status
            WHERE allowance_receipts.observed_at IS NULL OR allowance_receipts.observed_at <= excluded.observed_at`)
            .bind(accountId, subscriptionId, snapshot.cycleStart, snapshot.cycleEnd, snapshot.aiDay, now,
              JSON.stringify(snapshot.usage), watermarks).run();
        }
        stage = 'reserve_allowance';
        return await guard.reserve(request);
      } catch (error) {
        const failure = failureCode(error);
        const locations = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1)
          .map(line => line.match(/\bindex\.js:(\d{1,7}):(\d{1,7})\b/))
          .filter(Boolean).slice(0, 3).map(match => ({ line: Number(match[1]), column: Number(match[2]) })) : [];
        const diagnostic = locations.length ? { failure, stage, locations } : { failure, stage };
        await db.prepare(`INSERT INTO allowance_receipts
          (account_id, generation, active, subscription_id, observed_at, diagnostic_status, diagnostic_highwater_json)
          VALUES (?1, 1, 0, ?2, ?3, 'analytics_unavailable', ?4)
          ON CONFLICT(account_id) DO UPDATE SET generation = generation + 1, active = 0,
            subscription_id = excluded.subscription_id, observed_at = excluded.observed_at,
            diagnostic_status = excluded.diagnostic_status, diagnostic_highwater_json = excluded.diagnostic_highwater_json
          WHERE allowance_receipts.observed_at IS NULL OR allowance_receipts.observed_at <= excluded.observed_at`)
          .bind(accountId, subscriptionId, now, JSON.stringify(diagnostic)).run().catch(() => {});
        return { accepted: false, reason: 'invalid_evidence' };
      }
    },
  };
}
