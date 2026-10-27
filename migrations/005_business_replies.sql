CREATE TABLE reply_chats (
 number INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL, connection_id TEXT NOT NULL, chat_id TEXT NOT NULL,
 name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, explicit_allow INTEGER NOT NULL DEFAULT 0,
 owner_active_at INTEGER NOT NULL DEFAULT 0, paused_until INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1, cooldown_until INTEGER NOT NULL DEFAULT 0,
 day TEXT NOT NULL DEFAULT '', generated_count INTEGER NOT NULL DEFAULT 0,
 UNIQUE(owner_id,connection_id,chat_id)
);
CREATE TABLE reply_seen (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE reply_jobs (
 number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
 owner_id TEXT NOT NULL, chat_number INTEGER NOT NULL REFERENCES reply_chats(number),
 state TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL,
 answer TEXT, knowledge_hash TEXT, chat_revision INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX reply_jobs_ready ON reply_jobs(state,available_at);
CREATE INDEX reply_jobs_chat ON reply_jobs(chat_number,state);
