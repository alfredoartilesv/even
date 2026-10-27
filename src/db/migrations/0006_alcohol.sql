-- 0006: alcohol counter. Drink types with a serving size, ABV, calories and price, and the
-- calories and price of each logged drink, so the app can count kcal and money.
-- Same conventions as 0001 to 0005. Never put a semicolon inside a comment here.

-- What the owner usually drinks, e.g. "Mahou 330 ml", 4.8 %, 140 kcal, 1.20 EUR.
-- calories and price are per serving and optional (calories are then estimated from the alcohol).
-- Prices are in the currency set in app_settings (key currency, default EUR).
CREATE TABLE drink_types (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  volume_ml         REAL NOT NULL CHECK (volume_ml > 0),
  abv_percent       REAL NOT NULL CHECK (abv_percent >= 0 AND abv_percent <= 100),
  calories          REAL CHECK (calories IS NULL OR calories >= 0),
  price             REAL CHECK (price IS NULL OR price >= 0),
  created_by        TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','assistant')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_drink_types_name ON drink_types (lower(name)) WHERE deleted_at IS NULL;

-- Each drink keeps its own kcal and price (copied from the type when logged), so editing a
-- type later does not rewrite history. NULL calories means estimate from the alcohol.
ALTER TABLE drink_entries ADD COLUMN drink_type_id TEXT REFERENCES drink_types (id);
ALTER TABLE drink_entries ADD COLUMN calories REAL CHECK (calories IS NULL OR calories >= 0);
ALTER TABLE drink_entries ADD COLUMN price REAL CHECK (price IS NULL OR price >= 0);
CREATE INDEX idx_drink_entries_type ON drink_entries (drink_type_id) WHERE deleted_at IS NULL;

-- Daily totals, now with calories (stored, or 7 kcal per gram of alcohol when unknown) and money.
DROP VIEW daily_alcohol;
CREATE VIEW daily_alcohol AS
SELECT
  local_day,
  COUNT(*)                                        AS drinks,
  SUM(volume_ml)                                  AS volume_ml,
  SUM(volume_ml * abv_percent / 100.0 * 0.789)    AS alcohol_g,
  SUM(COALESCE(calories, volume_ml * abv_percent / 100.0 * 0.789 * 7)) AS calories,
  SUM(CASE WHEN calories IS NULL THEN 1 ELSE 0 END) AS calories_estimated,
  SUM(price)                                      AS price,
  SUM(CASE WHEN price IS NULL THEN 0 ELSE 1 END)  AS priced
FROM drink_entries
WHERE deleted_at IS NULL
GROUP BY local_day;
