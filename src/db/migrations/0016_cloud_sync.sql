-- Phase 2 cloud sync bookkeeping for this install only. Never synced and never in a backup:
-- a restored copy of another install's cursors would make this one skip rows.
--   name = a synced table (how far its rows were pushed: updated_at, then rowid)
--   name = 'pull' (the server sequence number read up to, in upto)
CREATE TABLE cloud_sync_cursors (
  name        TEXT PRIMARY KEY,
  upto        INTEGER NOT NULL DEFAULT -1,
  upto_rowid  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
