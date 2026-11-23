ALTER TABLE audits ADD COLUMN checks_completed_at INTEGER;
CREATE TABLE IF NOT EXISTS audit_result_outbox (
  audit_id TEXT PRIMARY KEY REFERENCES audits(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('complete','incomplete')),
  report_json TEXT NOT NULL CHECK(json_valid(report_json)), assessed_url TEXT NOT NULL,
  checks_completed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, write_token TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_check_results (
  audit_id TEXT NOT NULL REFERENCES audit_result_outbox(audit_id) ON DELETE CASCADE,
  component_id TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  PRIMARY KEY(audit_id,component_id)
);
CREATE INDEX IF NOT EXISTS audit_result_outbox_expiry ON audit_result_outbox(expires_at);
