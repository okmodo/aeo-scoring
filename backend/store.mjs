// A D1 batch is transactional; the quota check and admission commit together.
const ADMIT = `INSERT INTO audit_admissions (id, rate_key, created_at)
SELECT ?1, ?2, ?3
WHERE (SELECT COUNT(*) FROM audit_admissions WHERE rate_key = ?2 AND created_at >= ?4 AND created_at < ?5) < ?6
  AND (SELECT COUNT(*) FROM audit_admissions WHERE created_at >= ?4 AND created_at < ?5) < ?7`;
const CACHE = `SELECT * FROM audits WHERE cache_key = ?1 AND status IN ('complete', 'incomplete')
  AND cache_until > ?2 AND expires_at >= ?2 AND report_json IS NOT NULL
  ORDER BY completed_at DESC LIMIT 1`;
const LEASE_MS = 60_000;

function audit(row, now) {
  if (!row) return null;
  const stale = row.status === 'pending' && now >= row.created_at + LEASE_MS;
  return {
    id: row.id, url: row.url, assessedUrl: row.assessed_url, status: stale ? 'unable_to_assess' : row.status, createdAt: row.created_at,
    expiresAt: row.expires_at, completedAt: row.completed_at, cacheUntil: row.cache_until,
    report: row.report_json === null ? null : JSON.parse(row.report_json),
    error: stale ? 'assessment_timeout' : row.error_json === null ? null : JSON.parse(row.error_json),
  };
}

export function createStore(db) {
  return {
    async reserve({ id, url, cacheKey, rateKey, now, expiresAt, windowStart, windowEnd, limit, globalLimit }) {
      if (![now, expiresAt, windowStart, windowEnd, limit, globalLimit].every(Number.isSafeInteger) ||
          !id || !url || !cacheKey || !rateKey || expiresAt <= now || windowStart !== Math.floor(now / 3_600_000) * 3_600_000 || windowEnd !== windowStart + 3_600_000 || limit < 1 || globalLimit < 1) {
        throw new TypeError('Invalid reservation');
      }
      const results = await db.batch([
        db.prepare(ADMIT).bind(id, rateKey, now, windowStart, windowEnd, limit, globalLimit),
        db.prepare(`INSERT INTO audits (id, url, cache_key, status, created_at, expires_at)
          SELECT ?1, ?2, ?3, 'pending', ?4, ?5
          WHERE EXISTS (SELECT 1 FROM audit_admissions WHERE id = ?1)
          AND NOT EXISTS (SELECT 1 FROM audits WHERE cache_key = ?3 AND status IN ('complete', 'incomplete')
            AND cache_until > ?4 AND expires_at >= ?4 AND report_json IS NOT NULL)`)
          .bind(id, url, cacheKey, now, expiresAt),
        db.prepare('SELECT * FROM audits WHERE id = ?1').bind(id),
        db.prepare(CACHE).bind(cacheKey, now),
      ]);
      if (results[0].meta.changes === 0) return { kind: 'limited', retryAfter: Math.max(1, Math.ceil((windowEnd - now) / 1000)) };
      const created = results[2].results[0];
      return created ? { kind: 'created', audit: audit(created, now) } :
        { kind: 'cached', audit: audit(results[3].results[0], now) };
    },
    async reserveSemantic({ day, neurons }) {
      if (!Number.isSafeInteger(day) || day < 0 || !Number.isSafeInteger(neurons) || neurons < 1 || neurons > 8000) throw new TypeError('Invalid semantic reservation');
      const result = await db.prepare(`INSERT INTO semantic_budget (day, reserved_neurons) VALUES (?1, ?2)
        ON CONFLICT(day) DO UPDATE SET reserved_neurons = semantic_budget.reserved_neurons + excluded.reserved_neurons
        WHERE semantic_budget.reserved_neurons + excluded.reserved_neurons <= 8000`).bind(day, neurons).run();
      return result.meta.changes === 1;
    },
    async get(id, now) {
      const row = await db.prepare('SELECT * FROM audits WHERE id = ?1 AND expires_at >= ?2').bind(id, now).first();
      return audit(row, now);
    },
    async finish(id, { status, report = null, error = null, completedAt, cacheUntil = null, assessedUrl = null }) {
      if (!['complete', 'incomplete', 'unable_to_assess'].includes(status) || !Number.isSafeInteger(completedAt) ||
          (status !== 'unable_to_assess' && (report === null || !Number.isSafeInteger(cacheUntil) || cacheUntil <= completedAt)) ||
          (assessedUrl !== null && typeof assessedUrl !== 'string') ||
          (status === 'unable_to_assess' && report !== null)) throw new TypeError('Invalid completion');
      const result = await db.prepare(`UPDATE audits SET status = ?2, report_json = ?3, error_json = ?4,
        completed_at = ?5, cache_until = ?6, assessed_url = ?8 WHERE id = ?1 AND status = 'pending'
        AND expires_at >= ?5 AND created_at <= ?5 AND created_at + ?7 > ?5`)
        .bind(id, status, report === null ? null : JSON.stringify(report), error === null ? null : JSON.stringify(error),
          completedAt, status !== 'unable_to_assess' ? cacheUntil : null, LEASE_MS, assessedUrl).run();
      return result.meta.changes === 1;
    },
    async prune({ now, admissionBefore, limit = 100 }) {
      if (![now, admissionBefore, limit].every(Number.isSafeInteger) || admissionBefore > Math.floor(now / 3_600_000) * 3_600_000 || limit < 1 || limit > 1000) throw new TypeError('Invalid pruning');
      return db.batch([
        db.prepare('DELETE FROM semantic_budget WHERE day < ?1').bind(Math.floor(now / 86_400_000) - 2),
        db.prepare('DELETE FROM audits WHERE id IN (SELECT id FROM audits WHERE expires_at < ?1 LIMIT ?2)').bind(now, limit),
        db.prepare('DELETE FROM audit_admissions WHERE id IN (SELECT id FROM audit_admissions WHERE created_at < ?1 LIMIT ?2)').bind(admissionBefore, limit),
      ]);
    },
  };
}
