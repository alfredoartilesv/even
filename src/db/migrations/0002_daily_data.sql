-- 0002: everything the daily screens, manual logs, goals and the Claude chat need.
-- Same conventions as 0001 (UUIDv7 text ids, UTC epoch ms + offset_min, soft delete).
-- local_day is the YYYY-MM-DD calendar day in the zone that was in force for the row, stored
-- so screens and trends filter by day without doing timezone maths in SQL.
-- Never put a semicolon inside a comment here: the Android plugin splits scripts on them.

-- Health samples: add the local day and backfill it from start_ms + offset_min.
ALTER TABLE health_samples ADD COLUMN local_day TEXT;
UPDATE health_samples SET local_day = date(start_ms / 1000 + offset_min * 60, 'unixepoch');
CREATE INDEX idx_health_samples_metric_day ON health_samples (metric, local_day);

ALTER TABLE food_entries ADD COLUMN local_day TEXT;
UPDATE food_entries SET local_day = date(eaten_at_ms / 1000 + offset_min * 60, 'unixepoch');
CREATE INDEX idx_food_entries_day ON food_entries (local_day) WHERE deleted_at IS NULL;

ALTER TABLE drink_entries ADD COLUMN local_day TEXT;
UPDATE drink_entries SET local_day = date(drunk_at_ms / 1000 + offset_min * 60, 'unixepoch');
CREATE INDEX idx_drink_entries_day ON drink_entries (local_day) WHERE deleted_at IS NULL;

-- What each source can give us (filled from freddy's list_metrics on every sync), plus the
-- user's display choices. Sync only refreshes unit, device, first_day, last_day and records,
-- it never overwrites label, category, daily_agg, higher_is_better, pinned or sort_order.
CREATE TABLE metric_catalog (
  source            TEXT NOT NULL,
  metric            TEXT NOT NULL,
  unit              TEXT,
  device            TEXT,
  first_day         TEXT,
  last_day          TEXT,
  records           INTEGER,
  label             TEXT,
  category          TEXT NOT NULL DEFAULT 'other'
                    CHECK (category IN ('sleep','recovery','activity','heart','stress','body','nutrition','other')),
  daily_agg         TEXT NOT NULL DEFAULT 'avg' CHECK (daily_agg IN ('avg','sum','min','max','last')),
  higher_is_better  INTEGER CHECK (higher_is_better IN (0, 1)),
  pinned            INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  sort_order        INTEGER,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (source, metric)
);

-- One row per metric, day, source and device, for daily screens and trend charts.
-- A day can hold several readings (two weigh-ins), so every aggregate is offered and the
-- screen picks the one named by metric_catalog.daily_agg. partial = the day was not over yet.
CREATE VIEW daily_metric_values AS
SELECT
  metric,
  local_day,
  source,
  device,
  COUNT(*)        AS readings,
  AVG(value_num)  AS avg_num,
  SUM(value_num)  AS sum_num,
  MIN(value_num)  AS min_num,
  MAX(value_num)  AS max_num,
  (SELECT l.value_num FROM health_samples l
    WHERE l.metric = h.metric AND l.local_day = h.local_day AND l.source = h.source
      AND l.device = h.device AND l.value_num IS NOT NULL
    ORDER BY l.start_ms DESC, l.rowid DESC LIMIT 1) AS last_num,
  MAX(unit)       AS unit,
  MAX(CASE WHEN raw_json LIKE '%"partial":true%' THEN 1 ELSE 0 END) AS partial
FROM health_samples h
WHERE value_num IS NOT NULL AND local_day IS NOT NULL
GROUP BY metric, local_day, source, device;

-- Things measured by hand at a moment in time: weight on another scale, blood pressure,
-- fingerstick glucose, a supplement or medication taken, a symptom.
-- kind is free text so new kinds need no migration. value_num2 is the second number of a
-- pair (diastolic for blood_pressure), NULL otherwise.
CREATE TABLE manual_measurements (
  id                TEXT PRIMARY KEY,
  measured_at_ms    INTEGER NOT NULL,
  offset_min        INTEGER NOT NULL DEFAULT 0,
  local_day         TEXT NOT NULL,
  kind              TEXT NOT NULL,
  value_num         REAL,
  value_num2        REAL,
  value_text        TEXT,
  unit              TEXT,
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE INDEX idx_manual_measurements_kind_day ON manual_measurements (kind, local_day) WHERE deleted_at IS NULL;

-- Daily check-in: how the day felt (1 to 5 ratings) and a free-text note. One live row per day.
CREATE TABLE day_notes (
  id                TEXT PRIMARY KEY,
  local_day         TEXT NOT NULL,
  mood              INTEGER CHECK (mood BETWEEN 1 AND 5),
  energy            INTEGER CHECK (energy BETWEEN 1 AND 5),
  body              TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_day_notes_day ON day_notes (local_day) WHERE deleted_at IS NULL;

-- Targets such as "steps >= 10000 per day" or "alcohol <= 20 g per week".
-- target_kind says where the number comes from: a synced sample metric, a manual
-- measurement kind, a food_entries column, drink alcohol grams, or nothing (free-text goal).
CREATE TABLE goals (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  target_kind       TEXT NOT NULL CHECK (target_kind IN ('sample','manual','food','drink','none')),
  metric            TEXT,
  comparator        TEXT CHECK (comparator IN ('>=','<=')),
  target_num        REAL,
  unit              TEXT,
  period            TEXT NOT NULL DEFAULT 'day' CHECK (period IN ('day','week','month')),
  start_day         TEXT NOT NULL,
  end_day           TEXT,
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL,
  CHECK (target_kind = 'none' OR (metric IS NOT NULL AND comparator IS NOT NULL AND target_num IS NOT NULL))
);

-- Claude chat. content_json holds the Anthropic content blocks exactly as sent or received,
-- including tool_use and tool_result, so a conversation can be replayed to the API.
CREATE TABLE chat_conversations (
  id                TEXT PRIMARY KEY,
  title             TEXT,
  model             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE INDEX idx_chat_conversations_updated ON chat_conversations (updated_at) WHERE deleted_at IS NULL;

CREATE TABLE chat_messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES chat_conversations (id),
  seq               INTEGER NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content_json      TEXT NOT NULL,
  model             TEXT,
  stop_reason       TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

-- The "what was sent to Claude" panel: every piece of health data that left the phone.
-- data_class: aggregate (summaries, the default), raw (time series, needs a yes first),
-- note (user-written text such as day notes).
CREATE TABLE ai_disclosures (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT REFERENCES chat_conversations (id),
  message_id        TEXT REFERENCES chat_messages (id),
  sent_at_ms        INTEGER NOT NULL,
  tool_name         TEXT,
  data_class        TEXT NOT NULL CHECK (data_class IN ('aggregate','raw','note')),
  summary           TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE INDEX idx_ai_disclosures_sent ON ai_disclosures (sent_at_ms);

-- GDPR: explicit, granular consent, kept as history. The newest row per scope is in force.
-- Example scopes: claude.aggregates, claude.raw_series, claude.notes.
CREATE TABLE consents (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,
  granted           INTEGER NOT NULL CHECK (granted IN (0, 1)),
  decided_at_ms     INTEGER NOT NULL,
  policy_version    TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE INDEX idx_consents_scope ON consents (scope, decided_at_ms);

-- One row per sync attempt: drives "last synced", gap warnings and troubleshooting.
CREATE TABLE sync_runs (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  started_ms        INTEGER NOT NULL,
  finished_ms       INTEGER,
  status            TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  cursor_before     TEXT,
  cursor_after      TEXT,
  samples_written   INTEGER,
  warnings_json     TEXT,
  error             TEXT
);
CREATE INDEX idx_sync_runs_source ON sync_runs (source, started_ms);

-- Daily totals for the food and drink logs.
CREATE VIEW daily_nutrition AS
SELECT
  local_day,
  COUNT(*)        AS entries,
  SUM(calories)   AS calories,
  SUM(protein_g)  AS protein_g,
  SUM(carbs_g)    AS carbs_g,
  SUM(fat_g)      AS fat_g
FROM food_entries
WHERE deleted_at IS NULL
GROUP BY local_day;

CREATE VIEW daily_alcohol AS
SELECT
  local_day,
  COUNT(*)                                        AS drinks,
  SUM(volume_ml)                                  AS volume_ml,
  SUM(volume_ml * abv_percent / 100.0 * 0.789)    AS alcohol_g
FROM drink_entries
WHERE deleted_at IS NULL
GROUP BY local_day;
