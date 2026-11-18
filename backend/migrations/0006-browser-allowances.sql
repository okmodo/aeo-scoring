CREATE TABLE IF NOT EXISTS browser_allowance_cycles (
  account_id TEXT NOT NULL, cycle_start INTEGER NOT NULL, cycle_end INTEGER NOT NULL,
  usage_highwater INTEGER NOT NULL, baseline INTEGER NOT NULL, cutoff INTEGER NOT NULL, peak_highwater INTEGER NOT NULL, peak_baseline INTEGER NOT NULL, peak_cutoff INTEGER NOT NULL, observed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, cycle_start)
);
CREATE TABLE IF NOT EXISTS browser_allowance_leases (
  account_id TEXT NOT NULL, id TEXT NOT NULL, cycle_start INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL, launch_started_at INTEGER, session_id TEXT,
  actual_ms INTEGER, settled_at INTEGER, PRIMARY KEY (account_id, id),
  UNIQUE (account_id, session_id)
);
CREATE INDEX IF NOT EXISTS browser_allowance_pending ON browser_allowance_leases(account_id, settled_at);
