-- The app's own log records (src/core/log.ts), kept so they outlive the run that wrote them:
-- Settings > Debug logs, shown to admin accounts, reads them back. Written as each record is
-- logged, already sanitized (no health values, notes, keys or URLs). This install only: never
-- synced and never in a backup. The newest few thousand are kept, older ones pruned.
CREATE TABLE log_records (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  level   TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  scope   TEXT NOT NULL,
  msg     TEXT NOT NULL,
  fields  TEXT
);
