// Private diagnostics contain codes and timings, never downloaded content or errors.
export const PIPELINE_VERSION = 'retained-ai-1';
const STAGES = new Set(['retrieval', 'snapshot', 'category', 'content', 'scoring']);
const STATUSES = new Set(['running', 'completed', 'failed', 'skipped']);
export function createPipelineState({ db, auditId, now = Date.now }) {
  const stages = [];
  return {
    async load() {
      if (!db) return;
      const row = await db.prepare('SELECT version,state_json FROM audit_pipeline_state WHERE audit_id=?1').bind(auditId).first();
      if (!row) return;
      const stored = JSON.parse(row.state_json);
      if (row.version !== PIPELINE_VERSION || !Array.isArray(stored) || stored.length > 12 || stored.some(s => !STAGES.has(s.stage) || !STATUSES.has(s.status) || !/^[a-z][a-z0-9_]{0,63}$/.test(s.code) || !Number.isSafeInteger(s.at))) throw new Error('Invalid retained pipeline state');
      stages.push(...stored);
    },
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
