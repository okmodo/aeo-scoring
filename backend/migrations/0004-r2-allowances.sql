CREATE TABLE IF NOT EXISTS r2_allowance_receipts (
  account_id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, storage INTEGER NOT NULL,
  class_a INTEGER NOT NULL, class_b INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS r2_allowance_reservations (
  account_id TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL,
  storage INTEGER NOT NULL, class_a INTEGER NOT NULL, class_b INTEGER NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id, id)
);
CREATE TABLE IF NOT EXISTS r2_allowance_anchors (
  account_id TEXT PRIMARY KEY, storage INTEGER NOT NULL, class_a INTEGER NOT NULL, class_b INTEGER NOT NULL
);
