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

-- Reservations are consumed even if inference fails; budget resets by UTC day.
CREATE TABLE IF NOT EXISTS semantic_budget (
  day INTEGER PRIMARY KEY,
  reserved_neurons INTEGER NOT NULL CHECK (reserved_neurons >= 0 AND reserved_neurons <= 8000)
);
