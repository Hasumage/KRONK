import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Api } from 'grammy';
import type { Message, CallbackQuery } from 'grammy/types';
import type { BusinessSettings } from '../config/business.js';
import type { Settings } from '../config/settings.js';
import type { Store } from '../storage/database.js';
import type { OwnerOutbox } from '../services/owner-outbox.js';
import type { TaskCard } from '../tasks/model.js';
import { inNightWindow } from '../application/policy.js';
import { solveMath } from '../services/math.js';
import { loadReplyKnowledge, type ReplyKnowledge } from './knowledge.js';
import type { ReplyChat, ReplyJob, ReplyPayload, ReplyAnswer, ReplySelector } from './model.js';
type ReplyApi = Pick<Api, 'getBusinessConnection' | 'sendMessage' | 'answerCallbackQuery'>;
export class BusinessReplies {
  private knowledge: ReplyKnowledge | null;
  private knowledgeError: string | null = null;
  constructor(
    private readonly c: BusinessSettings,
    private readonly config: Settings,
    private readonly store: Store,
    private readonly api: ReplyApi,
    private readonly outbox: OwnerOutbox,
    private readonly selector: ReplySelector | null,
    knowledge?: ReplyKnowledge,
  ) {
    this.knowledge = knowledge ?? null;
    if (c.BUSINESS_REPLY_ENABLED) {
      if (!knowledge) this.reload(false);
      store.db
        .prepare("UPDATE reply_jobs SET state='pending' WHERE owner_id=? AND state='running'")
        .run(c.OWNER_TELEGRAM_ID);
      store.db
        .prepare("UPDATE reply_jobs SET state='uncertain' WHERE owner_id=? AND state='sending'")
        .run(c.OWNER_TELEGRAM_ID);
    }
  }
  private blocked() {
    return (
      !this.c.BUSINESS_REPLY_ENABLED ||
      this.c.BUSINESS_DRY_RUN ||
      this.store.getSetting('business.paused') === 'true' ||
      this.store.getSetting('reply.paused') === 'true'
    );
  }
  private inSchedule() {
    return (
      this.c.BUSINESS_REPLY_SCHEDULE === 'always' ||
      inNightWindow(
        new Date(),
        this.config.TIMEZONE,
        this.config.AUTO_REPLY_START,
        this.config.AUTO_REPLY_END,
      )
    );
  }
  private day() {
    return DateTime.now().setZone(this.config.TIMEZONE).toISODate()!;
  }
  private notify(key: string, card: TaskCard) {
    this.outbox.enqueue('reply:' + key, card);
  }
  private job(number: number): ReplyJob | null {
    return Number.isSafeInteger(number)
      ? ((this.store.db
          .prepare('SELECT * FROM reply_jobs WHERE number=? AND owner_id=?')
          .get(number, this.c.OWNER_TELEGRAM_ID) as ReplyJob) ?? null)
      : null;
  }
  private chat(number: number): ReplyChat | null {
    return Number.isSafeInteger(number)
      ? ((this.store.db
          .prepare('SELECT * FROM reply_chats WHERE number=? AND owner_id=?')
          .get(number, this.c.OWNER_TELEGRAM_ID) as ReplyChat) ?? null)
      : null;
  }
  private cancelChat(number: number) {
    const rows = this.store.db
      .prepare(
        "SELECT number FROM reply_jobs WHERE chat_number=? AND owner_id=? AND state IN ('pending','running','preview','ready')",
      )
      .all(number, this.c.OWNER_TELEGRAM_ID) as { number: number }[];
    for (const row of rows) {
      this.store.db
        .prepare("UPDATE reply_jobs SET state='cancelled',updated_at=? WHERE number=?")
        .run(Date.now(), row.number);
      this.store.db
        .prepare("UPDATE outbox SET status='expired' WHERE id=? AND status='pending'")
        .run('reply:preview:' + row.number);
    }
  }
  private eligible(chat: ReplyChat, generated = false): boolean {
    const today = this.day();
    return (
      !this.blocked() &&
      this.inSchedule() &&
      !!chat.enabled &&
      (this.c.BUSINESS_REPLY_SCOPE === 'all' || !!chat.explicit_allow) &&
      chat.paused_until <= Date.now() &&
      chat.owner_active_at + this.config.AUTO_REPLY_OWNER_PAUSE_MINUTES * 60000 <= Date.now() &&
      (generated || chat.cooldown_until <= Date.now()) &&
      (generated || chat.day !== today || chat.generated_count < this.config.AUTO_REPLY_DAILY_LIMIT)
    );
  }
  private async connection(m: Message): Promise<boolean> {
    const id = m.business_connection_id!;
    const cached = this.store.db
      .prepare('SELECT owner_id,enabled FROM business_connections WHERE id=?')
      .get(id) as { owner_id: string; enabled: number } | undefined;
    if (cached) return cached.owner_id === this.c.OWNER_TELEGRAM_ID && !!cached.enabled;
    try {
      const value = await this.api.getBusinessConnection(id);
      if (
        value.id !== id ||
        value.user.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
        !value.is_enabled
      )
        return false;
      this.store.db
        .prepare('INSERT OR REPLACE INTO business_connections VALUES (?,?,?,?,?)')
        .run(id, this.c.OWNER_TELEGRAM_ID, 1, Number(!!value.rights?.can_reply), Date.now());
      return true;
    } catch {
      this.store.audit(null, 'reply.ingest', 'connection_failed');
      return false;
    }
  }
  async receive(m: Message): Promise<void> {
    if (
      !this.c.BUSINESS_REPLY_ENABLED ||
      !m.business_connection_id ||
      m.chat.type !== 'private' ||
      !m.from ||
      m.from.is_bot ||
      m.sender_business_bot
    )
      return;
    const age = Date.now() / 1000 - m.date;
    if (age > this.c.BUSINESS_MATH_MAX_AGE_SECONDS || age < -30) return;
    const seen = createHash('sha256')
      .update(
        JSON.stringify([
          this.c.OWNER_TELEGRAM_ID,
          m.business_connection_id,
          m.chat.id,
          m.message_id,
        ]),
      )
      .digest('hex');
    if (
      this.store.db.prepare('SELECT id FROM reply_seen WHERE id=?').get(seen) ||
      !(await this.connection(m))
    )
      return;
    this.store.db.transaction(() => {
      if (
        !this.store.db
          .prepare('INSERT OR IGNORE INTO reply_seen VALUES (?,?,?)')
          .run(seen, this.c.OWNER_TELEGRAM_ID, Date.now()).changes
      )
        return;
      this.store.db
        .prepare(
          'INSERT OR IGNORE INTO reply_chats(owner_id,connection_id,chat_id,name,enabled) VALUES (?,?,?,?,?)',
        )
        .run(
          this.c.OWNER_TELEGRAM_ID,
          m.business_connection_id,
          m.chat.id.toString(),
          this.store.vault.seal((m.chat.first_name ?? 'Личный чат').slice(0, 80)),
          1,
        );
      const chat = this.store.db
        .prepare('SELECT * FROM reply_chats WHERE owner_id=? AND connection_id=? AND chat_id=?')
        .get(this.c.OWNER_TELEGRAM_ID, m.business_connection_id, m.chat.id.toString()) as ReplyChat;
      if (m.from!.id.toString() === this.c.OWNER_TELEGRAM_ID) {
        this.store.db
          .prepare(
            'UPDATE reply_chats SET owner_active_at=MAX(owner_active_at,?),revision=revision+1 WHERE number=?',
          )
          .run(Math.min(Date.now(), m.date * 1000), chat.number);
        this.cancelChat(chat.number);
        return;
      }
      const running = this.store.db
        .prepare(
          "SELECT * FROM reply_jobs WHERE chat_number=? AND state='running' ORDER BY number DESC LIMIT 1",
        )
        .get(chat.number) as ReplyJob | undefined;
      const obsolete = this.store.db
        .prepare(
          "SELECT number FROM reply_jobs WHERE chat_number=? AND state IN ('running','preview','ready')",
        )
        .all(chat.number) as { number: number }[];
      for (const row of obsolete) {
        this.store.db
          .prepare("UPDATE reply_jobs SET state='cancelled',updated_at=? WHERE number=?")
          .run(Date.now(), row.number);
        this.store.db
          .prepare("UPDATE outbox SET status='expired' WHERE id=? AND status='pending'")
          .run('reply:preview:' + row.number);
      }
      if (
        !m.text ||
        m.document ||
        m.photo ||
        !this.eligible(chat) ||
        !this.selector ||
        !this.knowledge?.active().length
      ) {
        this.cancelChat(chat.number);
        return;
      }
      if (
        /^(?:привет|здравствуй(?:те)?|спасибо|ок|окей|ага|доброе\s+утро|добрый\s+(?:день|вечер))[!.,\s🙂👍]*$/iu.test(
          m.text,
        ) ||
        solveMath(m.text).kind !== 'ignore'
      ) {
        this.cancelChat(chat.number);
        return;
      }
      const pending = this.store.db
        .prepare(
          "SELECT * FROM reply_jobs WHERE chat_number=? AND state='pending' ORDER BY number DESC LIMIT 1",
        )
        .get(chat.number) as ReplyJob | undefined;
      let payload: ReplyPayload = { messages: [] };
      if (pending) payload = this.store.vault.open<ReplyPayload>(pending.payload);
      else {
        const previous = running;
        if (previous && previous.expires_at > Date.now())
          payload = this.store.vault.open<ReplyPayload>(previous.payload);
        this.cancelChat(chat.number);
      }
      payload.messages.push({ id: m.message_id, text: m.text, date: m.date });
      if (
        payload.messages.length > 8 ||
        payload.messages.reduce((n, p) => n + p.text.length, 0) > 3000
      ) {
        this.cancelChat(chat.number);
        this.store.audit(null, 'reply.ingest', 'burst_limit');
        return;
      }
      const available = Date.now() + this.c.BUSINESS_REPLY_DEBOUNCE_SECONDS * 1000,
        expires = m.date * 1000 + this.c.BUSINESS_MATH_MAX_AGE_SECONDS * 1000;
      if (pending) {
        this.store.db
          .prepare(
            'UPDATE reply_jobs SET payload=?,available_at=?,expires_at=?,updated_at=? WHERE number=?',
          )
          .run(
            this.store.vault.seal(payload),
            Math.min(available, pending.created_at + 30000),
            expires,
            Date.now(),
            pending.number,
          );
        return;
      }
      const day = new Date().toISOString().slice(0, 10);
      this.store.db.prepare('INSERT OR IGNORE INTO daily_usage(day) VALUES (?)').run(day);
      if (
        !this.store.db
          .prepare('UPDATE daily_usage SET messages=messages+1 WHERE day=? AND messages<?')
          .run(day, this.config.MAX_MESSAGES_PER_DAY).changes
      ) {
        this.store.audit(null, 'reply.ingest', 'daily_limit');
        return;
      }
      this.store.db
        .prepare(
          'INSERT INTO reply_jobs(id,owner_id,chat_number,payload,chat_revision,available_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(
          seen,
          this.c.OWNER_TELEGRAM_ID,
          chat.number,
          this.store.vault.seal(payload),
          chat.revision,
          available,
          expires,
          Date.now(),
          Date.now(),
        );
    })();
  }
  private current(job: ReplyJob, expected: readonly string[], generated = false): ReplyChat | null {
    const fresh = this.job(job.number),
      chat = this.chat(job.chat_number);
    if (
      !fresh ||
      !expected.includes(fresh.state) ||
      fresh.expires_at <= Date.now() ||
      !chat ||
      chat.revision !== job.chat_revision ||
      !this.eligible(chat, generated)
    )
      return null;
    if (job.knowledge_hash && job.knowledge_hash !== this.knowledge?.hash) return null;
    if (job.answer) {
      const answer = this.store.vault.open<ReplyAnswer>(job.answer),
        active = new Set(this.knowledge?.active().map((k) => k.id));
      if (answer.entryIds.some((id) => !active.has(id))) return null;
    }
    return chat;
  }
  async tick(): Promise<void> {
    if (this.blocked() || !this.inSchedule() || !this.selector || !this.knowledge?.active().length)
      return;
    this.expire();
    if (this.c.BUSINESS_REPLY_MODE === 'live') {
      const ready = this.store.db
        .prepare(
          "SELECT number FROM reply_jobs WHERE owner_id=? AND state='ready' AND available_at<=? ORDER BY number LIMIT 1",
        )
        .get(this.c.OWNER_TELEGRAM_ID, Date.now()) as { number: number } | undefined;
      if (ready) {
        await this.send(ready.number, false);
        return;
      }
    }
    const job = this.store.db.transaction(() => {
      const row = this.store.db
        .prepare(
          "SELECT * FROM reply_jobs WHERE owner_id=? AND state='pending' AND available_at<=? ORDER BY number LIMIT 1",
        )
        .get(this.c.OWNER_TELEGRAM_ID, Date.now()) as ReplyJob | undefined;
      if (!row) return null;
      if (!this.current(row, ['pending'])) {
        this.store.db
          .prepare("UPDATE reply_jobs SET state='ignored',updated_at=? WHERE number=?")
          .run(Date.now(), row.number);
        return null;
      }
      this.store.db
        .prepare("UPDATE reply_jobs SET state='running',attempts=attempts+1 WHERE number=?")
        .run(row.number);
      return { ...row, attempts: row.attempts + 1 };
    })();
    if (!job) return;
    try {
      const payload = this.store.vault.open<ReplyPayload>(job.payload),
        hash = this.knowledge.hash;
      const candidates = this.knowledge.candidates(
        payload.messages.map((m) => m.text).join('\n'),
        Math.max(0, this.config.MAX_CONTEXT_CHARS - 4000),
      );
      if (!candidates.length) {
        this.ignore(job, 'no_knowledge');
        return;
      }
      const result = await this.selector.select(
        payload.messages.map((m) => m.text),
        candidates,
      );
      const chat = this.current(job, ['running']);
      if (!chat || hash !== this.knowledge?.hash) {
        this.ignore(job, 'stale');
        return;
      }
      const ids = [...new Set(result.entryIds)],
        entries = ids.map((id) => candidates.find((e) => e.id === id));
      if (
        result.kind !== 'answer' ||
        result.reason !== 'work_question' ||
        result.confidence < 0.98 ||
        !Number.isFinite(result.confidence) ||
        result.confidence > 1 ||
        !ids.length ||
        ids.length > 2 ||
        entries.some((e) => !e) ||
        new Set(entries.map((e) => e!.topic)).size !== 1
      ) {
        this.ignore(job, 'no_grounding');
        return;
      }
      const active = new Set(this.knowledge.active().map((e) => e.id));
      if (ids.some((id) => !active.has(id))) {
        this.ignore(job, 'expired_knowledge');
        return;
      }
      const answer: ReplyAnswer = {
        text: 'Я ИИ-помощник.\n\n' + entries.map((e) => e!.answer).join('\n\n'),
        entryIds: ids,
        sources: entries.map((e) => e!.source),
      };
      if (answer.text.length > 2400) {
        this.ignore(job, 'answer_limit');
        return;
      }
      this.store.db.transaction(() => {
        const today = this.day(),
          state = this.c.BUSINESS_REPLY_MODE === 'preview' ? 'preview' : 'ready';
        this.store.db
          .prepare(
            'UPDATE reply_jobs SET state=?,answer=?,knowledge_hash=?,expires_at=?,updated_at=? WHERE number=?',
          )
          .run(
            state,
            this.store.vault.seal(answer),
            hash,
            Date.now() + this.c.BUSINESS_REPLY_PREVIEW_TTL_MINUTES * 60000,
            Date.now(),
            job.number,
          );
        this.store.db
          .prepare(
            'UPDATE reply_chats SET cooldown_until=?,day=?,generated_count=CASE WHEN day=? THEN generated_count+1 ELSE 1 END WHERE number=?',
          )
          .run(
            Date.now() + this.config.AUTO_REPLY_COOLDOWN_MINUTES * 60000,
            today,
            today,
            chat.number,
          );
        if (state === 'preview')
          this.notify('preview:' + job.number, this.card(this.job(job.number)!));
        this.store.audit(job.id, 'reply.select', state);
      })();
    } catch (error) {
      const fresh = this.job(job.number);
      if (fresh?.state !== 'running') return;
      const code = error instanceof Error ? error.message : '';
      const terminal =
        job.attempts >= 3 || code === 'API_BUDGET_EXCEEDED' || code === 'AI_CONTEXT_LIMIT_EXCEEDED';
      this.store.db
        .prepare('UPDATE reply_jobs SET state=?,available_at=?,updated_at=? WHERE number=?')
        .run(
          terminal ? 'failed' : 'pending',
          Date.now() + 2000 * 2 ** job.attempts,
          Date.now(),
          job.number,
        );
      this.store.audit(job.id, 'reply.select', terminal ? 'failed' : 'retry');
    }
  }
  private ignore(job: ReplyJob, reason: string) {
    this.store.db
      .prepare(
        "UPDATE reply_jobs SET state='ignored',updated_at=? WHERE number=? AND state IN ('pending','running')",
      )
      .run(Date.now(), job.number);
    this.store.audit(job.id, 'reply.select', reason);
  }
  private card(job: ReplyJob): TaskCard {
    const chat = this.chat(job.chat_number)!,
      payload = this.store.vault.open<ReplyPayload>(job.payload),
      answer = this.store.vault.open<ReplyAnswer>(job.answer!);
    const canSend = job.state === 'preview' && job.expires_at > Date.now();
    return {
      text: `💬 Вариант ответа #${job.number}\nЧат #${chat.number}: ${this.store.vault.open<string>(chat.name)}\n\nВопрос:\n${payload.messages
        .map((m) => m.text)
        .join('\n')
        .slice(
          0,
          600,
        )}\n\n${answer.text}\n\nОснование: ${answer.sources.join('; ').slice(0, 250)}\nСтатус: ${job.state}. Действует до ${new Intl.DateTimeFormat('ru-RU', { timeStyle: 'short', timeZone: this.config.TIMEZONE }).format(job.expires_at)}.`,
      ...(canSend
        ? {
            replyMarkup: {
              inline_keyboard: [
                [
                  { text: 'Отправить этот ответ', callback_data: 'reply:send:' + job.number },
                  { text: 'Пропустить', callback_data: 'reply:skip:' + job.number },
                ],
                [{ text: 'Пауза в этом чате', callback_data: 'reply:pause:' + chat.number }],
              ],
            },
          }
        : {}),
    };
  }
  private async send(number: number, manual: boolean): Promise<string> {
    const job = this.job(number);
    if (!job?.answer || (!manual && this.c.BUSINESS_REPLY_MODE !== 'live'))
      return 'Отправка недоступна.';
    const expected = manual ? ['preview'] : ['ready'];
    let chat = this.current(job, expected, true);
    if (!chat) return 'Ответ устарел, чат на паузе или модуль выключен.';
    if (job.available_at > Date.now()) return 'Telegram попросил подождать. Попробуйте позже.';
    try {
      const connection = await this.api.getBusinessConnection(chat.connection_id);
      if (
        connection.id !== chat.connection_id ||
        connection.user.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
        !connection.is_enabled ||
        !connection.rights?.can_reply
      ) {
        this.store.db
          .prepare("UPDATE reply_jobs SET state='failed',updated_at=? WHERE number=?")
          .run(Date.now(), number);
        return 'Подключение или право ответа недоступны.';
      }
    } catch {
      this.store.db
        .prepare(
          'UPDATE reply_jobs SET attempts=attempts+1,available_at=?,state=CASE WHEN attempts>=3 THEN ? ELSE state END WHERE number=?',
        )
        .run(Date.now() + 30000, 'failed', number);
      return 'Не удалось проверить подключение.';
    }
    chat = this.current(job, expected, true);
    if (!chat) return 'Диалог изменился; отправка отменена.';
    if (
      !this.store.db
        .prepare("UPDATE reply_jobs SET state='sending',updated_at=? WHERE number=? AND state=?")
        .run(Date.now(), number, manual ? 'preview' : 'ready').changes
    )
      return 'Этот ответ уже обработан.';
    const answer = this.store.vault.open<ReplyAnswer>(job.answer),
      payload = this.store.vault.open<ReplyPayload>(job.payload),
      last = payload.messages.at(-1)!;
    try {
      await this.api.sendMessage(chat.chat_id, answer.text, {
        business_connection_id: chat.connection_id,
        reply_parameters: { message_id: last.id, allow_sending_without_reply: false },
        link_preview_options: { is_disabled: true },
      });
      this.store.db
        .prepare("UPDATE reply_jobs SET state='sent',updated_at=? WHERE number=?")
        .run(Date.now(), number);
      this.store.audit(job.id, 'reply.send', 'sent');
      return 'Ответ отправлен.';
    } catch (error) {
      const e = error as { error_code?: number; parameters?: { retry_after?: number } },
        retry = e.error_code === 429 && e.parameters?.retry_after;
      const state = retry
        ? manual
          ? 'preview'
          : 'ready'
        : e.error_code && e.error_code < 500
          ? 'failed'
          : 'uncertain';
      this.store.db
        .prepare('UPDATE reply_jobs SET state=?,available_at=?,updated_at=? WHERE number=?')
        .run(state, Date.now() + (retry ? retry * 1000 : 0), Date.now(), number);
      this.store.audit(job.id, 'reply.send', state);
      if (state === 'uncertain')
        this.notify('uncertain:' + number, {
          text: `Не удалось подтвердить отправку автоответа #${number}. Проверьте чат #${chat.number}: повторная отправка заблокирована.`,
        });
      return retry
        ? 'Telegram попросил подождать; ответ пока не отправлен.'
        : state === 'uncertain'
          ? 'Отправка не подтверждена. Проверьте диалог.'
          : 'Telegram отклонил отправку.';
    }
  }
  async callback(query: CallbackQuery): Promise<boolean> {
    if (!query.data?.startsWith('reply:')) return false;
    if (
      query.from.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
      query.message?.chat.type !== 'private' ||
      query.message.chat.id.toString() !== this.c.OWNER_TELEGRAM_ID
    )
      return true;
    const [, action, raw] = query.data.split(':'),
      number = Number(raw);
    let text = 'Неизвестное действие.';
    if (!this.c.BUSINESS_REPLY_ENABLED) text = 'Автоответы выключены.';
    else if (action === 'send') {
      await this.api
        .answerCallbackQuery(query.id, { text: 'Проверяю актуальность ответа…' })
        .catch(() => {});
      text = await this.send(number, true);
      this.notify('send-result:' + query.id, { text });
      return true;
    } else if (action === 'skip') {
      const job = this.job(number);
      if (job?.state === 'preview') {
        this.store.db
          .prepare("UPDATE reply_jobs SET state='dismissed',updated_at=? WHERE number=?")
          .run(Date.now(), number);
        text = 'Вариант пропущен.';
      } else text = 'Вариант уже закрыт.';
    } else if (action === 'pause' && this.chat(number)) {
      this.pauseChat(number, true);
      text = 'Чат приостановлен.';
    }
    await this.api.answerCallbackQuery(query.id, { text: text.slice(0, 180) }).catch(() => {});
    return true;
  }
  private pauseChat(number: number, pause: boolean) {
    this.store.db.transaction(() => {
      this.store.db
        .prepare(
          'UPDATE reply_chats SET paused_until=?,owner_active_at=CASE WHEN ? THEN owner_active_at ELSE 0 END,revision=revision+1 WHERE number=? AND owner_id=?',
        )
        .run(pause ? 8640000000000000 : 0, pause ? 1 : 0, number, this.c.OWNER_TELEGRAM_ID);
      this.cancelChat(number);
    })();
  }
  ownerMessage(m: Message): boolean {
    if (
      m.business_connection_id ||
      m.chat.type !== 'private' ||
      m.chat.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
      m.from?.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
      !m.text
    )
      return false;
    const [raw = '', arg] = m.text.trim().split(/\s+/),
      command = raw.split('@')[0],
      number = Number(arg),
      key = 'command:' + m.message_id;
    if (
      ![
        '/replies',
        '/reply',
        '/reply_pause',
        '/reply_resume',
        '/reply_block',
        '/reply_allow',
        '/reply_reload',
      ].includes(command ?? '')
    )
      return false;
    let text = this.status();
    if (command === '/replies') {
      const chats = this.store.db
        .prepare(
          'SELECT number,enabled,explicit_allow,paused_until FROM reply_chats WHERE owner_id=? ORDER BY number DESC LIMIT 10',
        )
        .all(this.c.OWNER_TELEGRAM_ID) as {
        number: number;
        enabled: number;
        explicit_allow: number;
        paused_until: number;
      }[];
      text +=
        '\n\nЧаты: ' +
        (chats
          .map(
            (c) =>
              `#${c.number} ${!c.enabled ? 'исключён' : this.c.BUSINESS_REPLY_SCOPE === 'selected' && !c.explicit_allow ? 'не выбран' : c.paused_until > Date.now() ? 'пауза' : 'разрешён'}`,
          )
          .join(', ') || 'пока нет') +
        '\n/reply номер — вариант ответа\n/reply_pause all — общая пауза\n/reply_pause номер — пауза чата\n/reply_resume номер — возобновить чат\n/reply_block номер — исключить\n/reply_allow номер — разрешить\n/reply_reload — перечитать базу знаний';
    } else if (command === '/reply') {
      const job = this.job(number);
      if (job?.answer && job.payload) {
        this.notify(key, this.card(job));
        return true;
      }
      text = 'Вариант ответа не найден.';
    } else if (command === '/reply_reload') {
      if (!this.c.BUSINESS_REPLY_ENABLED)
        text = 'Модуль выключен. База знаний будет прочитана при явном включении.';
      else {
        this.reload();
        text = this.status();
      }
    } else if ((command === '/reply_pause' || command === '/reply_resume') && arg === 'all') {
      const pause = command === '/reply_pause';
      this.store.setSetting('reply.paused', pause ? 'true' : 'false');
      if (pause)
        for (const row of this.store.db
          .prepare('SELECT number FROM reply_chats WHERE owner_id=?')
          .all(this.c.OWNER_TELEGRAM_ID) as { number: number }[])
          this.cancelChat(row.number);
      text = pause ? 'Автоответы приостановлены.' : 'Общая пауза снята. ' + this.status();
    } else if (this.chat(number)) {
      if (command === '/reply_block' || command === '/reply_allow') {
        this.store.db
          .prepare(
            'UPDATE reply_chats SET enabled=?,explicit_allow=?,revision=revision+1 WHERE number=? AND owner_id=?',
          )
          .run(
            command === '/reply_allow' ? 1 : 0,
            command === '/reply_allow' ? 1 : 0,
            number,
            this.c.OWNER_TELEGRAM_ID,
          );
        this.cancelChat(number);
        text =
          command === '/reply_allow'
            ? 'Чат разрешён; глобальный выключатель продолжает действовать.'
            : 'Чат исключён из автоответов.';
      } else {
        this.pauseChat(number, command === '/reply_pause');
        text =
          command === '/reply_pause'
            ? 'Чат приостановлен.'
            : 'Чат возобновлён; глобальный выключатель продолжает действовать.';
      }
    } else text = 'Укажите номер чата из /replies или all для общей паузы.';
    this.notify(key, { text });
    return true;
  }
  private reload(invalidate = true) {
    try {
      this.knowledge = loadReplyKnowledge(this.c.BUSINESS_REPLY_KNOWLEDGE_PATH);
      this.knowledgeError = null;
    } catch {
      this.knowledge = null;
      this.knowledgeError = 'База знаний отсутствует или не прошла проверку.';
    }
    if (invalidate)
      for (const row of this.store.db
        .prepare('SELECT number FROM reply_chats WHERE owner_id=?')
        .all(this.c.OWNER_TELEGRAM_ID) as { number: number }[])
        this.cancelChat(row.number);
  }
  status() {
    return `Рабочие автоответы: ${this.c.BUSINESS_REPLY_ENABLED ? 'включены' : 'выключены'}\nРежим: ${this.c.BUSINESS_REPLY_MODE === 'preview' ? 'варианты только владельцу' : 'автоматическая отправка'}\nОхват: ${this.c.BUSINESS_REPLY_SCOPE === 'all' ? 'все доступные боту личные чаты, включая новые' : 'выбранные чаты'}\nРасписание: ${this.c.BUSINESS_REPLY_SCHEDULE === 'always' ? 'круглосуточно' : this.config.AUTO_REPLY_START + '–' + this.config.AUTO_REPLY_END + ' (' + this.config.TIMEZONE + ')'}\nЗаписей в базе: ${this.knowledge?.active().length ?? 0}${this.knowledgeError ? '\n' + this.knowledgeError : ''}${this.selector ? '' : '\nOpenAI не настроен.'}`;
  }
  private expire() {
    const rows = this.store.db
      .prepare(
        "SELECT number FROM reply_jobs WHERE owner_id=? AND state IN ('pending','preview','ready') AND expires_at<=?",
      )
      .all(this.c.OWNER_TELEGRAM_ID, Date.now()) as { number: number }[];
    for (const row of rows) {
      this.store.db
        .prepare("UPDATE reply_jobs SET state='expired',updated_at=? WHERE number=?")
        .run(Date.now(), row.number);
      this.store.db
        .prepare("UPDATE outbox SET status='expired' WHERE id=? AND status='pending'")
        .run('reply:preview:' + row.number);
    }
  }
  prune() {
    if (!this.c.BUSINESS_REPLY_ENABLED) return;
    this.expire();
    const cutoff = Date.now() - this.c.BUSINESS_RETENTION_DAYS * 86400000;
    this.store.db
      .prepare(
        "UPDATE reply_jobs SET state=CASE WHEN state IN ('pending','running','preview','ready') THEN 'expired' ELSE state END,payload='',answer=NULL WHERE owner_id=? AND created_at<? AND state!='sending'",
      )
      .run(this.c.OWNER_TELEGRAM_ID, cutoff);
  }
}
