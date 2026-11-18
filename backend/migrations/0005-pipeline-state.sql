CREATE TABLE IF NOT EXISTS audit_pipeline_state (
  audit_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_pipeline_expiry ON audit_pipeline_state(expires_at);
