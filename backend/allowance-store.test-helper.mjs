import { createAllowanceGuard } from './allowance-store.mjs';
import { METRICS } from './allowance-policy.mjs';

// Offline tests alone seed synthetic persisted state; this grants no authority.
export function createTestAllowanceGuard(db, { accountId, evidence, allocations } = {}) {
  const subscriptionId = 'fixture-subscription';
  const guard = createAllowanceGuard(db, { accountId, subscriptionId, allocations });
  return { async reserve(request) {
    const e = evidence ?? {};
    const active = e.verified === true && e.accountId === accountId ? 1 : 0;
    const marks = Object.fromEntries(METRICS.map(key => [key, e.observedAt ?? null]));
    await db.prepare(`INSERT INTO allowance_receipts (account_id, generation, active, cycle_start, cycle_end, ai_day, observed_at, usage_json, watermarks_json, subscription_id)
      VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'fixture-subscription')
      ON CONFLICT(account_id) DO UPDATE SET subscription_id = excluded.subscription_id, active = excluded.active, cycle_start = excluded.cycle_start,
      cycle_end = excluded.cycle_end, ai_day = excluded.ai_day, observed_at = excluded.observed_at,
      usage_json = excluded.usage_json, watermarks_json = excluded.watermarks_json`)
      .bind(accountId, active, e.cycleStart ?? null, e.cycleEnd ?? null, e.aiDay ?? null, e.observedAt ?? null,
        JSON.stringify(e.usage ?? {}), JSON.stringify(marks)).run();
    return guard.reserve(request);
  } };
}
