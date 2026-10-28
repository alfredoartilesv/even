-- ai_disclosures gains the 'file' data class: documents the owner attaches in the chat (PDF, text,
-- CSV), under their own consent (claude.files). Rebuilt as in 0005: SQLite cannot change a CHECK in
-- place, and nothing references the table.
CREATE TABLE ai_disclosures_v15 (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT REFERENCES chat_conversations (id),
  message_id        TEXT REFERENCES chat_messages (id),
  sent_at_ms        INTEGER NOT NULL,
  tool_name         TEXT,
  data_class        TEXT NOT NULL CHECK (data_class IN ('aggregate','raw','note','photo','file')),
  summary           TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
INSERT INTO ai_disclosures_v15 SELECT * FROM ai_disclosures;
DROP TABLE ai_disclosures;
ALTER TABLE ai_disclosures_v15 RENAME TO ai_disclosures;
CREATE INDEX idx_ai_disclosures_sent ON ai_disclosures (sent_at_ms);
