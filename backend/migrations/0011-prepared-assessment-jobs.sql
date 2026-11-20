CREATE TABLE IF NOT EXISTS prepared_assessment_jobs (
  audit_id TEXT NOT NULL, prepared_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting','running','complete','failed','budget_wait','uncertain')),
  owner TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER, code TEXT, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (audit_id, prepared_hash, policy_version)
);
CREATE INDEX IF NOT EXISTS prepared_assessment_jobs_recovery ON prepared_assessment_jobs(state, retry_at, lease_until);
CREATE INDEX IF NOT EXISTS prepared_assessment_jobs_expiry ON prepared_assessment_jobs(expires_at);
CREATE TABLE IF NOT EXISTS prepared_assessment_checkpoints (
  audit_id TEXT NOT NULL, prepared_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
  checkpoint_key TEXT NOT NULL, input_digest TEXT NOT NULL, owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','completed','failed','uncertain')),
  output_json TEXT, code TEXT, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (audit_id, prepared_hash, policy_version, checkpoint_key)
);
CREATE INDEX IF NOT EXISTS prepared_assessment_checkpoints_expiry ON prepared_assessment_checkpoints(expires_at);
