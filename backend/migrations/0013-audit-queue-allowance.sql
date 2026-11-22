-- Analytics are estimated; reservations deliberately overlap the account total.
CREATE TABLE IF NOT EXISTS audit_queue_receipts (
  account_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL,
  cycle_start INTEGER NOT NULL, cycle_end INTEGER NOT NULL,
  observed_at INTEGER NOT NULL, operations INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_queue_reservations (
  account_id TEXT NOT NULL, day_start INTEGER NOT NULL,
  operations INTEGER NOT NULL CHECK (operations > 0),
  PRIMARY KEY (account_id, day_start)
);
