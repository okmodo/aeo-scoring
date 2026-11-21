import workersAi from '../config/workers-ai-allowance.json' with { type: 'json' };

// Workers AI uses its configured daily ceiling. Other Workers Paid limits are 60%.
// Bytes use decimal GB. These are admission ceilings, not account-wide guarantees.
export const ALLOWANCE_VERSION = 1;
export const MAX_INVOCATION_CPU_MS = 1000;
// Keep the prior admission reservation because Cloudflare may allow occasional
// overruns of the configured invocation limit.
export const RESERVED_INVOCATION_CPU_MS = 2000;
const dailyNeuronLimit = workersAi.dailyNeuronLimit;
if (!Number.isSafeInteger(dailyNeuronLimit) || dailyNeuronLimit < 1) {
  throw new Error('invalid_workers_ai_daily_neuron_limit');
}
export const INCLUDED_CEILINGS = Object.freeze({
  requests: 6_000_000, cpuMs: 18_000_000, d1Reads: 15_000_000_000,
  d1Writes: 30_000_000, d1StorageBytes: 3_000_000_000, aiNeurons: dailyNeuronLimit,
});
export const METRICS = Object.freeze(Object.keys(INCLUDED_CEILINGS));
export const MAX_EVIDENCE_AGE_MS = 5 * 60 * 1000;

export function validAmounts(value, { partial = false, max = INCLUDED_CEILINGS } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some(key => !METRICS.includes(key))) return false;
  return METRICS.every(key => partial && value[key] === undefined ||
    Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= max[key]);
}
