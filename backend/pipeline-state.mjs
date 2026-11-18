// Private diagnostics contain codes and timings, never downloaded content or errors.
export const PIPELINE_VERSION = 'retained-ai-1';
const STAGES = new Set(['retrieval', 'snapshot', 'category', 'content', 'scoring']);
const STATUSES = new Set(['running', 'completed', 'failed', 'skipped']);
export function createPipelineState({ db, auditId, now = Date.now }) {
  const stages = [];
  return {
    async record(stage, status, code) {
      if (!STAGES.has(stage) || !STATUSES.has(status) || !/^[a-z][a-z0-9_]{0,63}$/.test(code)) throw new TypeError('Invalid pipeline diagnostic');
      const at = now();
      if (!Number.isSafeInteger(at) || stages.length >= 12) throw new TypeError('Invalid pipeline history');
      stages.push({ stage, status, code, at });
      if (db) await db.prepare(`INSERT INTO audit_pipeline_state (audit_id, version, state_json, updated_at, expires_at)
        VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(audit_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
        .bind(auditId, PIPELINE_VERSION, JSON.stringify(stages), at, at + 86_400_000).run();
    },
    summary() { return { version: PIPELINE_VERSION, stages: stages.map(item => ({ ...item })) }; },
  };
}
