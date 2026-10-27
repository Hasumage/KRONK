import type { Settings } from '../config/settings.js';
import {
  analysisSchema,
  type Analysis,
  type InputMessage,
  type ResolvedContext,
} from '../domain/schema.js';
import { operationKey, Store, type Job } from '../storage/database.js';
import type { AI } from '../adapters/ai.js';
import type { Calendar, CalendarEvent } from '../adapters/calendar.js';
import { resolveContext } from './context.js';
import { decide } from './policy.js';
import { summarizeDocument, type Download } from '../services/documents.js';
import type { Registrations } from '../services/registrations.js';

export type AutoSend = (message: InputMessage, text: string, operationId: string) => Promise<void>;
export class Worker {
  constructor(
    readonly c: Settings,
    readonly store: Store,
    private readonly ai: AI,
    private readonly calendar: Calendar,
    private readonly download: Download,
    private readonly registrations: Registrations,
    private readonly autoSend: AutoSend,
    private readonly knowledge: ResolvedContext['knowledge'] = [],
  ) {}
  ingest(m: InputMessage): boolean {
    if (m.ref.accountId !== this.c.OWNER_TELEGRAM_ID || m.generatedByAssistant) return false;
    this.store.remember(m, this.c.MAX_CONTEXT_CHARS);
    if (m.direction === 'outgoing' && m.senderId !== this.c.OWNER_TELEGRAM_ID) return false;
    if (m.direction === 'outgoing' && m.senderId === this.c.OWNER_TELEGRAM_ID)
      this.store.db
        .prepare(
          'INSERT INTO auto_reply_state(chat_id,last_owner_activity_at) VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET last_owner_activity_at=MAX(auto_reply_state.last_owner_activity_at,excluded.last_owner_activity_at)',
        )
        .run(m.ref.chatId, Math.min(Date.now(), Date.parse(m.sentAt)));
    if (this.store.getSetting('paused') === 'true' || m.text.length > this.c.MAX_CONTEXT_CHARS)
      return false;
    if (
      m.direction === 'incoming' &&
      (!this.c.AUTO_REPLY_ENABLED || !this.c.AUTO_REPLY_CHATS.includes(m.ref.chatId))
    )
      return false;
    const day = new Date().toISOString().slice(0, 10);
    return this.store.db.transaction(() => {
      if (
        this.store.db.prepare('SELECT id FROM processed_messages WHERE id=?').get(operationKey(m))
      )
        return false;
      this.store.db.prepare('INSERT OR IGNORE INTO daily_usage(day) VALUES (?)').run(day);
      if (
        !this.store.db
          .prepare('UPDATE daily_usage SET messages=messages+1 WHERE day=? AND messages<?')
          .run(day, this.c.MAX_MESSAGES_PER_DAY).changes
      ) {
        this.store.audit(null, 'ingest', 'daily_limit');
        return false;
      }
      return this.store.enqueue(m, resolveContext(this.store, this.c, m, null, []).messages);
    })();
  }
  async tick(): Promise<boolean> {
    if (this.store.getSetting('paused') === 'true') return false;
    const job = this.store.claim();
    if (!job) return false;
    try {
      const saved = this.store.vault.open<
        InputMessage | { trigger: InputMessage; messages: InputMessage[] }
      >(job.payload);
      const trigger = 'trigger' in saved ? saved.trigger : saved;
      const ctx = resolveContext(
        this.store,
        this.c,
        trigger,
        job.clarification ? this.store.vault.open<string>(job.clarification) : null,
        this.knowledge,
      );
      if ('trigger' in saved) ctx.messages = saved.messages;
      const a = job.analysis
        ? analysisSchema.parse(this.store.vault.open<Analysis>(job.analysis))
        : await this.ai.classify(ctx);
      this.store.saveAnalysis(job.id, a);
      const decision = decide(this.c, ctx, a);
      this.store.audit(
        job.id,
        a.intent,
        decision.kind === 'deny' ? decision.reason : decision.kind,
      );
      if (decision.kind === 'deny') {
        this.store.finish(job.id, 'denied');
        return true;
      }
      if (decision.kind === 'clarify') {
        this.store.db.transaction(() => {
          this.store.finish(job.id, 'awaiting_input');
          this.store.notify(
            `${job.id}:clarify:${job.attempts}`,
            `${decision.question}\nОтветьте на это сообщение или используйте /clarify ${job.id} текст уточнения`,
          );
        })();
        return true;
      }
      if (this.c.DRY_RUN) {
        this.store.notify(
          `${job.id}:dry`,
          `DRY-RUN: ${a.intent}\n${JSON.stringify(a.data)}\nВнешние и предметные операции не выполнялись.`,
        );
        this.store.finish(job.id, 'dry_run');
        return true;
      }
      await this.execute(job, ctx, a);
      this.store.db
        .prepare(
          "UPDATE processed_messages SET status='succeeded',updated_at=? WHERE id=? AND status='running'",
        )
        .run(Date.now(), job.id);
      this.store.audit(job.id, a.intent, 'processed');
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const manual =
        code.startsWith('REGISTRATION_') ||
        code.startsWith('DOCUMENT_') ||
        code === 'API_BUDGET_EXCEEDED' ||
        code === 'AI_CONTEXT_LIMIT_EXCEEDED';
      if (manual) {
        const message = code.startsWith('REGISTRATION_')
          ? 'Регистрация остановлена: форма или ссылка не поддерживается безопасным режимом, либо не хватает разрешённых профильных полей. Проверьте домен и заполните форму вручную.'
          : code.startsWith('DOCUMENT_')
            ? 'Документ не обработан: проверьте формат PDF/DOCX/TXT, размер и наличие текста. Для сканов нужен отдельный OCR.'
            : 'Обработка остановлена: исчерпан бюджет API или превышен лимит контекста. Проверьте настройки.';
        this.store.db.transaction(() => {
          this.store.finish(job.id, 'failed');
          this.store.audit(job.id, 'worker', code);
          this.store.notify(`${job.id}:error`, message);
        })();
      } else this.store.retry(job);
    }
    return true;
  }
  private async execute(job: Job, ctx: ResolvedContext, a: Analysis): Promise<void> {
    const m = ctx.trigger,
      d = a.data,
      s = this.store;
    const prefix = this.c.MODE === 'mock' ? 'MOCK: ' : '';
    const notify = (text: string) => s.notify(`${job.id}:result`, prefix + text);
    if (a.intent === 'calendar.create') {
      let event: CalendarEvent;
      const row = s.db.prepare('SELECT payload FROM events WHERE id=?').get(job.id) as
        { payload: string } | undefined;
      if (row) event = s.vault.open<CalendarEvent>(row.payload);
      else {
        event = await this.calendar.create(job.id, d);
      }
      s.db.transaction(() => {
        s.db
          .prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?,?)')
          .run(
            job.id,
            event.id,
            m.ref.accountId,
            m.ref.chatId,
            m.ref.messageId,
            s.vault.seal(event),
            'active',
            Date.now(),
          );
        notify(
          `✅ Занесено в календарь.\nСобытие: ${event.title}\n${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeStyle: 'short', timeZone: this.c.TIMEZONE }).format(new Date(event.startAt))} (${this.c.TIMEZONE})\nМесто: ${event.location ?? 'не указано'}\nНапоминание: за ${this.c.CALENDAR_REMINDER_MINUTES} мин.${event.assumedDuration ? `\nДлительность ${this.c.DEFAULT_EVENT_DURATION_MINUTES} мин. принята по умолчанию.` : ''}\n${event.url}`,
        );
        s.finish(job.id, 'succeeded');
      })();
    } else if (a.intent === 'calendar.update' || a.intent === 'calendar.cancel') {
      const row = s.db
        .prepare('SELECT payload FROM events WHERE id=? AND account_id=? AND chat_id=?')
        .get(d.targetId, m.ref.accountId, m.ref.chatId) as { payload: string } | undefined;
      if (!row) throw new Error('EVENT_NOT_FOUND');
      const old = s.vault.open<CalendarEvent>(row.payload);
      if (a.intent === 'calendar.cancel') {
        await this.calendar.cancel(old.id);
        s.db.transaction(() => {
          s.db.prepare("UPDATE events SET status='cancelled' WHERE id=?").run(d.targetId);
          notify('Событие отменено.');
          s.finish(job.id, 'succeeded');
        })();
      } else {
        const updated = await this.calendar.update(old, d);
        s.db.transaction(() => {
          s.db
            .prepare('UPDATE events SET payload=? WHERE id=?')
            .run(s.vault.seal(updated), d.targetId);
          notify(`Событие изменено: ${updated.title}\n${updated.startAt}\n${updated.url}`);
          s.finish(job.id, 'succeeded');
        })();
      }
    } else if (a.intent === 'task.create') {
      s.db.transaction(() => {
        s.db
          .prepare('INSERT OR IGNORE INTO tasks VALUES (?,?,?,?,?,?,?)')
          .run(
            job.id,
            m.ref.accountId,
            m.ref.chatId,
            m.replyTo!.messageId,
            s.vault.seal({ title: d.title, description: d.description, dueAt: d.dueAt }),
            'open',
            Date.now(),
          );
        notify(`Задача добавлена: ${d.title}\nСрок: ${d.dueAt ?? 'не указан'}\nID: ${job.id}`);
        s.finish(job.id, 'succeeded');
      })();
    } else if (a.intent === 'task.complete') {
      s.db.transaction(() => {
        s.db
          .prepare("UPDATE tasks SET status='done' WHERE id=? AND account_id=? AND chat_id=?")
          .run(d.targetId, m.ref.accountId, m.ref.chatId);
        notify(`Задача закрыта: ${d.targetId}`);
        s.finish(job.id, 'succeeded');
      })();
    } else if (a.intent === 'registration.prepare') {
      if (this.c.MODE === 'mock') {
        notify('Регистрация: mock не открывает сайты и не отправляет формы.');
        return;
      }
      notify(await this.registrations.prepare(job.id, d.url!));
    } else if (a.intent === 'document.summarize') {
      const existing = s.db
        .prepare('SELECT payload FROM document_analyses WHERE id=?')
        .get(job.id) as { payload: string } | undefined;
      const doc = ctx.messages.find((v) => v.ref.messageId === d.documentMessageId)!;
      const summary = existing
        ? s.vault.open<string>(existing.payload)
        : await summarizeDocument(this.c, doc, this.download, this.ai);
      s.db.transaction(() => {
        s.db
          .prepare('INSERT OR IGNORE INTO document_analyses VALUES (?,?,?,?)')
          .run(
            job.id,
            s.vault.seal(summary),
            Date.now(),
            Date.now() + this.c.DOCUMENT_RETENTION_DAYS * 86400000,
          );
        notify(summary);
        s.finish(job.id, 'succeeded');
      })();
    } else if (a.intent === 'auto_reply') {
      const marker = `auto:${job.id}`;
      const previous = s.getSetting(marker);
      if (previous) {
        if (previous !== 'sent') s.finish(job.id, 'uncertain');
        return;
      }
      const now = Date.now(),
        day = new Date().toISOString().slice(0, 10);
      const state = s.db
        .prepare('SELECT * FROM auto_reply_state WHERE chat_id=?')
        .get(m.ref.chatId) as
        | {
            last_owner_activity_at: number;
            cooldown_until: number;
            day: string;
            sent_count: number;
          }
        | undefined;
      if (
        state &&
        (state.last_owner_activity_at + this.c.AUTO_REPLY_OWNER_PAUSE_MINUTES * 60000 > now ||
          state.cooldown_until > now ||
          (state.day === day && state.sent_count >= this.c.AUTO_REPLY_DAILY_LIMIT))
      ) {
        s.finish(job.id, 'denied');
        return;
      }
      const fact = ctx.knowledge.find((k) => k.id === d.knowledgeId && k.topic === d.topic);
      if (!fact) {
        s.finish(job.id, 'denied');
        return;
      }
      // Reserve before sending. A network ambiguity never triggers a blind resend.
      s.db
        .prepare(
          'INSERT INTO auto_reply_state(chat_id,cooldown_until,day,sent_count) VALUES (?,?,?,1) ON CONFLICT(chat_id) DO UPDATE SET cooldown_until=excluded.cooldown_until,day=excluded.day,sent_count=CASE WHEN auto_reply_state.day=excluded.day THEN auto_reply_state.sent_count+1 ELSE 1 END',
        )
        .run(m.ref.chatId, now + this.c.AUTO_REPLY_COOLDOWN_MINUTES * 60000, day);
      s.setSetting(marker, 'reserved');
      try {
        await this.autoSend(m, `Я ИИ-помощник. ${fact.answer}`, job.id);
        s.setSetting(marker, 'sent');
      } catch {
        s.setSetting(marker, 'uncertain');
        s.finish(job.id, 'uncertain');
        s.audit(job.id, 'auto_reply', 'uncertain');
        notify('Не удалось подтвердить автоответ. Повторная отправка заблокирована.');
      }
    }
  }
}
