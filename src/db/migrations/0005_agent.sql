-- 0005: what the chat agent needs to act in the app, not only read it.
-- Same conventions as 0001 to 0004. Never put a semicolon inside a comment here.

-- Who created a row: the owner in the app, or the assistant (after the owner confirmed it).
ALTER TABLE food_entries ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','assistant'));
ALTER TABLE drink_entries ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','assistant'));
ALTER TABLE manual_measurements ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','assistant'));
ALTER TABLE day_notes ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','assistant'));
ALTER TABLE goals ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','assistant'));
ALTER TABLE meal_preps ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','assistant'));
ALTER TABLE meal_prep_batches ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','assistant'));
ALTER TABLE saved_meals ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','assistant'));
ALTER TABLE shopping_list_items ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','assistant'));

-- Every change the assistant proposed: what it wanted to do, whether the owner confirmed it,
-- and what it wrote (rows_json, an array of objects with op, table and id, plus the quantities
-- needed to reverse a shopping-list merge), so it can be undone.
CREATE TABLE agent_actions (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT REFERENCES chat_conversations (id),
  tool_name         TEXT NOT NULL,
  summary           TEXT NOT NULL,
  input_json        TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('applied','declined','failed','undone')),
  rows_json         TEXT,
  error             TEXT,
  decided_at_ms     INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
CREATE INDEX idx_agent_actions_conversation ON agent_actions (conversation_id, decided_at_ms);

-- ai_disclosures gains the 'photo' data class. SQLite cannot change a CHECK in place, so the table is
-- rebuilt. Nothing references it, so the copy, drop and rename are safe with foreign keys on.
CREATE TABLE ai_disclosures_v5 (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT REFERENCES chat_conversations (id),
  message_id        TEXT REFERENCES chat_messages (id),
  sent_at_ms        INTEGER NOT NULL,
  tool_name         TEXT,
  data_class        TEXT NOT NULL CHECK (data_class IN ('aggregate','raw','note','photo')),
  summary           TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
INSERT INTO ai_disclosures_v5 SELECT * FROM ai_disclosures;
DROP TABLE ai_disclosures;
ALTER TABLE ai_disclosures_v5 RENAME TO ai_disclosures;
CREATE INDEX idx_ai_disclosures_sent ON ai_disclosures (sent_at_ms);
