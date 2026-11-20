ALTER TABLE retained_snapshots ADD COLUMN prepared_state TEXT CHECK (prepared_state IS NULL OR prepared_state IN ('pending', 'ready'));
ALTER TABLE retained_snapshots ADD COLUMN prepared_size INTEGER;
ALTER TABLE retained_snapshots ADD COLUMN prepared_hash TEXT;
