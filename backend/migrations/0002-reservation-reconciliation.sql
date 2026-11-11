
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

-- One atomic statement replaces all six counters from durable reservation history.
INSERT INTO allowance_pending_v2(account_id, metric, amount)
SELECT r.account_id, 'requests' AS metric, SUM(CASE WHEN s.id IS NULL THEN r.requests ELSE 0 END) AS amount FROM allowance_reservations r LEFT JOIN allowance_settlements_v2 s ON s.account_id = r.account_id AND s.id = r.id GROUP BY r.account_id
UNION ALL
SELECT r.account_id, 'cpuMs' AS metric, SUM(CASE WHEN s.id IS NULL THEN r.cpu_ms ELSE 0 END) AS amount FROM allowance_reservations r LEFT JOIN allowance_settlements_v2 s ON s.account_id = r.account_id AND s.id = r.id GROUP BY r.account_id
UNION ALL
SELECT r.account_id, 'd1Reads' AS metric, SUM(CASE WHEN s.id IS NULL THEN r.d1_reads ELSE 0 END) AS amount FROM allowance_reservations r LEFT JOIN allowance_settlements_v2 s ON s.account_id = r.account_id AND s.id = r.id GROUP BY r.account_id
UNION ALL
SELECT r.account_id, 'd1Writes' AS metric, SUM(CASE WHEN s.id IS NULL THEN r.d1_writes ELSE 0 END) AS amount FROM allowance_reservations r LEFT JOIN allowance_settlements_v2 s ON s.account_id = r.account_id AND s.id = r.id GROUP BY r.account_id
UNION ALL
SELECT r.account_id, 'd1StorageBytes' AS metric, SUM(CASE WHEN s.id IS NULL THEN r.d1_storage_bytes ELSE 0 END) AS amount FROM allowance_reservations r LEFT JOIN allowance_settlements_v2 s ON s.account_id = r.account_id AND s.id = r.id GROUP BY r.account_id
UNION ALL
SELECT r.account_id, 'aiNeurons' AS metric, SUM(CASE WHEN s.id IS NULL THEN r.ai_neurons ELSE 0 END) AS amount FROM allowance_reservations r LEFT JOIN allowance_settlements_v2 s ON s.account_id = r.account_id AND s.id = r.id GROUP BY r.account_id
ON CONFLICT(account_id, metric) DO UPDATE SET amount = excluded.amount;
INSERT OR IGNORE INTO allowance_migrations_v2 VALUES ('bootstrap');
