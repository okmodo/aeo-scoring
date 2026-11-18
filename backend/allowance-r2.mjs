import { collectR2Usage } from './analytics-r2.mjs';
import { MAX_EVIDENCE_AGE_MS } from './allowance-policy.mjs';

export const R2_CEILINGS = Object.freeze({r2StorageBytes: 6_000_000_000, r2ClassA: 600_000, r2ClassB: 6_000_000});
const keys = Object.keys(R2_CEILINGS), windowMs = 31 * 86400000;
const deny = reason => ({accepted:false, reason});
const valid = (value, partial = false) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(k => keys.includes(k)) && keys.every(k => partial && value[k] === undefined || Number.isSafeInteger(value[k]) && value[k] >= 0);

// A completed local operation is reconciled with observed account usage using max,
// while unknown outcomes remain additive. Storage holds remain until explicitly settled;
// settled storage is conservatively retained indefinitely, even after object deletion.
export function createR2AllowanceGuard(db, {accountId, token, allocations = R2_CEILINGS} = {}, {collect = collectR2Usage} = {}) {
  let cached;
  return {
    async reserve({id, costs, now = Date.now()} = {}) {
      if (typeof accountId !== 'string' || !accountId || typeof id !== 'string' || !id.trim() || id.length > 200 ||
        !Number.isSafeInteger(now) || now < windowMs || !valid(costs, true) || !keys.some(k => (costs[k] ?? 0) > 0) ||
        !valid(allocations) || keys.some(k => allocations[k] > R2_CEILINGS[k])) return deny('invalid_request');
      try {
        let snapshot = cached;
        if (!snapshot || snapshot.observedAt > now || now - snapshot.observedAt >= MAX_EVIDENCE_AGE_MS) {
          cached = undefined;
          snapshot = await collect({accountId, token, now});
          if (snapshot?.observedAt !== now || !valid(Object.fromEntries(keys.map(k => [k, snapshot[k]])))) throw Error('invalid r2 snapshot');
          cached = snapshot;
        }
        await db.prepare(`INSERT INTO r2_allowance_receipts VALUES (?1,?2,?3,?4,?5)
          ON CONFLICT(account_id) DO UPDATE SET observed_at=excluded.observed_at, storage=excluded.storage,
            class_a=excluded.class_a, class_b=excluded.class_b WHERE r2_allowance_receipts.observed_at <= excluded.observed_at`)
          .bind(accountId, snapshot.observedAt, snapshot.r2StorageBytes, snapshot.r2ClassA, snapshot.r2ClassB).run();
        await db.prepare('INSERT OR IGNORE INTO r2_allowance_anchors SELECT account_id,storage,class_a,class_b FROM r2_allowance_receipts WHERE account_id=?1').bind(accountId).run();
        const s = costs.r2StorageBytes ?? 0, a = costs.r2ClassA ?? 0, b = costs.r2ClassB ?? 0;
        const row = await db.prepare(`INSERT OR IGNORE INTO r2_allowance_reservations(account_id,id,created_at,storage,class_a,class_b)
          SELECT ?1,?2,?3,?4,?5,?6 FROM r2_allowance_receipts e JOIN r2_allowance_anchors anchor ON anchor.account_id=e.account_id
          WHERE e.account_id=?1 AND e.observed_at<=?3 AND e.observed_at>=?7 AND ?9<=?3
          AND MAX(e.storage, anchor.storage + COALESCE((SELECT SUM(storage) FROM r2_allowance_reservations WHERE account_id=?1 AND settled=1),0))
            + COALESCE((SELECT SUM(storage) FROM r2_allowance_reservations WHERE account_id=?1 AND settled=0),0) <= ?8 - ?4
          AND MAX(e.class_a, anchor.class_a + COALESCE((SELECT SUM(class_a) FROM r2_allowance_reservations WHERE account_id=?1 AND settled=1),0))
            + COALESCE((SELECT SUM(class_a) FROM r2_allowance_reservations WHERE account_id=?1 AND settled=0),0) <= ?10 - ?5
          AND MAX(e.class_b, anchor.class_b + COALESCE((SELECT SUM(class_b) FROM r2_allowance_reservations WHERE account_id=?1 AND settled=1),0))
            + COALESCE((SELECT SUM(class_b) FROM r2_allowance_reservations WHERE account_id=?1 AND settled=0),0) <= ?11 - ?6 RETURNING id`)
          .bind(accountId,id,now,s,a,b,now-MAX_EVIDENCE_AGE_MS,allocations.r2StorageBytes,now-windowMs,allocations.r2ClassA,allocations.r2ClassB).first();
        if (row) return {accepted:true,duplicate:false};
        const prior = await db.prepare('SELECT storage,class_a,class_b FROM r2_allowance_reservations WHERE account_id=?1 AND id=?2').bind(accountId,id).first();
        return prior ? (prior.storage === s && prior.class_a === a && prior.class_b === b ? {accepted:true,duplicate:true} : deny('id_conflict')) : deny('allowance_exhausted');
      } catch { return deny('invalid_evidence'); }
    },
    async settle({id} = {}) {
      if (typeof id !== 'string' || !id.trim()) return deny('invalid_request');
      try {
        const row = await db.prepare('UPDATE r2_allowance_reservations SET settled=1 WHERE account_id=?1 AND id=?2 AND settled=0 RETURNING id').bind(accountId,id).first();
        if (row) return {accepted:true,duplicate:false};
        const existing = await db.prepare('SELECT id FROM r2_allowance_reservations WHERE account_id=?1 AND id=?2').bind(accountId,id).first();
        return existing ? {accepted:true,duplicate:true} : deny('unknown_reservation');
      } catch { return deny('invalid_evidence'); }
    },
  };
}
