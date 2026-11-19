CREATE TABLE IF NOT EXISTS quick_action_allowance_cycles (
  account_id TEXT NOT NULL, cycle_start INTEGER NOT NULL, cycle_end INTEGER NOT NULL,
  usage_highwater INTEGER NOT NULL, baseline INTEGER NOT NULL, cutoff INTEGER NOT NULL, observed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, cycle_start)
);
CREATE TABLE IF NOT EXISTS quick_action_allowance_leases (
  account_id TEXT NOT NULL, id TEXT NOT NULL, cycle_start INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER,
  actual_ms INTEGER, settled_at INTEGER, PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS quick_action_allowance_pending ON quick_action_allowance_leases(account_id, settled_at);

-- Old deployments still insert legacy leases directly during a cutover. The
-- database must serialize both generations even before those deployments update.
-- Once Quick usage starts, old code cannot account for it, so legacy admission
-- remains disabled for this account even after the Quick lease settles.
CREATE TRIGGER IF NOT EXISTS browser_allowance_block_during_quick_action
BEFORE INSERT ON browser_allowance_leases
WHEN NEW.settled_at IS NULL AND EXISTS (
  SELECT 1 FROM quick_action_allowance_leases
  WHERE account_id=NEW.account_id AND (settled_at IS NULL OR started_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(IGNORE);
END;
