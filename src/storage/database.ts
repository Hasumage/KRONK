import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Analysis, InputMessage } from '../domain/schema.js';
import type { Vault } from '../security/vault.js';

export interface Job {
  id: string;
  status: string;
  payload: string;
  analysis: string | null;
  clarification: string | null;
  attempts: number;
}
export const operationKey = (m: InputMessage): string =>
  createHash('sha256')
    .update(JSON.stringify([m.ref.accountId, m.ref.chatId, m.ref.messageId]))
    .digest('hex');
export class Store {
  readonly db: Database.Database;
  constructor(
    path: string,
    readonly vault: Vault,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)');
    this.migrate(resolve('migrations'));
    // Running operations may have reached an external provider. Executors reconcile by operation key.
    this.db.prepare("UPDATE processed_messages SET status='retry' WHERE status='running'").run();
    this.db.prepare("UPDATE outbox SET status='uncertain' WHERE status='sending'").run();
    this.db
      .prepare(
        "UPDATE registrations SET approval_status='uncertain' WHERE approval_status='submitting'",
      )
      .run();
  }
  migrate(directory: string): void {
    for (const name of readdirSync(directory)
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      if (!this.db.prepare('SELECT name FROM migrations WHERE name=?').get(name))
        this.db.transaction(() => {
          this.db.exec(readFileSync(resolve(directory, name), 'utf8'));
          this.db.prepare('INSERT INTO migrations VALUES (?)').run(name);
        })();
    }
  }
  close(): void {
    this.db.close();
  }
  getSetting(key: string): string | null {
    return (
      (
        this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
          { value: string } | undefined
      )?.value ?? null
    );
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, value);
  }
  secret<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM secrets WHERE key=?').get(key) as
      { value: string } | undefined;
    return row ? this.vault.open<T>(row.value) : null;
  }
  putSecret(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO secrets VALUES (?,?)').run(key, this.vault.seal(value));
  }
  audit(id: string | null, action: string, decision: string): void {
    this.db
      .prepare('INSERT INTO audit_log(operation_id,action,decision,created_at) VALUES (?,?,?,?)')
      .run(id, action, decision, Date.now());
  }
  remember(m: InputMessage, maxChars = 12000): void {
    const bounded = { ...m, text: m.text.slice(0, maxChars) };
    this.db.transaction(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?)')
        .run(m.ref.accountId, m.ref.chatId, m.ref.messageId, this.vault.seal(bounded), Date.now());
      this.db
        .prepare(
          'DELETE FROM messages WHERE account_id=? AND chat_id=? AND rowid NOT IN (SELECT rowid FROM messages WHERE account_id=? AND chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20)',
        )
        .run(m.ref.accountId, m.ref.chatId, m.ref.accountId, m.ref.chatId);
    })();
  }
  message(account: string, chat: string, id: string): InputMessage | null {
    const r = this.db
      .prepare('SELECT payload FROM messages WHERE account_id=? AND chat_id=? AND message_id=?')
      .get(account, chat, id) as { payload: string } | undefined;
    return r ? this.vault.open<InputMessage>(r.payload) : null;
  }
  enqueue(m: InputMessage, messages: readonly InputMessage[] = []): boolean {
    this.remember(m);
    return (
      this.db
        .prepare(
          'INSERT OR IGNORE INTO processed_messages(id,account_id,chat_id,message_id,payload,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          operationKey(m),
          m.ref.accountId,
          m.ref.chatId,
          m.ref.messageId,
          this.vault.seal({ trigger: m, messages }),
          Date.now(),
          Date.now(),
          Date.now(),
        ).changes > 0
    );
  }
  claim(): Job | null {
    return this.db.transaction(() => {
      const r = this.db
        .prepare(
          "SELECT * FROM processed_messages WHERE status IN ('pending','retry') AND available_at<=? ORDER BY created_at LIMIT 1",
        )
        .get(Date.now()) as Job | undefined;
      if (!r) return null;
      this.db
        .prepare(
          "UPDATE processed_messages SET status='running',attempts=attempts+1,updated_at=? WHERE id=?",
        )
        .run(Date.now(), r.id);
      return { ...r, attempts: r.attempts + 1 };
    })();
  }
  finish(id: string, status: string): void {
    this.db
      .prepare('UPDATE processed_messages SET status=?,updated_at=? WHERE id=?')
      .run(status, Date.now(), id);
  }
  saveAnalysis(id: string, a: Analysis): void {
    this.db
      .prepare('UPDATE processed_messages SET intent=?,analysis=? WHERE id=?')
      .run(a.intent, this.vault.seal(a), id);
  }
  retry(job: Job): void {
    const status = job.attempts >= 5 ? 'failed' : 'retry';
    this.db
      .prepare('UPDATE processed_messages SET status=?,available_at=?,updated_at=? WHERE id=?')
      .run(status, Date.now() + Math.min(300_000, 1000 * 2 ** job.attempts), Date.now(), job.id);
    this.audit(job.id, 'worker', status);
    if (status === 'failed')
      this.notify(
        `${job.id}:error`,
        `Не удалось выполнить операцию ${job.id.slice(0, 12)}. Проверьте /status. Успех не подтверждён.`,
      );
  }
  clarify(id: string, text: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE processed_messages SET clarification=?,analysis=NULL,status='pending',attempts=0,available_at=? WHERE id=? AND status='awaiting_input'",
        )
        .run(this.vault.seal(text), Date.now(), id).changes > 0
    );
  }
  notify(id: string, text: string): void {
    // Each part has its own durable delivery state; never silently truncate a summary.
    const parts: string[] = [];
    let current = '';
    for (const char of text) {
      if (current.length + char.length > 3500) {
        parts.push(current);
        current = '';
      }
      current += char;
    }
    if (current || !parts.length) parts.push(current);
    const count = parts.length;
    for (let part = 0; part < count; part++) {
      const key = part === 0 ? id : `${id}:part:${part + 1}`;
      const body = (count > 1 ? `[${part + 1}/${count}]\n` : '') + parts[part]!;
      this.db
        .prepare('INSERT OR IGNORE INTO outbox(id,payload,created_at) VALUES (?,?,?)')
        .run(key, this.vault.seal(body), Date.now());
    }
  }
  reserveBudget(limit: number, amount: number): void {
    this.db.transaction(() => {
      const month = new Date().toISOString().slice(0, 7);
      this.db.prepare('INSERT OR IGNORE INTO api_budget(month) VALUES (?)').run(month);
      const changed = this.db
        .prepare(
          'UPDATE api_budget SET reserved_usd=reserved_usd+?,calls=calls+1 WHERE month=? AND reserved_usd+?<=?',
        )
        .run(amount, month, amount, limit).changes;
      if (!changed) throw new Error('API_BUDGET_EXCEEDED');
    })();
  }
  prune(days: number): void {
    const cutoff = Date.now() - days * 86400000;
    this.db.prepare('DELETE FROM messages WHERE created_at<?').run(cutoff);
    this.db
      .prepare(
        "UPDATE processed_messages SET status='failed' WHERE created_at<? AND status IN ('pending','retry','awaiting_input')",
      )
      .run(cutoff);
    // Keep minimal dedup tombstones: deleting these would permit replayed updates.
    this.db
      .prepare(
        "UPDATE processed_messages SET payload='',analysis=NULL,clarification=NULL WHERE updated_at<? AND status IN ('succeeded','denied','dry_run','failed','uncertain')",
      )
      .run(cutoff);
    this.db.prepare('DELETE FROM document_analyses WHERE retention_until<?').run(Date.now());
    this.db
      .prepare(
        "UPDATE outbox SET payload='',status=CASE WHEN status='pending' THEN 'expired' ELSE status END WHERE created_at<?",
      )
      .run(cutoff);
    this.db
      .prepare(
        "UPDATE registrations SET approval_status='expired' WHERE approval_status='pending' AND expires_at<?",
      )
      .run(Date.now());
    this.db
      .prepare(
        "UPDATE registrations SET payload='',token_hash='' WHERE expires_at<? AND approval_status!='submitting'",
      )
      .run(cutoff);
  }
}
