-- A pending reference is inserted before either object, so partial writes remain discoverable.
CREATE TABLE IF NOT EXISTS retained_snapshots (
  audit_id TEXT PRIMARY KEY,
  object_prefix TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready')),
  html_size INTEGER, html_hash TEXT, snapshot_size INTEGER, snapshot_hash TEXT,
  profile_state TEXT CHECK (profile_state IS NULL OR profile_state IN ('pending', 'ready')),
  profile_size INTEGER, profile_hash TEXT,
  facts_state TEXT CHECK (facts_state IS NULL OR facts_state IN ('pending', 'ready')),
  facts_size INTEGER, facts_hash TEXT
);
CREATE INDEX IF NOT EXISTS retained_snapshots_expiry ON retained_snapshots(expires_at);
