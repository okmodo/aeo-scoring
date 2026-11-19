import { collectQuickActionUsage } from './quick-action-usage.mjs';
import { BROWSER_CYCLE_LIMIT_MS } from './browser-usage.mjs';

export const QUICK_ACTION_HOLD_MS = 3_720_000;
const MAX_AGE = 300_000;
const valid = n => Number.isSafeInteger(n) && n >= 0;
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
const deny = reason => ({accepted:false,reason});
const total = `(COALESCE((SELECT SUM(actual_ms) FROM quick_action_allowance_leases WHERE account_id=?1 AND settled_at IS NOT NULL AND started_at IS NOT NULL),0) + COALESCE((SELECT SUM(actual_ms) FROM browser_allowance_leases WHERE account_id=?1 AND settled_at IS NOT NULL AND launch_started_at IS NOT NULL),0))`;

export function createQuickActionAllowanceGuard(db, {accountId, subscriptionId, token, fetch: fetcher, collect = collectQuickActionUsage, clock = Date.now} = {}) {
  return {
    async reserve({id,maxDurationMs,now = clock()} = {}) {
      if (!validId(accountId) || !validId(id) || !valid(now) || maxDurationMs !== QUICK_ACTION_HOLD_MS) return deny('invalid_request');
      let e; try { e = await collect({accountId,subscriptionId,token,fetch:fetcher,now}); } catch { return deny('invalid_evidence'); }
      if (!e || e.accountId !== accountId || !valid(e.observedAt) || e.observedAt > now || now-e.observedAt > MAX_AGE || !valid(e.cycleStart) || !valid(e.cycleEnd) || e.cycleStart > now || e.cycleEnd <= now || e.cycleEnd-e.cycleStart < 28*86_400_000 || e.cycleEnd-e.cycleStart > 31*86_400_000 || !valid(e.usageMs) || e.complete !== true) return deny('invalid_evidence');
      try {
        await db.prepare(`INSERT INTO quick_action_allowance_cycles(account_id,cycle_start,cycle_end,usage_highwater,baseline,cutoff,observed_at)
          SELECT ?1,?2,?3,?4,MAX(?4,${total}),${total},?5 WHERE NOT EXISTS (SELECT 1 FROM quick_action_allowance_cycles WHERE account_id=?1 AND cycle_start<>?2 AND cycle_start<?3 AND cycle_end>?2)
          ON CONFLICT(account_id,cycle_start) DO UPDATE SET usage_highwater=MAX(usage_highwater,excluded.usage_highwater),observed_at=MAX(observed_at,excluded.observed_at) WHERE cycle_end=excluded.cycle_end`).bind(accountId,e.cycleStart,e.cycleEnd,e.usageMs,e.observedAt).run();
        const existing = await db.prepare('SELECT * FROM quick_action_allowance_leases WHERE account_id=?1 AND id=?2').bind(accountId,id).first();
        if (existing) return existing.duration_ms === maxDurationMs && existing.cycle_start === e.cycleStart ? {accepted:true,duplicate:true} : deny('id_conflict');
        const row = await db.prepare(`INSERT OR IGNORE INTO quick_action_allowance_leases(account_id,id,cycle_start,duration_ms,created_at)
          SELECT ?1,?2,?3,?4,?5 FROM quick_action_allowance_cycles c WHERE c.account_id=?1 AND c.cycle_start=?3 AND c.cycle_end=?6 AND c.observed_at BETWEEN ?5-?7 AND ?5
          AND NOT EXISTS (SELECT 1 FROM quick_action_allowance_leases WHERE account_id=?1 AND settled_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM browser_allowance_leases WHERE account_id=?1 AND settled_at IS NULL)
          AND MAX(c.usage_highwater,c.baseline + ${total} - c.cutoff) + ?4 <= ?8 RETURNING id`).bind(accountId,id,e.cycleStart,maxDurationMs,now,e.cycleEnd,MAX_AGE,BROWSER_CYCLE_LIMIT_MS).first();
        if (row) return {accepted:true,duplicate:false};
        const raced = await db.prepare('SELECT * FROM quick_action_allowance_leases WHERE account_id=?1 AND id=?2').bind(accountId,id).first();
        return raced && raced.duration_ms === maxDurationMs && raced.cycle_start === e.cycleStart ? {accepted:true,duplicate:true} : deny('allowance_exhausted');
      } catch { return deny('invalid_evidence'); }
    },
    async start({id,now = clock()} = {}) {
      if (!validId(id) || !valid(now)) return deny('invalid_request');
      try { const row = await db.prepare(`UPDATE quick_action_allowance_leases SET started_at=?3 WHERE account_id=?1 AND id=?2 AND started_at IS NULL AND settled_at IS NULL AND created_at<=?3 AND created_at+?4>?3 AND EXISTS (SELECT 1 FROM quick_action_allowance_cycles c WHERE c.account_id=?1 AND c.cycle_start=quick_action_allowance_leases.cycle_start AND c.cycle_start<=?3 AND c.cycle_end>?3 AND c.observed_at BETWEEN ?3-?4 AND ?3) RETURNING id`).bind(accountId,id,now,MAX_AGE).first(); return row ? {accepted:true} : deny('start_not_available'); } catch { return deny('start_not_available'); }
    },
    async cancelUnstarted({id,now = clock()} = {}) {
      if (!validId(id) || !valid(now)) return deny('invalid_request');
      try { const row = await db.prepare('UPDATE quick_action_allowance_leases SET actual_ms=0,settled_at=?3 WHERE account_id=?1 AND id=?2 AND started_at IS NULL AND settled_at IS NULL AND created_at<=?3 RETURNING id').bind(accountId,id,now).first(); return row ? {accepted:true} : deny('not_unstarted'); } catch { return deny('not_unstarted'); }
    },
    async settle({id,response,now = clock()} = {}) {
      if (!validId(id) || !valid(now)) return deny('invalid_request');
      try {
        const lease = await db.prepare('SELECT * FROM quick_action_allowance_leases WHERE account_id=?1 AND id=?2').bind(accountId,id).first();
        if (!lease) return deny('unknown_reservation');
        if (lease.settled_at !== null) return {accepted:true,duplicate:true};
        if (lease.started_at === null || now < lease.started_at || !(response instanceof Response)) return deny('unknown_usage');
        const value = response.headers.get('X-Browser-Ms-Used');
        if (typeof value !== 'string' || !/^(?:\d+)(?:\.\d+)?$/.test(value)) return deny('unknown_usage');
        const actual = Math.ceil(Number(value)); if (!valid(actual)) return deny('unknown_usage');
        const row = await db.prepare('UPDATE quick_action_allowance_leases SET actual_ms=?3,settled_at=?4 WHERE account_id=?1 AND id=?2 AND started_at IS NOT NULL AND settled_at IS NULL RETURNING id').bind(accountId,id,actual,now).first();
        return row ? {accepted:true,duplicate:false,overrun:actual>lease.duration_ms} : deny('settlement_race');
      } catch { return deny('unknown_usage'); }
    },
  };
}
