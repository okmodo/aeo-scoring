import { ALLOWANCE_VERSION, INCLUDED_CEILINGS, MAX_EVIDENCE_AGE_MS, METRICS, validAmounts } from './allowance-policy.mjs';

const columns = ['requests', 'cpu_ms', 'd1_reads', 'd1_writes', 'd1_storage_bytes', 'ai_neurons'];
const deny = reason => ({ accepted: false, reason });
const canonical = values => JSON.stringify(Object.fromEntries(METRICS.map(key => [key, values[key] ?? 0])));

// Completed local usage is anchored against account estimates; unresolved holds remain additive.
export function createAllowanceGuard(db, { accountId, subscriptionId, allocations = INCLUDED_CEILINGS } = {}) {
  return {
    async settle({ id, costs = {}, now = Date.now() } = {}) {
      if (typeof id !== 'string' || !id.trim() || id.length > 200 || !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 ||
          !costs || typeof costs !== 'object' || Array.isArray(costs) || Object.keys(costs).some(k => k !== 'aiNeurons') ||
          (costs.aiNeurons !== undefined && (!Number.isSafeInteger(costs.aiNeurons) || costs.aiNeurons < 0))) return deny('invalid_request');
      const reservation = await db.prepare('SELECT ai_neurons, ai_day, cycle_start FROM allowance_reservations WHERE account_id = ?1 AND id = ?2').bind(accountId, id).first();
      if (!reservation) return deny('unknown_reservation');
      const actual = costs.aiNeurons ?? reservation.ai_neurons;
      const existing = await db.prepare('SELECT actual_ai FROM allowance_settlements_v2 WHERE account_id = ?1 AND id = ?2').bind(accountId, id).first();
      if (existing) return existing.actual_ai === actual ? { accepted: true, duplicate: true } : deny('settlement_conflict');
      const receipt = await db.prepare('SELECT generation, cycle_start, cycle_end FROM allowance_receipts WHERE account_id = ?1 AND subscription_id = ?2 AND active = 1').bind(accountId, subscriptionId).first();
      if (!receipt || receipt.cycle_start > now || receipt.cycle_end <= now) return deny('invalid_evidence');
      const completionDay = new Date(now).toISOString().slice(0, 10);
      const priorDay = new Date(now - 86_400_000).toISOString().slice(0, 10);
      if (now < reservation.cycle_start || (reservation.ai_day !== completionDay && reservation.ai_day !== priorDay)) return deny('invalid_chronology');
      if (receipt.cycle_start !== reservation.cycle_start) {
        const originalCycle = await db.prepare('SELECT cycle_end FROM allowance_cycles WHERE account_id = ?1 AND cycle_start = ?2').bind(accountId, reservation.cycle_start).first();
        if (!originalCycle || originalCycle.cycle_end !== receipt.cycle_start) return deny('invalid_chronology');
      }
      const overflowChecks = METRICS.map((metric, i) => {
        const value = i === 5 ? '?3' : `r.${columns[i]}`;
        const original = i === 5 ? 'r.ai_day' : i === 4 ? "'stock'" : 'CAST(r.cycle_start AS TEXT)';
        const completion = i === 5 ? '?6' : i === 4 ? "'stock'" : '?5';
        return `NOT EXISTS (SELECT 1 FROM allowance_settled_v2 s WHERE s.account_id = ?1 AND s.metric = '${metric}'
          AND s.period IN (${original}, ${completion}) AND s.amount > ?7 - ${value})`;
      }).join(' AND ');
      const row = await db.prepare(`INSERT OR IGNORE INTO allowance_settlements_v2
        SELECT ?1, ?2, ?3, ?4, ?5, ?6 FROM allowance_reservations r WHERE r.account_id = ?1 AND r.id = ?2
        AND NOT EXISTS (SELECT 1 FROM allowance_settlements_v2 existing WHERE existing.account_id = ?1 AND existing.id = ?2)
        AND ${overflowChecks} AND EXISTS (SELECT 1 FROM allowance_receipts e
          WHERE e.account_id = ?1 AND e.subscription_id = ?8 AND e.active = 1 AND e.generation = ?9
          AND e.cycle_start = ?10 AND e.cycle_end = ?11 AND e.cycle_start <= ?4 AND e.cycle_end > ?4)
        AND (r.cycle_start = ?10 OR EXISTS (SELECT 1 FROM allowance_cycles c
          WHERE c.account_id = ?1 AND c.cycle_start = r.cycle_start AND c.cycle_end = ?10)) RETURNING id`)
        .bind(accountId, id, actual, now, String(receipt.cycle_start), completionDay, Number.MAX_SAFE_INTEGER, subscriptionId, receipt.generation, receipt.cycle_start, receipt.cycle_end).first();
      if (row) return { accepted: true, duplicate: false, overrun: actual > reservation.ai_neurons };
      const raced = await db.prepare('SELECT actual_ai FROM allowance_settlements_v2 WHERE account_id = ?1 AND id = ?2').bind(accountId, id).first();
      return raced ? (raced.actual_ai === actual ? { accepted: true, duplicate: true } : deny('settlement_conflict')) : deny('invalid_evidence_or_overflow');
    },
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
      // Each anchor and its settled cutoff are captured in one statement. Concurrent
      // settlements are either included in both or in neither.
      for (const key of METRICS) {
        const period = key === 'aiNeurons' ? e.aiDay : key === 'd1StorageBytes' ? 'stock' : String(e.cycleStart);
        await db.prepare(`INSERT OR IGNORE INTO allowance_anchors_v2
          SELECT ?1, ?2, ?3, MAX(?4, COALESCE(s.amount, 0)), COALESCE(s.amount, 0)
          FROM (SELECT 1) LEFT JOIN allowance_settled_v2 s ON s.account_id = ?1 AND s.metric = ?2 AND s.period = ?3
          WHERE EXISTS (SELECT 1 FROM allowance_receipts WHERE account_id = ?1 AND subscription_id = ?5 AND active = 1 AND generation = ?6)`)
          .bind(accountId, key, period, e.usage[key], subscriptionId, generation).run();
      }
      const checks = METRICS.map((key, i) => {
        const period = i === 5 ? '?4' : i === 4 ? "'stock'" : 'CAST(CAST(?3 AS INTEGER) AS TEXT)';
        return `EXISTS (SELECT 1 FROM allowance_anchors_v2 a
          LEFT JOIN allowance_settled_v2 s ON s.account_id = a.account_id AND s.metric = a.metric AND s.period = a.period
          LEFT JOIN allowance_pending_v2 p ON p.account_id = a.account_id AND p.metric = a.metric
          WHERE a.account_id = ?1 AND a.metric = '${key}' AND a.period = ${period}
          AND MAX(?${17+i}, a.baseline + COALESCE(s.amount, 0) - a.cutoff) + COALESCE(p.amount, 0) + ?${11+i} <= ?${23+i})`;
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
