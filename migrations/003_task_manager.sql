CREATE TABLE task_meta (
 number INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1,
 archived_at INTEGER,
 completed_at INTEGER,
 updated_at INTEGER NOT NULL,
 due_sort INTEGER,
 reminder_due INTEGER,
 trigger_message_id TEXT
);
CREATE INDEX task_meta_deadline ON task_meta(archived_at,due_sort);
CREATE TABLE task_actions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE task_jobs (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
 task_number INTEGER, expected_revision INTEGER,
 state TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX task_jobs_ready ON task_jobs(state,available_at);
CREATE TABLE task_inputs (
 owner_id TEXT PRIMARY KEY, kind TEXT NOT NULL, task_number INTEGER, revision INTEGER,
 outbox_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
