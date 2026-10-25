-- 0004: food log screens. Saved (favourite) meals with an optional photo, and a link from
-- each food entry to the saved meal it was logged from, so reuse is counted from the log.
-- Same conventions as 0001 to 0003. Never put a semicolon inside a comment here.

-- A photo kept with a saved meal. The app downsizes it and re-encodes it before saving,
-- which also drops EXIF data such as GPS position. Base64 so it lives in the encrypted DB
-- and in the encrypted backup like every other row.
CREATE TABLE food_photos (
  id                TEXT PRIMARY KEY,
  mime              TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/webp')),
  data_b64          TEXT NOT NULL,
  width             INTEGER,
  height            INTEGER,
  bytes             INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);

-- A meal the owner bookmarked to log again with one tap. Macros are per serving.
-- meal is the usual slot, used to suggest it at the right time of day.
CREATE TABLE saved_meals (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  meal              TEXT CHECK (meal IN ('breakfast','lunch','dinner','snack','prep')),
  calories          REAL,
  protein_g         REAL,
  carbs_g           REAL,
  fat_g             REAL,
  notes             TEXT,
  photo_id          TEXT REFERENCES food_photos (id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);

ALTER TABLE food_entries ADD COLUMN saved_meal_id TEXT REFERENCES saved_meals (id);
CREATE INDEX idx_food_entries_saved_meal ON food_entries (saved_meal_id) WHERE deleted_at IS NULL;
