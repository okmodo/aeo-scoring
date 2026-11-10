import { collectUsage } from './usage-collector.mjs';
import { createUsageReconciler } from './usage-reconciliation.mjs';

// Management-API collection runs locally, not in a new billable Worker/cron.
// Every attempt invalidates previous admission BEFORE starting acquisition.
export async function runUsageCollection({ db, config, collect = collectUsage, now = Date.now }) {
  const reconciler = createUsageReconciler(db, config);
  const generation = await reconciler.begin();
  let receipt;
  try { receipt = await collect({ ...config, now: now() }); }
  catch {
    receipt = { status: 'blocked', accountId: config.accountId, subscriptionId: config.subscriptionId,
      fetchedAt: now(), cycle: null, metrics: {}, diagnostics: ['collection_failed'] };
  }
  const reconciliation = await reconciler.finish(generation, receipt, now());
  return { version: 1, mode: 'diagnostic', accountId: config.accountId,
    generation, receipt, reconciliation, admissionEnabled: false };
}
