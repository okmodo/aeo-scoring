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


-- Reconciliation is additive: v1 counters and reservation rows remain intact.
CREATE TABLE IF NOT EXISTS allowance_pending_v2 (
  account_id TEXT NOT NULL, metric TEXT NOT NULL, amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount >= 0 AND amount <= 9007199254740991),
  PRIMARY KEY(account_id, metric)
);
CREATE TABLE IF NOT EXISTS allowance_settled_v2 (
  account_id TEXT NOT NULL, metric TEXT NOT NULL, period TEXT NOT NULL, amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount >= 0 AND amount <= 9007199254740991),
  PRIMARY KEY(account_id, metric, period)
);
CREATE TABLE IF NOT EXISTS allowance_anchors_v2 (
  account_id TEXT NOT NULL, metric TEXT NOT NULL, period TEXT NOT NULL,
  baseline INTEGER NOT NULL CHECK (typeof(baseline) = 'integer' AND baseline >= 0 AND baseline <= 9007199254740991), cutoff INTEGER NOT NULL CHECK (typeof(cutoff) = 'integer' AND cutoff >= 0 AND cutoff <= 9007199254740991),
  PRIMARY KEY(account_id, metric, period)
);
CREATE TABLE IF NOT EXISTS allowance_settlements_v2 (
  account_id TEXT NOT NULL, id TEXT NOT NULL, actual_ai INTEGER NOT NULL CHECK (typeof(actual_ai) = 'integer' AND actual_ai >= 0 AND actual_ai <= 9007199254740991), completed_at INTEGER NOT NULL CHECK (typeof(completed_at) = 'integer' AND completed_at >= 0 AND completed_at <= 9007199254740991),
  completion_cycle TEXT NOT NULL, completion_day TEXT NOT NULL,
  PRIMARY KEY(account_id, id)
);
CREATE TABLE IF NOT EXISTS allowance_migrations_v2 (name TEXT PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS allowance_pending_v2_insert AFTER INSERT ON allowance_reservations BEGIN
  INSERT INTO allowance_pending_v2 VALUES (NEW.account_id, 'requests', NEW.requests) ON CONFLICT(account_id, metric) DO UPDATE SET amount = amount + NEW.requests;
  INSERT INTO allowance_pending_v2 VALUES (NEW.account_id, 'cpuMs', NEW.cpu_ms) ON CONFLICT(account_id, metric) DO UPDATE SET amount = amount + NEW.cpu_ms;
  INSERT INTO allowance_pending_v2 VALUES (NEW.account_id, 'd1Reads', NEW.d1_reads) ON CONFLICT(account_id, metric) DO UPDATE SET amount = amount + NEW.d1_reads;
  INSERT INTO allowance_pending_v2 VALUES (NEW.account_id, 'd1Writes', NEW.d1_writes) ON CONFLICT(account_id, metric) DO UPDATE SET amount = amount + NEW.d1_writes;
  INSERT INTO allowance_pending_v2 VALUES (NEW.account_id, 'd1StorageBytes', NEW.d1_storage_bytes) ON CONFLICT(account_id, metric) DO UPDATE SET amount = amount + NEW.d1_storage_bytes;
  INSERT INTO allowance_pending_v2 VALUES (NEW.account_id, 'aiNeurons', NEW.ai_neurons) ON CONFLICT(account_id, metric) DO UPDATE SET amount = amount + NEW.ai_neurons;
END;
-- Raw settlement writes must preserve the same ledger invariants as the API.
CREATE TRIGGER IF NOT EXISTS allowance_settlement_v2_guard BEFORE INSERT ON allowance_settlements_v2 BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id
    AND NEW.completed_at >= r.cycle_start AND date(NEW.completed_at / 1000, 'unixepoch') = NEW.completion_day
    AND r.ai_day IN (NEW.completion_day, date(NEW.completion_day, '-1 day'))
    AND (CAST(r.cycle_start AS TEXT) = NEW.completion_cycle OR EXISTS (SELECT 1 FROM allowance_cycles c
      WHERE c.account_id = r.account_id AND c.cycle_start = r.cycle_start AND CAST(c.cycle_end AS TEXT) = NEW.completion_cycle)))
    OR NOT EXISTS (SELECT 1 FROM allowance_pending_v2 p JOIN allowance_reservations r ON r.account_id = p.account_id WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND p.metric = 'requests' AND p.amount >= r.requests AND r.requests >= 0 AND typeof(r.requests) = 'integer') OR
    NOT EXISTS (SELECT 1 FROM allowance_pending_v2 p JOIN allowance_reservations r ON r.account_id = p.account_id WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND p.metric = 'cpuMs' AND p.amount >= r.cpu_ms AND r.cpu_ms >= 0 AND typeof(r.cpu_ms) = 'integer') OR
    NOT EXISTS (SELECT 1 FROM allowance_pending_v2 p JOIN allowance_reservations r ON r.account_id = p.account_id WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND p.metric = 'd1Reads' AND p.amount >= r.d1_reads AND r.d1_reads >= 0 AND typeof(r.d1_reads) = 'integer') OR
    NOT EXISTS (SELECT 1 FROM allowance_pending_v2 p JOIN allowance_reservations r ON r.account_id = p.account_id WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND p.metric = 'd1Writes' AND p.amount >= r.d1_writes AND r.d1_writes >= 0 AND typeof(r.d1_writes) = 'integer') OR
    NOT EXISTS (SELECT 1 FROM allowance_pending_v2 p JOIN allowance_reservations r ON r.account_id = p.account_id WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND p.metric = 'd1StorageBytes' AND p.amount >= r.d1_storage_bytes AND r.d1_storage_bytes >= 0 AND typeof(r.d1_storage_bytes) = 'integer') OR
    NOT EXISTS (SELECT 1 FROM allowance_pending_v2 p JOIN allowance_reservations r ON r.account_id = p.account_id WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND p.metric = 'aiNeurons' AND p.amount >= r.ai_neurons AND r.ai_neurons >= 0 AND typeof(r.ai_neurons) = 'integer')
    THEN RAISE(ABORT, 'invalid settlement') END;
END;
CREATE TRIGGER IF NOT EXISTS allowance_settlement_v2_insert AFTER INSERT ON allowance_settlements_v2 BEGIN
  UPDATE allowance_pending_v2 SET amount = amount - (SELECT requests FROM allowance_reservations WHERE account_id = NEW.account_id AND id = NEW.id) WHERE account_id = NEW.account_id AND metric = 'requests';
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'requests', CAST(r.cycle_start AS TEXT), r.requests FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'requests', NEW.completion_cycle, r.requests FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND NEW.completion_cycle <> CAST(r.cycle_start AS TEXT) ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
  UPDATE allowance_pending_v2 SET amount = amount - (SELECT cpu_ms FROM allowance_reservations WHERE account_id = NEW.account_id AND id = NEW.id) WHERE account_id = NEW.account_id AND metric = 'cpuMs';
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'cpuMs', CAST(r.cycle_start AS TEXT), r.cpu_ms FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'cpuMs', NEW.completion_cycle, r.cpu_ms FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND NEW.completion_cycle <> CAST(r.cycle_start AS TEXT) ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
  UPDATE allowance_pending_v2 SET amount = amount - (SELECT d1_reads FROM allowance_reservations WHERE account_id = NEW.account_id AND id = NEW.id) WHERE account_id = NEW.account_id AND metric = 'd1Reads';
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'd1Reads', CAST(r.cycle_start AS TEXT), r.d1_reads FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'd1Reads', NEW.completion_cycle, r.d1_reads FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND NEW.completion_cycle <> CAST(r.cycle_start AS TEXT) ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
  UPDATE allowance_pending_v2 SET amount = amount - (SELECT d1_writes FROM allowance_reservations WHERE account_id = NEW.account_id AND id = NEW.id) WHERE account_id = NEW.account_id AND metric = 'd1Writes';
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'd1Writes', CAST(r.cycle_start AS TEXT), r.d1_writes FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'd1Writes', NEW.completion_cycle, r.d1_writes FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND NEW.completion_cycle <> CAST(r.cycle_start AS TEXT) ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
  UPDATE allowance_pending_v2 SET amount = amount - (SELECT d1_storage_bytes FROM allowance_reservations WHERE account_id = NEW.account_id AND id = NEW.id) WHERE account_id = NEW.account_id AND metric = 'd1StorageBytes';
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'd1StorageBytes', 'stock', r.d1_storage_bytes FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'd1StorageBytes', 'stock', r.d1_storage_bytes FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND 'stock' <> 'stock' ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
  UPDATE allowance_pending_v2 SET amount = amount - (SELECT ai_neurons FROM allowance_reservations WHERE account_id = NEW.account_id AND id = NEW.id) WHERE account_id = NEW.account_id AND metric = 'aiNeurons';
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'aiNeurons', r.ai_day, NEW.actual_ai FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
  INSERT INTO allowance_settled_v2 SELECT NEW.account_id, 'aiNeurons', NEW.completion_day, NEW.actual_ai FROM allowance_reservations r WHERE r.account_id = NEW.account_id AND r.id = NEW.id AND NEW.completion_day <> r.ai_day ON CONFLICT(account_id, metric, period) DO UPDATE SET amount = amount + excluded.amount;
END;
