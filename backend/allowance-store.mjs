import { ALLOWANCE_VERSION, INCLUDED_CEILINGS, MAX_EVIDENCE_AGE_MS, METRICS, validAmounts } from './allowance-policy.mjs';

const columns = ['requests', 'cpu_ms', 'd1_reads', 'd1_writes', 'd1_storage_bytes', 'ai_neurons'];
const deny = reason => ({ accepted: false, reason });
const canonical = values => JSON.stringify(Object.fromEntries(METRICS.map(key => [key, values[key] ?? 0])));

// Usage evidence covers the whole account. Counting all local reservations again is
// deliberately conservative, including reservations already reflected in evidence.
export function createAllowanceGuard(db, { accountId, subscriptionId, allocations = INCLUDED_CEILINGS } = {}) {
  return {
    async reserve({ id = crypto.randomUUID(), costs, now = Date.now() } = {}) {
      if (typeof accountId !== 'string' || !accountId.trim() || typeof subscriptionId !== 'string' || !subscriptionId.trim() || typeof id !== 'string' || !id.trim() || id.length > 200 ||
          !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 || !validAmounts(costs, { partial: true }) ||
          !METRICS.some(key => (costs[key] ?? 0) > 0) || !validAmounts(allocations)) return deny('invalid_request');
      const persisted = await db.prepare('SELECT * FROM allowance_receipts WHERE account_id = ?1 AND subscription_id = ?2 AND active = 1').bind(accountId, subscriptionId).first();
      if (!persisted) return deny('invalid_evidence');
      const generation = persisted.generation;
      let e;
      try {
        const watermarks = JSON.parse(persisted.watermarks_json);
        if (!METRICS.every(key => Number.isSafeInteger(watermarks[key]) && watermarks[key] <= now && now - watermarks[key] <= MAX_EVIDENCE_AGE_MS)) return deny('invalid_evidence');
        e = { accountId, observedAt: persisted.observed_at, cycleStart: persisted.cycle_start, cycleEnd: persisted.cycle_end, aiDay: persisted.ai_day, usage: JSON.parse(persisted.usage_json) };
      } catch { return deny('invalid_evidence'); }
      if (!e || e.accountId !== accountId || !Number.isSafeInteger(e.observedAt) ||
          e.observedAt > now || now - e.observedAt > MAX_EVIDENCE_AGE_MS ||
          !Number.isSafeInteger(e.cycleStart) || !Number.isSafeInteger(e.cycleEnd) ||
          e.cycleStart < 0 || e.cycleStart > now || e.cycleEnd <= now || e.cycleEnd <= e.cycleStart ||
          e.aiDay !== new Date(now).toISOString().slice(0, 10) || !validAmounts(e.usage, { max: Object.fromEntries(METRICS.map(k => [k, Number.MAX_SAFE_INTEGER])) })) return deny('invalid_evidence');
      const allocationJson = canonical(allocations);
      const costJson = canonical(costs);
      // A cycle's allocation cannot be changed by a later request or concurrent instance.
      await db.prepare(`INSERT OR IGNORE INTO allowance_cycles (account_id, cycle_start, cycle_end, policy_version, allocations_json)
        SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (
          SELECT 1 FROM allowance_cycles WHERE account_id = ?1 AND cycle_start <> ?2
          AND cycle_start < ?3 AND cycle_end > ?2)`).bind(accountId, e.cycleStart, e.cycleEnd, ALLOWANCE_VERSION, allocationJson).run();
      const cycle = await db.prepare(`SELECT cycle_end, policy_version, allocations_json FROM allowance_cycles WHERE account_id = ?1 AND cycle_start = ?2`).bind(accountId, e.cycleStart).first();
      if (!cycle || cycle.cycle_end !== e.cycleEnd || cycle.policy_version !== ALLOWANCE_VERSION || cycle.allocations_json !== allocationJson) return deny('cycle_mismatch');
      const existing = await db.prepare('SELECT cycle_start, ai_day, costs_json FROM allowance_reservations WHERE account_id = ?1 AND id = ?2 AND EXISTS (SELECT 1 FROM allowance_receipts WHERE account_id = ?1 AND subscription_id = ?4 AND active = 1 AND generation = ?3)').bind(accountId, id, generation, subscriptionId).first();
      if (existing) return existing.cycle_start === e.cycleStart && existing.ai_day === e.aiDay && existing.costs_json === costJson
        ? { accepted: true, duplicate: true } : deny('id_conflict');
      const amounts = METRICS.map(key => costs[key] ?? 0);
      // One conditional insert checks every metric and records all costs atomically.
      const checks = columns.map((column, i) => {
        const lookup = i === 5
          ? '(SELECT ai_neurons FROM allowance_days WHERE account_id = ?1 AND ai_day = ?4)'
          : i === 4
            ? '(SELECT d1_storage_bytes FROM allowance_storage WHERE account_id = ?1)'
            : `(SELECT ${column} FROM allowance_totals WHERE account_id = ?1 AND cycle_start = ?3)`;
        return `?${11 + i} + ?${17 + i} + COALESCE(${lookup}, 0) <= ?${23 + i}`;
      }).join(' AND ');
      const insert = `INSERT OR IGNORE INTO allowance_reservations (account_id, id, cycle_start, ai_day, costs_json, ${columns.join(', ')})
        SELECT ?1, ?2, ?3, ?4, ?5, ?11, ?12, ?13, ?14, ?15, ?16 WHERE ${checks} AND EXISTS (SELECT 1 FROM allowance_receipts WHERE account_id = ?1 AND subscription_id = ?30 AND active = 1 AND generation = ?29) RETURNING id`;
      const row = await db.prepare(insert).bind(accountId, id, e.cycleStart, e.aiDay, costJson, null, null, null, null, null,
        ...amounts, ...METRICS.map(key => e.usage[key]), ...METRICS.map(key => allocations[key]), generation, subscriptionId).first();
      if (row) return { accepted: true, duplicate: false };
      const raced = await db.prepare('SELECT cycle_start, ai_day, costs_json FROM allowance_reservations WHERE account_id = ?1 AND id = ?2 AND EXISTS (SELECT 1 FROM allowance_receipts WHERE account_id = ?1 AND subscription_id = ?4 AND active = 1 AND generation = ?3)').bind(accountId, id, generation, subscriptionId).first();
      if (raced) return raced.cycle_start === e.cycleStart && raced.ai_day === e.aiDay && raced.costs_json === costJson
        ? { accepted: true, duplicate: true } : deny('id_conflict');
      return deny('allowance_exhausted');
    },
  };
}
