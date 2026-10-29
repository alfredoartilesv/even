-- The sync server's whole schema. It stores sealed rows only (src/features/cloudsync/seal.ts):
-- no health value, name, note or id is readable here. Same file on local Docker and on Neon.

-- A device the owner registered (npm run sync:device). Only the token's SHA-256 is kept.
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    BIGINT NOT NULL,
  last_seen_at  BIGINT,
  revoked_at    BIGINT
);
CREATE INDEX idx_devices_owner ON devices (owner_id);

-- One server-wide counter, so a pull is "everything after N".
CREATE SEQUENCE sync_seq;

-- The newest sealed copy of each row. row_key is the phone's HMAC of the row's natural key.
CREATE TABLE sync_rows (
  owner_id    TEXT NOT NULL,
  tbl         TEXT NOT NULL,
  row_key     TEXT NOT NULL,
  updated_at  BIGINT NOT NULL,
  seq         BIGINT NOT NULL,
  device_id   TEXT NOT NULL REFERENCES devices (id),
  blob        TEXT NOT NULL,
  PRIMARY KEY (owner_id, tbl, row_key)
);
CREATE INDEX idx_sync_rows_pull ON sync_rows (owner_id, seq);
