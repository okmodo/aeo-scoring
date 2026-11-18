import { BROWSER_CYCLE_LIMIT_MS, BROWSER_CONCURRENCY_LIMIT, collectBrowserUsage } from './browser-usage.mjs';

const deny = reason => ({ accepted: false, reason });
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
const number = n => Number.isSafeInteger(n) && n >= 0;
const MAX_AGE = 300_000;
export const BROWSER_CONTROLS_VERSION = 'browser-application-controls-v1';

// The application-controls capability is fixed by trusted deployment code.
// The timeout and cleanup do not impose a provider-enforced lifetime.
export function createBrowserAllowanceGuard(db, { accountId, subscriptionId, token, fetch: fetcher, listSessions, collect = collectBrowserUsage, verifyClosed, capability } = {}) {
  return {
    async reserve({ id, maxDurationMs, now = Date.now() } = {}) {
      if (!validId(accountId) || !validId(id) || !number(now) || !number(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > BROWSER_CYCLE_LIMIT_MS) return deny('invalid_request');
      if (!capability || capability.version !== BROWSER_CONTROLS_VERSION || !number(capability.maxDurationMs) || capability.maxDurationMs !== maxDurationMs || !number(capability.cleanupAfterMs) || capability.cleanupAfterMs < 1 || capability.cleanupAfterMs > maxDurationMs) return deny('browser_session_lifetime_unbounded');
      let e;
      try { e = await collect({ accountId, subscriptionId, token, fetch: fetcher, listSessions, now }); } catch { return deny('invalid_evidence'); }
      if (!e || e.accountId !== accountId || !number(e.observedAt) || e.observedAt > now || now - e.observedAt > MAX_AGE ||
          !number(e.cycleStart) || !number(e.cycleEnd) || e.cycleStart > now || e.cycleEnd <= now || e.cycleEnd - e.cycleStart < 28 * 86_400_000 || e.cycleEnd - e.cycleStart > 31 * 86_400_000 ||
          !number(e.usageMs) || !number(e.concurrencyUnits) || !number(e.activeSessions) || e.complete !== true) return deny('invalid_evidence');
      try {
        await db.prepare(`INSERT INTO browser_allowance_cycles (account_id, cycle_start, cycle_end, usage_highwater, baseline, cutoff, peak_highwater, peak_baseline, peak_cutoff, observed_at)
          SELECT ?1, ?2, ?3, ?4, MAX(?4, COALESCE((SELECT SUM(actual_ms) FROM browser_allowance_leases WHERE account_id=?1 AND settled_at IS NOT NULL AND launch_started_at IS NOT NULL),0)), COALESCE((SELECT SUM(actual_ms) FROM browser_allowance_leases WHERE account_id=?1 AND settled_at IS NOT NULL AND launch_started_at IS NOT NULL),0), ?5, ?5, COALESCE((SELECT SUM(2 + ((actual_ms + 86399999) / 86400000)) FROM browser_allowance_leases WHERE account_id=?1 AND settled_at IS NOT NULL AND launch_started_at IS NOT NULL),0), ?6 WHERE NOT EXISTS (SELECT 1 FROM browser_allowance_cycles WHERE account_id=?1 AND cycle_start<>?2 AND cycle_start<?3 AND cycle_end>?2)
          ON CONFLICT(account_id, cycle_start) DO UPDATE SET usage_highwater=MAX(usage_highwater, excluded.usage_highwater),
          peak_highwater=MAX(peak_highwater, excluded.peak_highwater), observed_at=MAX(observed_at, excluded.observed_at)
          WHERE cycle_end=excluded.cycle_end`).bind(accountId,e.cycleStart,e.cycleEnd,e.usageMs,e.concurrencyUnits,e.observedAt).run();
        const existing = await db.prepare('SELECT * FROM browser_allowance_leases WHERE account_id=?1 AND id=?2').bind(accountId,id).first();
        if (existing) return existing.duration_ms === maxDurationMs && existing.cycle_start === e.cycleStart ? {accepted:true,duplicate:true} : deny('id_conflict');
        // Single conditional insert serializes all project launches in D1. The
        // first account anchor and local completions form a floor; unresolved
        // holds remain additive, including across billing periods.
        const row = await db.prepare(`INSERT OR IGNORE INTO browser_allowance_leases(account_id,id,cycle_start,duration_ms,created_at)
          SELECT ?1,?2,?3,?4,?5 FROM browser_allowance_cycles c
          WHERE c.account_id=?1 AND c.cycle_start=?3 AND c.cycle_end=?6 AND c.observed_at>=?5-?7 AND c.observed_at<=?5
          AND MAX(c.peak_highwater, c.peak_baseline + COALESCE((SELECT SUM(2 + ((actual_ms + 86399999) / 86400000)) FROM browser_allowance_leases WHERE account_id=?1 AND settled_at IS NOT NULL AND launch_started_at IS NOT NULL),0) - c.peak_cutoff) + 28 <= ?8
          AND NOT EXISTS (SELECT 1 FROM browser_allowance_leases WHERE account_id=?1 AND settled_at IS NULL)
          AND MAX(c.usage_highwater, c.baseline + COALESCE((SELECT SUM(actual_ms) FROM browser_allowance_leases WHERE account_id=?1 AND settled_at IS NOT NULL AND launch_started_at IS NOT NULL),0) - c.cutoff) + COALESCE((SELECT SUM(duration_ms) FROM browser_allowance_leases WHERE account_id=?1 AND settled_at IS NULL),0) + ?4 <= ?10
          RETURNING id`).bind(accountId,id,e.cycleStart,maxDurationMs,now,e.cycleEnd,MAX_AGE,28 * BROWSER_CONCURRENCY_LIMIT,e.activeSessions,BROWSER_CYCLE_LIMIT_MS).first();
        if (row) return {accepted:true,duplicate:false};
        const raced = await db.prepare('SELECT * FROM browser_allowance_leases WHERE account_id=?1 AND id=?2').bind(accountId,id).first();
        return raced && raced.duration_ms===maxDurationMs && raced.cycle_start===e.cycleStart ? {accepted:true,duplicate:true} : deny('allowance_exhausted');
      } catch { return deny('invalid_evidence'); }
    },
    async startLaunch({id, now = Date.now()} = {}) {
      if (!validId(id) || !number(now) || capability?.version !== BROWSER_CONTROLS_VERSION || !number(capability.cleanupAfterMs) || capability.cleanupAfterMs < 1) return deny('invalid_request');
      try {
        const row = await db.prepare(`UPDATE browser_allowance_leases SET launch_started_at=?3
          WHERE account_id=?1 AND id=?2 AND launch_started_at IS NULL AND session_id IS NULL
          AND settled_at IS NULL AND created_at<=?3 AND created_at + ?4 > ?3
          AND EXISTS (SELECT 1 FROM browser_allowance_cycles c WHERE c.account_id=?1
            AND c.cycle_start=browser_allowance_leases.cycle_start AND c.cycle_start<=?3 AND c.cycle_end>?3
            AND c.observed_at<=?3 AND c.observed_at>=?3-?5) RETURNING id`).bind(accountId,id,now,capability.cleanupAfterMs,MAX_AGE).first();
        return row ? {accepted:true} : deny('launch_not_available');
      } catch { return deny('launch_not_available'); }
    },
    async cancelUnstarted({id, now = Date.now()} = {}) {
      if (!validId(id) || !number(now)) return deny('invalid_request');
      try {
        const row = await db.prepare(`UPDATE browser_allowance_leases SET actual_ms=0, settled_at=?3
          WHERE account_id=?1 AND id=?2 AND launch_started_at IS NULL AND session_id IS NULL
          AND settled_at IS NULL AND created_at<=?3 RETURNING id`).bind(accountId,id,now).first();
        return row ? {accepted:true} : deny('not_unstarted');
      } catch { return deny('not_unstarted'); }
    },
    async bindSession({id, sessionId} = {}) {
      if (!validId(id) || !validId(sessionId)) return deny('invalid_request');
      try {
        const row = await db.prepare(`UPDATE browser_allowance_leases SET session_id=?3 WHERE account_id=?1 AND id=?2 AND settled_at IS NULL AND launch_started_at IS NOT NULL AND (session_id IS NULL OR session_id=?3) RETURNING id`).bind(accountId,id,sessionId).first();
        return row ? {accepted:true} : deny('unknown_or_conflicting_lease');
      } catch { return deny('unknown_or_conflicting_lease'); }
    },
    async watchdog({now = Date.now(), closeOwnedSession} = {}) {
      if (!number(now) || typeof closeOwnedSession !== 'function' || capability?.version !== BROWSER_CONTROLS_VERSION || !number(capability.cleanupAfterMs) || capability.cleanupAfterMs < 1 || !number(capability.maxDurationMs) || capability.cleanupAfterMs > capability.maxDurationMs) return deny('invalid_request');
      try {
        const leases = await db.prepare('SELECT id, session_id, launch_started_at FROM browser_allowance_leases WHERE account_id=?1 AND settled_at IS NULL AND (session_id IS NOT NULL OR launch_started_at IS NULL) AND created_at + ?3 <= ?2 LIMIT 1').bind(accountId,now,capability.cleanupAfterMs).all();
        for (const lease of leases.results ?? []) {
          if (lease.launch_started_at === null) { await this.cancelUnstarted({id:lease.id,now}); continue; }
          try { await closeOwnedSession(lease.session_id); } catch { /* retain hold until provider confirms closure */ }
          await this.settle({id:lease.id,now});
        }
        return {accepted:true, examined:(leases.results ?? []).length};
      } catch { return deny('watchdog_unavailable'); }
    },
    async settle({id, now = Date.now()} = {}) {
      if (!validId(id) || !number(now)) return deny('invalid_request');
      try {
        const lease = await db.prepare('SELECT * FROM browser_allowance_leases WHERE account_id=?1 AND id=?2').bind(accountId,id).first();
        if (!lease) return deny('unknown_reservation');
        if (lease.settled_at !== null) return {accepted:true,duplicate:true};
        if (!lease.session_id || typeof verifyClosed !== 'function') return deny('unknown_usage');
        const result = await verifyClosed({accountId,sessionId:lease.session_id,now});
        if (!result || result.sessionId !== lease.session_id || result.closed !== true || !number(result.durationMs) || !number(result.observedAt) || result.observedAt>now || now-result.observedAt>MAX_AGE) return deny('unknown_usage');
        const row = await db.prepare('UPDATE browser_allowance_leases SET actual_ms=?3, settled_at=?4 WHERE account_id=?1 AND id=?2 AND settled_at IS NULL RETURNING id').bind(accountId,id,result.durationMs,now).first();
        return row ? {accepted:true,duplicate:false,overrun:result.durationMs>lease.duration_ms} : deny('settlement_race');
      } catch { return deny('unknown_usage'); }
    },
  };
}
