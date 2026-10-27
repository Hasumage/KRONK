CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE messages (account_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(account_id,chat_id,message_id));
CREATE TABLE processed_messages (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', intent TEXT, payload TEXT NOT NULL, analysis TEXT, clarification TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(account_id,chat_id,message_id)
);
CREATE INDEX jobs_ready ON processed_messages(status,available_at);
CREATE TABLE events (id TEXT PRIMARY KEY, calendar_event_id TEXT UNIQUE NOT NULL, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, source_message_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, source_message_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')), created_at INTEGER NOT NULL);
CREATE TABLE registrations (id TEXT PRIMARY KEY, domain TEXT NOT NULL, payload TEXT NOT NULL, token_hash TEXT NOT NULL, approval_status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL, submitted_at INTEGER);
CREATE TABLE document_analyses (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL, retention_until INTEGER NOT NULL);
CREATE TABLE auto_reply_state (chat_id TEXT PRIMARY KEY, last_owner_activity_at INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL DEFAULT '', sent_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', telegram_message_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, operation_id TEXT, action TEXT NOT NULL, decision TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE api_budget (month TEXT PRIMARY KEY, reserved_usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0);
CREATE TABLE daily_usage (day TEXT PRIMARY KEY, messages INTEGER NOT NULL DEFAULT 0);
