CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  assessed_url TEXT,
  cache_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'incomplete', 'unable_to_assess')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  cache_until INTEGER,
  report_json TEXT,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS audits_cache ON audits(cache_key, status, cache_until);
CREATE INDEX IF NOT EXISTS audits_expiry ON audits(expires_at);
CREATE TABLE IF NOT EXISTS audit_admissions (
  id TEXT PRIMARY KEY,
  rate_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admissions_rate_window ON audit_admissions(rate_key, created_at);
CREATE INDEX IF NOT EXISTS admissions_global_window ON audit_admissions(created_at);

-- Historical daily-only reservations. Kept for compatibility; no longer grants
-- permission to call inference. New calls require the account allowance ledger.
CREATE TABLE IF NOT EXISTS semantic_budget (
  day INTEGER PRIMARY KEY,
  reserved_neurons INTEGER NOT NULL CHECK (reserved_neurons >= 0 AND reserved_neurons <= 8000)
);

-- Account-wide evidence and conservative reservations protect the included allowance.
CREATE TABLE IF NOT EXISTS allowance_cycles (
  account_id TEXT NOT NULL,
  cycle_start INTEGER NOT NULL,
  cycle_end INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  allocations_json TEXT NOT NULL,
  PRIMARY KEY (account_id, cycle_start)
);
CREATE TABLE IF NOT EXISTS allowance_reservations (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  cycle_start INTEGER NOT NULL,
  ai_day TEXT NOT NULL,
  costs_json TEXT NOT NULL,
  requests INTEGER NOT NULL,
  cpu_ms INTEGER NOT NULL,
  d1_reads INTEGER NOT NULL,
  d1_writes INTEGER NOT NULL,
  d1_storage_bytes INTEGER NOT NULL,
  ai_neurons INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS allowance_cycle_usage ON allowance_reservations(account_id, cycle_start);
CREATE INDEX IF NOT EXISTS allowance_daily_usage ON allowance_reservations(account_id, ai_day);

-- The trigger advances fixed-size counters in the same transaction as admission.
CREATE TABLE IF NOT EXISTS allowance_totals (
  account_id TEXT NOT NULL, cycle_start INTEGER NOT NULL,
  requests INTEGER NOT NULL, cpu_ms INTEGER NOT NULL,
  d1_reads INTEGER NOT NULL, d1_writes INTEGER NOT NULL,
  PRIMARY KEY (account_id, cycle_start)
);
CREATE TABLE IF NOT EXISTS allowance_days (
  account_id TEXT NOT NULL, ai_day TEXT NOT NULL, ai_neurons INTEGER NOT NULL,
  PRIMARY KEY (account_id, ai_day)
);
CREATE TABLE IF NOT EXISTS allowance_storage (
  account_id TEXT PRIMARY KEY, d1_storage_bytes INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS allowance_record_totals AFTER INSERT ON allowance_reservations BEGIN
  INSERT INTO allowance_totals VALUES (NEW.account_id, NEW.cycle_start, NEW.requests, NEW.cpu_ms, NEW.d1_reads, NEW.d1_writes)
  ON CONFLICT(account_id, cycle_start) DO UPDATE SET
    requests = requests + NEW.requests, cpu_ms = cpu_ms + NEW.cpu_ms,
    d1_reads = d1_reads + NEW.d1_reads, d1_writes = d1_writes + NEW.d1_writes;
  INSERT INTO allowance_days VALUES (NEW.account_id, NEW.ai_day, NEW.ai_neurons)
  ON CONFLICT(account_id, ai_day) DO UPDATE SET ai_neurons = ai_neurons + NEW.ai_neurons;
  INSERT INTO allowance_storage VALUES (NEW.account_id, NEW.d1_storage_bytes)
  ON CONFLICT(account_id) DO UPDATE SET d1_storage_bytes = d1_storage_bytes + NEW.d1_storage_bytes;
END;

-- Latest collection attempt invalidates admission before any network request. The
-- retained baseline is minimal and never contains raw provider billing payloads.
CREATE TABLE IF NOT EXISTS allowance_receipts (
  account_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, active INTEGER NOT NULL,
  subscription_id TEXT, cycle_start INTEGER, cycle_end INTEGER, ai_day TEXT,
  observed_at INTEGER, usage_json TEXT, watermarks_json TEXT, diagnostic_status TEXT, diagnostic_highwater_json TEXT, baseline_json TEXT
);
