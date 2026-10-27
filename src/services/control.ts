import type { Settings } from '../config/settings.js';
import type { Store } from '../storage/database.js';
import type { Registrations } from './registrations.js';

export class Control {
  constructor(
    private readonly c: Settings,
    private readonly s: Store,
    private readonly registrations: Registrations,
  ) {}
  async handle(
    sender: string,
    privateChat: boolean,
    text: string,
    replyMessageId?: string,
  ): Promise<string | null> {
    if (sender !== this.c.OWNER_TELEGRAM_ID || !privateChat) return null;
    const [command, ...args] = text.trim().split(/\s+/);
    const value = args.join(' ');
    if (command === '/pause') {
      this.s.setSetting('paused', 'true');
      return 'Обработка приостановлена.';
    }
    if (command === '/resume') {
      this.s.setSetting('paused', 'false');
      return 'Обработка возобновлена.';
    }
    if (command === '/status') {
      const statuses = this.s.db
        .prepare('SELECT status,count(*) AS count FROM processed_messages GROUP BY status')
        .all();
      const uncertain = this.s.db
        .prepare("SELECT count(*) AS count FROM outbox WHERE status='uncertain'")
        .get();
      return `Режим: ${this.c.MODE}, dry-run: ${this.c.DRY_RUN}\nПауза: ${this.s.getSetting('paused') === 'true'}\nОчередь: ${JSON.stringify(statuses)}\nНеопределённые уведомления: ${JSON.stringify(uncertain)}`;
    }
    if (command === '/settings')
      return JSON.stringify(
        {
          timezone: this.c.TIMEZONE,
          reminder: this.c.CALENDAR_REMINDER_MINUTES,
          autoReply: this.c.AUTO_REPLY_ENABLED,
          modules: {
            calendar: this.c.CALENDAR_ENABLED,
            tasks: this.c.TASKS_ENABLED,
            documents: this.c.DOCUMENTS_ENABLED,
            registrations: this.c.REGISTRATIONS_ENABLED,
          },
        },
        null,
        2,
      );
    if (command === '/tasks') {
      const rows = this.s.db
        .prepare("SELECT id,payload FROM tasks WHERE status='open' AND account_id=? LIMIT 20")
        .all(sender) as { id: string; payload: string }[];
      return (
        rows
          .map((r) => `${r.id}: ${this.s.vault.open<{ title: string }>(r.payload).title}`)
          .join('\n') || 'Открытых задач нет.'
      );
    }
    if (command === '/events') {
      const rows = this.s.db
        .prepare("SELECT id,payload FROM events WHERE status='active' AND account_id=? LIMIT 20")
        .all(sender) as { id: string; payload: string }[];
      return (
        rows
          .map((r) => `${r.id}: ${this.s.vault.open<{ title: string }>(r.payload).title}`)
          .join('\n') || 'Активных событий нет.'
      );
    }
    if (command === '/cancel_task') {
      if (!this.c.TASKS_ENABLED || this.c.DRY_RUN || this.s.getSetting('paused') === 'true')
        return 'Изменение задач заблокировано настройками режима.';
      const changed = this.s.db
        .prepare(
          "UPDATE tasks SET status='cancelled' WHERE id=? AND account_id=? AND status='open'",
        )
        .run(value, sender).changes;
      this.s.audit(value, 'task.cancel', changed ? 'succeeded' : 'not_found');
      return changed ? 'Задача отменена.' : 'Открытая задача с таким ID не найдена.';
    }
    if (command === '/approve') return this.registrations.approve(value);
    if (command === '/reject') {
      this.s.db
        .prepare(
          "UPDATE registrations SET approval_status='rejected' WHERE id=? AND approval_status='pending'",
        )
        .run(value);
      return 'Подтверждение отменено.';
    }
    if (command === '/clarify') {
      const id = args.shift();
      if (!id || !args.length) return 'Используйте /clarify ID текст';
      if (args.join(' ').length > this.c.MAX_CONTEXT_CHARS) return 'Уточнение слишком длинное.';
      return this.s.clarify(id, args.join(' '))
        ? 'Уточнение принято.'
        : 'Операция не ожидает уточнения.';
    }
    if (replyMessageId && !text.startsWith('/')) {
      const r = this.s.db
        .prepare('SELECT id FROM outbox WHERE telegram_message_id=?')
        .get(replyMessageId) as { id: string } | undefined;
      const id = r?.id.split(':')[0];
      if (id && text.length <= this.c.MAX_CONTEXT_CHARS && this.s.clarify(id, text))
        return 'Уточнение принято.';
    }
    if (command === '/forget') {
      if (value !== 'CONFIRM')
        return 'Удалить историю, задачи, события-ссылки, документы, формы и токены: /forget CONFIRM. Внешние события Google Calendar сохранятся. После удаления токенов потребуется повторная авторизация.';
      this.s.db.transaction(() => {
        for (const table of [
          'messages',
          'tasks',
          'events',
          'document_analyses',
          'registrations',
          'secrets',
          'auto_reply_state',
          'outbox',
        ])
          this.s.db.exec(`DELETE FROM ${table}`);
        this.s.db.exec(
          "UPDATE processed_messages SET payload='',analysis=NULL,clarification=NULL,status='denied'",
        );
        this.s.setSetting('paused', 'true');
        this.s.setSetting('session_revoked', 'true');
      })();
      return 'Локальные данные удалены. Обработка на паузе; перезапустите процесс, чтобы закрыть активные сессии.';
    }
    return '/status /pause /resume /settings /tasks /events /help\n/cancel_task ID — отменить задачу\n/clarify ID текст — уточнение\n/approve TOKEN — передать данные и отправить форму\n/reject ID — отменить\n/forget — удаление данных';
  }
}
