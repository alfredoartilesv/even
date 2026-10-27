-- 0003: meal prep. Recipes with tags and ingredients, cooked batches, what happened to
-- each portion (frozen, thawed, eaten, thrown out) and a shopping list.
-- Same conventions as 0001 and 0002. Never put a semicolon inside a comment here.

-- A recipe that gets cooked in bulk. portions = how many portions one batch makes.
-- Shelf life drives the stock screen: fridge_days from cooking or from thawing,
-- freezer_days from freezing, thaw_hours = how long a portion takes to defrost in the fridge.
-- Macros are per portion and are copied into food_entries when a portion is eaten.
CREATE TABLE meal_preps (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  portions          INTEGER NOT NULL DEFAULT 4 CHECK (portions > 0),
  fridge_days       INTEGER NOT NULL DEFAULT 4 CHECK (fridge_days > 0),
  freezer_days      INTEGER NOT NULL DEFAULT 90 CHECK (freezer_days > 0),
  thaw_hours        INTEGER NOT NULL DEFAULT 24 CHECK (thaw_hours >= 0),
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

-- Ingredients for one batch. quantity and unit are optional ("salt").
CREATE TABLE meal_prep_ingredients (
  id                TEXT PRIMARY KEY,
  meal_prep_id      TEXT NOT NULL REFERENCES meal_preps (id),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  name              TEXT NOT NULL,
  quantity          REAL CHECK (quantity IS NULL OR quantity > 0),
  unit              TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE INDEX idx_meal_prep_ingredients_prep ON meal_prep_ingredients (meal_prep_id) WHERE deleted_at IS NULL;

-- Free-text tags such as dinner or lunch, stored trimmed and lower case.
CREATE TABLE meal_prep_tags (
  id                TEXT PRIMARY KEY,
  meal_prep_id      TEXT NOT NULL REFERENCES meal_preps (id),
  tag               TEXT NOT NULL CHECK (tag <> '' AND tag = lower(trim(tag))),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_meal_prep_tags ON meal_prep_tags (meal_prep_id, tag) WHERE deleted_at IS NULL;
CREATE INDEX idx_meal_prep_tags_tag ON meal_prep_tags (tag) WHERE deleted_at IS NULL;

-- One cooking session. All portions start in the fridge, moves say where they went next.
CREATE TABLE meal_prep_batches (
  id                TEXT PRIMARY KEY,
  meal_prep_id      TEXT NOT NULL REFERENCES meal_preps (id),
  cooked_at_ms      INTEGER NOT NULL,
  offset_min        INTEGER NOT NULL DEFAULT 0,
  local_day         TEXT NOT NULL,
  portions          INTEGER NOT NULL CHECK (portions > 0),
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE INDEX idx_meal_prep_batches_prep ON meal_prep_batches (meal_prep_id) WHERE deleted_at IS NULL;

-- Portion movements, append only (undo = soft delete). Stock is folded from these in code.
-- freeze: fridge to freezer. thaw: freezer to fridge (ready after thaw_hours).
-- eat: from the fridge, food_entry_id points at the food log row it created.
-- discard: from the fridge or the freezer, named by from_loc.
CREATE TABLE meal_prep_moves (
  id                TEXT PRIMARY KEY,
  batch_id          TEXT NOT NULL REFERENCES meal_prep_batches (id),
  at_ms             INTEGER NOT NULL,
  offset_min        INTEGER NOT NULL DEFAULT 0,
  local_day         TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('freeze','thaw','eat','discard')),
  from_loc          TEXT NOT NULL CHECK (from_loc IN ('fridge','freezer')),
  portions          INTEGER NOT NULL CHECK (portions > 0),
  food_entry_id     TEXT REFERENCES food_entries (id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL,
  CHECK (
    (kind = 'freeze' AND from_loc = 'fridge') OR
    (kind = 'thaw' AND from_loc = 'freezer') OR
    (kind = 'eat' AND from_loc = 'fridge') OR
    kind = 'discard'
  )
);
CREATE INDEX idx_meal_prep_moves_batch ON meal_prep_moves (batch_id, at_ms) WHERE deleted_at IS NULL;

-- The supermarket list. Filled from recipes (summed per name and unit) or by hand.
-- meal_prep_id only says where an item came from.
CREATE TABLE shopping_list_items (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  quantity          REAL CHECK (quantity IS NULL OR quantity > 0),
  unit              TEXT,
  checked           INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
  meal_prep_id      TEXT REFERENCES meal_preps (id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE INDEX idx_shopping_list_items_live ON shopping_list_items (checked, name) WHERE deleted_at IS NULL;
