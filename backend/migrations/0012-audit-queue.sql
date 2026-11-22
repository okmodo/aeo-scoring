CREATE TABLE IF NOT EXISTS audit_queue_jobs (
  audit_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK (phase IN ('capture','prepare','assess')),
  sequence INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('staged','dispatching','waiting','running','terminalizing','complete')),
  owner TEXT, lease_until INTEGER, code TEXT,
  updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_queue_expiry ON audit_queue_jobs(expires_at);
