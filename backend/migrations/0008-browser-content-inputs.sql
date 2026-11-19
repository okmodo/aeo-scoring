ALTER TABLE retained_snapshots ADD COLUMN inputs_state TEXT CHECK (inputs_state IS NULL OR inputs_state IN ('pending', 'ready'));
ALTER TABLE retained_snapshots ADD COLUMN inputs_size INTEGER;
ALTER TABLE retained_snapshots ADD COLUMN inputs_hash TEXT;
