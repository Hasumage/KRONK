import { DateTime } from 'luxon';
import type { Store } from '../storage/database.js';
import type { Task, TaskAction, TaskData, TaskFilter } from './model.js';
import { normalizeDeadline, dueToday } from './deadline.js';

interface Row {
  id: string;
  account_id: string;
  chat_id: string;
  source_message_id: string;
  status: Task['status'];
  payload: string;
  created_at: number;
  number: number;
  revision: number;
  archived_at: number | null;
  completed_at: number | null;
  updated_at: number;
  due_sort: number | null;
  trigger_message_id: string | null;
}
const select =
  'SELECT t.*,m.number,m.revision,m.archived_at,m.completed_at,m.updated_at,m.due_sort,m.trigger_message_id FROM tasks t JOIN task_meta m ON m.task_id=t.id';
export class TaskRepository {
  constructor(
    readonly store: Store,
    readonly owner: string,
    readonly timezone: string,
  ) {
    const legacy = store.db
      .prepare(
        'SELECT t.* FROM tasks t LEFT JOIN task_meta m ON m.task_id=t.id WHERE t.account_id=? AND m.task_id IS NULL',
      )
      .all(owner) as { id: string; payload: string; status: string; created_at: number }[];
    store.db.transaction(() => {
      for (const row of legacy) {
        const data = store.vault.open<TaskData>(row.payload);
        let dueSort: null | number = null;
        try {
          dueSort = normalizeDeadline(data.dueAt ?? null, data.dueDate ?? null, timezone).dueSort;
        } catch {}
        store.db
          .prepare(
            'INSERT INTO task_meta(task_id,updated_at,due_sort,archived_at,completed_at) VALUES (?,?,?,?,?)',
          )
          .run(
            row.id,
            row.created_at,
            dueSort,
            row.status === 'cancelled' ? row.created_at : null,
            row.status === 'done' ? row.created_at : null,
          );
      }
    })();
  }
  private decode(row: Row): Task {
    const data = this.store.vault.open<Partial<TaskData>>(row.payload);
    return {
      id: row.id,
      number: row.number,
      owner: row.account_id,
      chatId: row.chat_id,
      sourceMessageId: row.source_message_id,
      triggerMessageId: row.trigger_message_id,
      status: row.status,
      revision: row.revision,
      archivedAt: row.archived_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      dueSort: row.due_sort,
      title: data.title ?? 'Задача',
      description: data.description ?? null,
      dueAt: data.dueAt ?? null,
      dueDate: data.dueDate ?? null,
    };
  }
  get(number: number): Task | null {
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const row = this.store.db
      .prepare(select + ' WHERE m.number=? AND t.account_id=?')
      .get(number, this.owner) as Row | undefined;
    return row ? this.decode(row) : null;
  }
  byId(id: string): Task | null {
    const row = this.store.db
      .prepare(select + ' WHERE t.id=? AND t.account_id=?')
      .get(id, this.owner) as Row | undefined;
    return row ? this.decode(row) : null;
  }
  all(): Task[] {
    return (this.store.db.prepare(select + ' WHERE t.account_id=?').all(this.owner) as Row[]).map(
      (r) => this.decode(r),
    );
  }
  list(
    filter: TaskFilter = 'open',
    page = 0,
    search = '',
    now = Date.now(),
  ): { tasks: Task[]; count: number; page: number; pages: number } {
    const query = search.toLocaleLowerCase().replace(/ё/g, 'е');
    const rows = this.all().filter((t) => {
      if (
        query &&
        !`${t.title}\n${t.description ?? ''}`.toLocaleLowerCase().replace(/ё/g, 'е').includes(query)
      )
        return false;
      if (filter === 'archive') return t.archivedAt !== null;
      if (filter === 'all') return true;
      if (t.archivedAt !== null) return false;
      if (filter === 'done') return t.status === 'done';
      if (t.status !== 'open') return false;
      return filter === 'today'
        ? dueToday(t.dueSort, this.timezone, now)
        : filter === 'overdue'
          ? t.dueSort !== null && t.dueSort < now
          : true;
    });
    rows.sort((a, b) =>
      a.archivedAt !== null && b.archivedAt === null
        ? 1
        : a.archivedAt === null && b.archivedAt !== null
          ? -1
          : (a.dueSort ?? Infinity) - (b.dueSort ?? Infinity) ||
            b.createdAt - a.createdAt ||
            b.number - a.number,
    );
    const pages = Math.max(1, Math.ceil(rows.length / 6)),
      safePage = Math.max(0, Math.min(page, pages - 1));
    return {
      tasks: rows.slice(safePage * 6, safePage * 6 + 6),
      count: rows.length,
      page: safePage,
      pages,
    };
  }
  create(
    id: string,
    data: TaskData,
    source: { chatId: string; sourceMessageId: string; triggerMessageId: string },
  ): Task {
    const existing = this.byId(id);
    if (existing) return existing;
    const deadline = normalizeDeadline(data.dueAt, data.dueDate, this.timezone),
      now = Date.now();
    const clean = this.validate({ ...data, dueAt: deadline.dueAt, dueDate: deadline.dueDate });
    this.store.db.transaction(() => {
      this.store.db
        .prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?)')
        .run(
          id,
          this.owner,
          source.chatId,
          source.sourceMessageId,
          this.store.vault.seal(clean),
          'open',
          now,
        );
      this.store.db
        .prepare(
          'INSERT INTO task_meta(task_id,updated_at,due_sort,reminder_due,trigger_message_id) VALUES (?,?,?,?,?)',
        )
        .run(
          id,
          now,
          deadline.dueSort,
          deadline.dueSort !== null && deadline.dueSort < now ? deadline.dueSort : null,
          source.triggerMessageId,
        );
    })();
    return this.byId(id)!;
  }
  transition(number: number, action: TaskAction, eventId: string, expectedRevision?: number): Task {
    return this.store.db.transaction(() => {
      const task = this.get(number);
      if (!task) throw new Error('TASK_NOT_FOUND');
      if (this.store.db.prepare('SELECT id FROM task_actions WHERE id=?').get(eventId)) return task;
      if (expectedRevision !== undefined && task.revision !== expectedRevision)
        throw new Error('TASK_STALE');
      let status = task.status,
        archived = task.archivedAt,
        completed = task.completedAt;
      const now = Date.now();
      if (action === 'done') {
        if (archived !== null) throw new Error('TASK_ARCHIVED');
        status = 'done';
        completed = completed ?? now;
      }
      if (action === 'open') {
        status = 'open';
        archived = null;
        completed = null;
      }
      if (action === 'archive') archived = archived ?? now;
      if (action === 'restore') {
        archived = null;
        if (status === 'cancelled') status = 'open';
      }
      this.store.db
        .prepare('UPDATE tasks SET status=? WHERE id=? AND account_id=?')
        .run(status, task.id, this.owner);
      this.store.db
        .prepare(
          'UPDATE task_meta SET archived_at=?,completed_at=?,updated_at=?,revision=revision+1 WHERE task_id=?',
        )
        .run(archived, completed, now, task.id);
      this.store.db
        .prepare('INSERT INTO task_actions VALUES (?,?,?,?)')
        .run(eventId, task.id, action, now);
      this.store.audit(task.id, 'task.' + action, 'succeeded');
      return this.get(number)!;
    })();
  }
  edit(number: number, patch: Partial<TaskData>, eventId: string, expectedRevision: number): Task {
    return this.store.db.transaction(() => {
      const task = this.get(number);
      if (!task) throw new Error('TASK_NOT_FOUND');
      if (this.store.db.prepare('SELECT id FROM task_actions WHERE id=?').get(eventId)) return task;
      if (task.revision !== expectedRevision) throw new Error('TASK_STALE');
      if (task.archivedAt !== null) throw new Error('TASK_ARCHIVED');
      const clean = this.validate({ ...task, ...patch }),
        deadline = normalizeDeadline(clean.dueAt, clean.dueDate, this.timezone);
      clean.dueAt = deadline.dueAt;
      clean.dueDate = deadline.dueDate;
      this.store.db
        .prepare('UPDATE tasks SET payload=? WHERE id=? AND account_id=?')
        .run(this.store.vault.seal(clean), task.id, this.owner);
      this.store.db
        .prepare(
          'UPDATE task_meta SET due_sort=?,reminder_due=CASE WHEN ? IS NOT NULL AND ?<? THEN ? ELSE reminder_due END,updated_at=?,revision=revision+1 WHERE task_id=?',
        )
        .run(
          deadline.dueSort,
          deadline.dueSort,
          deadline.dueSort,
          Date.now(),
          deadline.dueSort,
          Date.now(),
          task.id,
        );
      this.store.db
        .prepare('INSERT INTO task_actions VALUES (?,?,?,?)')
        .run(eventId, task.id, 'edit', Date.now());
      this.store.audit(task.id, 'task.edit', 'succeeded');
      return this.get(number)!;
    })();
  }
  private validate(data: TaskData): TaskData {
    const title = data.title.trim(),
      description = data.description?.trim() || null;
    if (!title || title.length > 200 || (description?.length ?? 0) > 2500)
      throw new Error('TASK_INVALID_TEXT');
    return { title, description, dueAt: data.dueAt ?? null, dueDate: data.dueDate ?? null };
  }
  bound(chatId: string, messageId: string | null): Task[] {
    return this.all().filter(
      (t) =>
        t.chatId === chatId &&
        t.status === 'open' &&
        t.archivedAt === null &&
        (messageId === null || t.sourceMessageId === messageId || t.triggerMessageId === messageId),
    );
  }
  reminderCandidates(now = Date.now()): Task[] {
    return (
      this.store.db
        .prepare(
          select +
            " WHERE t.account_id=? AND t.status='open' AND m.archived_at IS NULL AND m.due_sort IS NOT NULL AND m.due_sort<=? AND (m.reminder_due IS NULL OR m.reminder_due!=m.due_sort) LIMIT 10",
        )
        .all(this.owner, now) as Row[]
    ).map((r) => this.decode(r));
  }
  markReminded(task: Task): void {
    this.store.db
      .prepare('UPDATE task_meta SET reminder_due=? WHERE task_id=? AND due_sort=?')
      .run(task.dueSort, task.id, task.dueSort);
  }
  todayLabel(): string {
    return DateTime.now().setZone(this.timezone).toISODate()!;
  }
}
