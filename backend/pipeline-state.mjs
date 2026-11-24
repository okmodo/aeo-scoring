// Private diagnostics contain codes and timings, never downloaded content or errors.
export const PIPELINE_VERSION = 'retained-ai-1';
const STAGES = new Set(['retrieval', 'snapshot', 'preparation', 'category', 'content', 'scoring']);
const STATUSES = new Set(['running', 'completed', 'failed', 'skipped']);
export function createPipelineState({ db, auditId, now = Date.now }) {
  const stages = [];
  return {
    async load() {
      if (!db) return;
      const row = await db.prepare('SELECT version,state_json FROM audit_pipeline_state WHERE audit_id=?1').bind(auditId).first();
      if (!row) return;
      const stored = JSON.parse(row.state_json);
      if (row.version !== PIPELINE_VERSION || !Array.isArray(stored) || stored.length > 16 || stored.some(s => !STAGES.has(s.stage) || !STATUSES.has(s.status) || !/^[a-z][a-z0-9_]{0,63}$/.test(s.code) || !Number.isSafeInteger(s.at))) throw new Error('Invalid retained pipeline state');
      stages.push(...stored);
    },
    async record(stage, status, code, guard) {
      if (!STAGES.has(stage) || !STATUSES.has(status) || !/^[a-z][a-z0-9_]{0,63}$/.test(code)) throw new TypeError('Invalid pipeline diagnostic');
      const at = now();
      if (!Number.isSafeInteger(at) || stages.length >= 16) throw new TypeError('Invalid pipeline history');
      const next = [...stages, { stage, status, code, at }];
      if (db && guard) {
        const result = await db.prepare(`INSERT INTO audit_pipeline_state (audit_id, version, state_json, updated_at, expires_at)
          SELECT ?1,?2,?3,?4,?5 WHERE EXISTS (SELECT 1 FROM audit_queue_jobs q WHERE q.audit_id=?1 AND q.owner=?6 AND q.sequence=?7 AND q.state=?8 AND q.lease_until>?4)
          ON CONFLICT(audit_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at
          WHERE audit_pipeline_state.version=?2 AND audit_pipeline_state.state_json=?9`)
          .bind(auditId,PIPELINE_VERSION,JSON.stringify(next),at,at+86_400_000,guard.owner,guard.sequence,guard.state,JSON.stringify(stages)).run();
        if (result.meta.changes!==1) return;
      } else if (db) await db.prepare(`INSERT INTO audit_pipeline_state (audit_id, version, state_json, updated_at, expires_at)
        VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(audit_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
        .bind(auditId, PIPELINE_VERSION, JSON.stringify(next), at, at + 86_400_000).run();
      stages.push(next.at(-1));
    },
    summary() { return { version: PIPELINE_VERSION, stages: stages.map(item => ({ ...item })) }; },
  };
}
