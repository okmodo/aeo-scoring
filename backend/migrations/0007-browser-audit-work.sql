ALTER TABLE audits ADD COLUMN lease_ms INTEGER NOT NULL DEFAULT 60000;
CREATE TABLE IF NOT EXISTS browser_audit_work (
  audit_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('capturing','ready','assessing','finished')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_audit_work_expiry ON browser_audit_work(expires_at);
