CREATE TABLE joke_deliveries (
  id TEXT PRIMARY KEY,
  chat_key TEXT NOT NULL,
  joke_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_message_id INTEGER
);
CREATE INDEX joke_deliveries_chat ON joke_deliveries(chat_key, created_at);
