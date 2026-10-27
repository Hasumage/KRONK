CREATE TABLE business_connections (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 enabled INTEGER NOT NULL,
 can_reply INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE business_math (
 id TEXT PRIMARY KEY,
 connection_id TEXT NOT NULL,
 chat_id TEXT NOT NULL,
 message_id INTEGER NOT NULL,
 status TEXT NOT NULL,
 answer TEXT NOT NULL,
 sent_message_id INTEGER,
 created_at INTEGER NOT NULL,
 UNIQUE(connection_id,chat_id,message_id)
);
CREATE INDEX business_math_chat_time ON business_math(chat_id,created_at);
