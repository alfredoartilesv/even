-- Phase 1 local schema. Conventions (see docs/architecture.md section 3):
--   * UUIDv7 text primary keys, never auto-increment
--   * timestamps are UTC epoch milliseconds, plus offset_min (minutes east of UTC)
--   * user-authored tables carry updated_at, deleted_at (soft delete), origin_device_id
--     so a later Postgres sync is additive

-- Samples that arrive from a Source (freddy now, others later). Idempotent re-sync:
-- the adapter derives external_id (e.g. the day or the source record id) so the same
-- reading always maps to the same row.
CREATE TABLE health_samples (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  device       TEXT NOT NULL DEFAULT '',
  external_id  TEXT NOT NULL,
  metric       TEXT NOT NULL,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER,
  offset_min   INTEGER NOT NULL DEFAULT 0,
  value_num    REAL,
  value_text   TEXT,
  unit         TEXT,
  raw_json     TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (source, device, metric, external_id)
);
CREATE INDEX idx_health_samples_metric_time ON health_samples (metric, start_ms);

CREATE TABLE sync_state (
  source          TEXT PRIMARY KEY,
  cursor          TEXT,
  last_synced_ms  INTEGER,
  last_error      TEXT,
  updated_at      INTEGER NOT NULL
);

-- Food / macros log.
CREATE TABLE food_entries (
  id                TEXT PRIMARY KEY,
  eaten_at_ms       INTEGER NOT NULL,
  offset_min        INTEGER NOT NULL DEFAULT 0,
  name              TEXT NOT NULL,
  meal              TEXT CHECK (meal IN ('breakfast','lunch','dinner','snack','prep')),
  calories          REAL,
  protein_g         REAL,
  carbs_g           REAL,
  fat_g             REAL,
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE INDEX idx_food_entries_time ON food_entries (eaten_at_ms) WHERE deleted_at IS NULL;

-- Alcohol log. Grams of alcohol = volume_ml * abv_percent / 100 * 0.789 (computed, not stored).
CREATE TABLE drink_entries (
  id                TEXT PRIMARY KEY,
  drunk_at_ms       INTEGER NOT NULL,
  offset_min        INTEGER NOT NULL DEFAULT 0,
  name              TEXT NOT NULL,
  volume_ml         REAL NOT NULL,
  abv_percent       REAL NOT NULL,
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE INDEX idx_drink_entries_time ON drink_entries (drunk_at_ms) WHERE deleted_at IS NULL;

CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
