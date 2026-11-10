import { MAX_EVIDENCE_AGE_MS, METRICS, validAmounts } from './allowance-policy.mjs';

const maxAmounts = Object.fromEntries(METRICS.map(key => [key, Number.MAX_SAFE_INTEGER]));
const cumulative = ['requests', 'cpuMs', 'd1Reads', 'd1Writes'];
const invalid = reason => ({ status: reason, baseline: null });

// Evaluates normalized observations, not their authority. No input field or
// caller-provided callback can confer billing authority or activate admission.
export function evaluateUsageTransition(previous, receipt, { accountId, subscriptionId, now }) {
  if (!receipt || receipt.accountId !== accountId || receipt.subscriptionId !== subscriptionId) return invalid('identity_mismatch');
  if (receipt.status === 'blocked') return invalid('partial');
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 ||
      !Number.isSafeInteger(receipt.observedAt) || receipt.observedAt > now || now - receipt.observedAt > MAX_EVIDENCE_AGE_MS ||
      !Number.isSafeInteger(receipt.cycleStart) || !Number.isSafeInteger(receipt.cycleEnd) || receipt.cycleStart < 0 ||
      receipt.cycleStart > now || receipt.cycleEnd <= now || receipt.cycleEnd <= receipt.cycleStart ||
      receipt.aiDay !== new Date(now).toISOString().slice(0, 10) || !validAmounts(receipt.usage, { max: maxAmounts })) return invalid('invalid_period_or_usage');
  const marks = {};
  const dayStart = Date.parse(`${receipt.aiDay}T00:00:00.000Z`);
  for (const key of METRICS) {
    const metric = receipt.metrics?.[key];
    const start = key === 'aiNeurons' ? dayStart : key === 'd1StorageBytes' ? null : receipt.cycleStart;
    if (!metric || !Number.isSafeInteger(metric.watermark) || metric.watermark > receipt.observedAt || now - metric.watermark > MAX_EVIDENCE_AGE_MS ||
        metric.coverage?.start !== start || metric.coverage?.end !== metric.watermark || start !== null && metric.watermark < start) return invalid('incomplete_watermark');
    marks[key] = metric.watermark;
  }
  if (previous) {
    if (previous.subscriptionId !== subscriptionId) return invalid('subscription_mismatch');
    if (receipt.observedAt <= previous.observedAt || METRICS.some(k => marks[k] <= previous.watermarks[k])) return invalid('replay_or_out_of_order');
    const sameCycle = receipt.cycleStart === previous.cycleStart && receipt.cycleEnd === previous.cycleEnd;
    if (!sameCycle && receipt.cycleStart !== previous.cycleEnd) return invalid('cycle_mismatch');
    if (sameCycle && cumulative.some(k => receipt.usage[k] < previous.usage[k])) return invalid('cumulative_decrease');
    const nextDay = new Date(Date.parse(`${previous.aiDay}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
    if (receipt.aiDay !== previous.aiDay && receipt.aiDay !== nextDay) return invalid('day_mismatch');
    if (receipt.aiDay === previous.aiDay && receipt.usage.aiNeurons < previous.usage.aiNeurons) return invalid('daily_decrease');
  }
  const usage = { ...receipt.usage, d1StorageBytes: Math.max(receipt.usage.d1StorageBytes, previous?.usage.d1StorageBytes ?? 0) };
  return { status: 'complete_untrusted', baseline: { subscriptionId, cycleStart: receipt.cycleStart, cycleEnd: receipt.cycleEnd,
    aiDay: receipt.aiDay, observedAt: receipt.observedAt, usage, watermarks: marks } };
}

export function createUsageReconciler(db, { accountId, subscriptionId } = {}) {
  async function begin() {
    if (typeof accountId !== 'string' || !accountId.trim() || typeof subscriptionId !== 'string' || !subscriptionId.trim()) throw new TypeError('account and subscription required');
    const row = await db.prepare(`INSERT INTO allowance_receipts (account_id, generation, active, diagnostic_status) VALUES (?1, 1, 0, 'pending')
      ON CONFLICT(account_id) DO UPDATE SET generation = generation + 1, active = 0, diagnostic_status = 'pending' RETURNING generation`).bind(accountId).first();
    return row.generation;
  }
  async function finish(generation, receipt, now = Date.now()) {
    if (!Number.isSafeInteger(generation) || generation < 1) return { accepted: false, reason: 'invalid_generation' };
    const current = await db.prepare('SELECT baseline_json, diagnostic_highwater_json FROM allowance_receipts WHERE account_id = ?1 AND generation = ?2 AND active = 0 AND diagnostic_status = \'pending\'').bind(accountId, generation).first();
    if (!current) return { accepted: false, reason: 'superseded' };
    let previous, highwater;
    try { previous = current.baseline_json ? JSON.parse(current.baseline_json) : null; highwater = current.diagnostic_highwater_json ? JSON.parse(current.diagnostic_highwater_json) : {}; }
    catch { return { accepted: false, reason: 'invalid_stored_state' }; }
    let result;
    try { result = evaluateUsageTransition(previous, receipt, { accountId, subscriptionId, now }); }
    catch { return { accepted: false, reason: 'invalid_stored_state' }; }
    if (result.status === 'partial') {
      for (const key of METRICS) {
        const value = receipt.metrics?.[key]?.observedQuantity;
        if (Number.isSafeInteger(value) && value >= 0) highwater[key] = Math.max(highwater[key] ?? value, value);
      }
    }
    const row = await db.prepare(`UPDATE allowance_receipts SET diagnostic_status = ?3, baseline_json = ?4, diagnostic_highwater_json = ?5
      WHERE account_id = ?1 AND generation = ?2 AND active = 0 AND diagnostic_status = 'pending' RETURNING generation`)
      .bind(accountId, generation, result.status, JSON.stringify(result.baseline ?? previous), JSON.stringify(highwater)).first();
    return { accepted: false, reason: row ? result.status : 'superseded' };
  }
  return { begin, finish };
}
