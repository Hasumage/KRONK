CREATE TABLE document_jobs (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL, result TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX document_jobs_ready ON document_jobs(state,available_at);
CREATE TABLE document_meta (
 number INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL,
 analysis_id TEXT NOT NULL UNIQUE REFERENCES document_analyses(id) ON DELETE CASCADE
);
