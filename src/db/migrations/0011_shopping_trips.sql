-- 0011: supermarket spending. One row per shop paid for, so the owner can see what groceries cost.
-- Same conventions as 0001 to 0010. Never put a semicolon inside a comment here.

-- shop is the supermarket as typed (matched case-insensitively when summed). amount is what was
-- paid, in the currency set in app_settings (key currency, default EUR), like drink prices.
-- items = how many ticked shopping list items this shop cleared, when it came from the list.
CREATE TABLE shopping_trips (
  id                TEXT PRIMARY KEY,
  shop              TEXT NOT NULL CHECK (trim(shop) <> ''),
  amount            REAL NOT NULL CHECK (amount > 0),
  paid_at_ms        INTEGER NOT NULL,
  offset_min        INTEGER NOT NULL DEFAULT 0,
  local_day         TEXT NOT NULL,
  items             INTEGER CHECK (items IS NULL OR items >= 0),
  notes             TEXT,
  created_by        TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','assistant')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE INDEX idx_shopping_trips_day ON shopping_trips (local_day) WHERE deleted_at IS NULL;
