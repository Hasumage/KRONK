import type { Message } from 'grammy/types';
import type { BusinessSettings } from '../config/business.js';
import { settings, type Settings } from '../config/settings.js';
import type { Store } from '../storage/database.js';
import type { AI } from '../adapters/ai.js';
import type { Calendar } from '../adapters/calendar.js';
import { emptyAnalysis, type InputMessage } from '../domain/schema.js';
import { operationKey } from '../storage/database.js';
import { Worker } from '../application/worker.js';
import { Registrations } from './registrations.js';
import type { BusinessApi } from './business-math.js';
import { hasCalendarCommitment } from '../domain/calendar-intent.js';

export function businessCalendarSettings(
  business: BusinessSettings,
  env: NodeJS.ProcessEnv = process.env,
): Settings {
  const config = settings({
    ...env,
    MODE: 'mock',
    OWNER_TELEGRAM_ID: business.OWNER_TELEGRAM_ID,
    ENCRYPTION_KEY: business.BUSINESS_ENCRYPTION_KEY,
    DATABASE_PATH: business.BUSINESS_DATABASE_PATH,
    DRY_RUN: business.BUSINESS_DRY_RUN ? 'true' : 'false',
    CALENDAR_ENABLED: 'true',
    TASKS_ENABLED: 'false',
    AUTO_REPLY_ENABLED: 'false',
    DOCUMENTS_ENABLED: 'false',
    REGISTRATIONS_ENABLED: 'false',
  });
  // This transport needs no MTProto credentials. Production adapters are wired explicitly.
  return { ...config, MODE: 'live' };
}
export function missingCalendarSettings(c: Settings, store: Store): string[] {
  const missing: string[] = [];
  for (const name of [
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OPENAI_INPUT_USD_PER_MILLION',
    'OPENAI_OUTPUT_USD_PER_MILLION',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ] as const)
    if (!c[name]) missing.push(name);
  if (!store.secret('google')) missing.push('Google OAuth (business:oauth)');
  return missing;
}
export interface CalendarDependencies {
  ai: AI;
  calendar: Calendar;
}
export class BusinessCalendar {
  private readonly worker: Worker | null;
  constructor(
    private readonly c: BusinessSettings,
    private readonly config: Settings,
    private readonly store: Store,
    private readonly api: BusinessApi,
    dependencies: CalendarDependencies | null,
    private readonly missing: readonly string[] = [],
  ) {
    const scopedAI: AI | null = dependencies
      ? {
          classify: async (context) => {
            const result = await dependencies.ai.classify(context);
            return result.intent === 'calendar.create' ? result : emptyAnalysis();
          },
          summarize: (text) => dependencies.ai.summarize(text),
        }
      : null;
    this.worker =
      dependencies && scopedAI
        ? new Worker(
            config,
            store,
            scopedAI,
            dependencies.calendar,
            async () => {
              throw new Error('DOCUMENTS_DISABLED');
            },
            new Registrations(config, store),
            async () => {
              throw new Error('AUTO_REPLY_DISABLED');
            },
          )
        : null;
  }
  async receive(m: Message): Promise<void> {
    if (
      !this.c.BUSINESS_CALENDAR_ENABLED ||
      this.store.getSetting('business.paused') === 'true' ||
      m.chat.type !== 'private' ||
      !m.business_connection_id ||
      !m.from ||
      m.from.is_bot ||
      m.sender_business_bot
    )
      return;
    const age = Date.now() / 1000 - m.date;
    if (age < -30 || age > this.c.BUSINESS_RETENTION_DAYS * 86400) return;
    const row = this.store.db
      .prepare('SELECT owner_id,enabled FROM business_connections WHERE id=?')
      .get(m.business_connection_id) as { owner_id: string; enabled: number } | undefined;
    if (row) {
      if (row.owner_id !== this.c.OWNER_TELEGRAM_ID || !row.enabled) return;
    } else {
      let connection;
      try {
        connection = await this.api.getBusinessConnection(m.business_connection_id);
      } catch {
        this.store.audit(null, 'calendar.ingest', 'connection_lookup_failed');
        return;
      }
      if (
        connection.id !== m.business_connection_id ||
        connection.user.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
        !connection.is_enabled
      )
        return;
      this.store.db
        .prepare('INSERT OR REPLACE INTO business_connections VALUES (?,?,?,?,?)')
        .run(
          connection.id,
          this.c.OWNER_TELEGRAM_ID,
          1,
          Number(!!connection.rights?.can_reply),
          Date.now(),
        );
    }
    const trigger = this.map(m);
    if (!trigger) return;
    const parent = m.reply_to_message;
    if (parent && parent.chat.id === m.chat.id && !parent.sender_business_bot) {
      const mapped = this.map(parent);
      if (mapped) this.store.remember(mapped, this.config.MAX_CONTEXT_CHARS);
    }
    this.store.remember(trigger, this.config.MAX_CONTEXT_CHARS);
    if (trigger.direction !== 'outgoing' || age > this.c.BUSINESS_MATH_MAX_AGE_SECONDS) return;
    if (!hasCalendarCommitment(trigger.text)) return;
    if (!this.worker) {
      // This is only a setup-notice filter, not permission to create an event.
      if (hasCalendarCommitment(trigger.text))
        this.store.notify(`${operationKey(trigger)}:setup`, this.setupMessage());
      return;
    }
    this.worker.ingest(trigger);
  }
  private map(m: Message): InputMessage | null {
    if (!m.from || !m.text) return null;
    const ref = {
      accountId: this.c.OWNER_TELEGRAM_ID,
      chatId: m.chat.id.toString(),
      messageId: m.message_id.toString(),
    };
    return {
      ref,
      senderId: m.from.id.toString(),
      direction: m.from.id.toString() === this.c.OWNER_TELEGRAM_ID ? 'outgoing' : 'incoming',
      text: m.text,
      sentAt: new Date(m.date * 1000).toISOString(),
      replyTo:
        m.reply_to_message && m.reply_to_message.chat.id === m.chat.id
          ? { ...ref, messageId: m.reply_to_message.message_id.toString() }
          : null,
      generatedByAssistant: !!m.sender_business_bot,
      attachment: null,
    };
  }
  ownerMessage(m: Message): boolean {
    if (
      m.business_connection_id ||
      m.chat.type !== 'private' ||
      m.from?.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
      !m.text
    )
      return false;
    const command = m.text.trim().split(/\s+/)[0]?.split('@')[0];
    if (command === '/calendar') {
      this.store.notify(`calendar:status:${m.message_id}`, this.status());
      return true;
    }
    let id: string | undefined,
      text = m.text;
    if (command === '/clarify') {
      const [, operation, ...rest] = m.text.trim().split(/\s+/);
      id = operation;
      text = rest.join(' ');
    } else if (m.reply_to_message) {
      const row = this.store.db
        .prepare('SELECT id FROM outbox WHERE telegram_message_id=?')
        .get(m.reply_to_message.message_id.toString()) as { id: string } | undefined;
      id = row?.id.split(':')[0];
    } else return false;
    if (!id || !text || text.length > this.config.MAX_CONTEXT_CHARS) return false;
    const pending = this.store.db
      .prepare("SELECT id FROM processed_messages WHERE id=? AND status='awaiting_input'")
      .get(id);
    if (!pending) return false;
    if (!this.worker || !this.c.BUSINESS_CALENDAR_ENABLED) {
      this.store.notify(`calendar:clarify:${m.message_id}`, this.setupMessage());
      return true;
    }
    if (this.store.getSetting('business.paused') === 'true') {
      this.store.notify(
        `calendar:clarify:${m.message_id}`,
        'Обработка на паузе. Возобновите командой /resume.',
      );
      return true;
    }
    if (this.store.clarify(id, text))
      this.store.notify(
        `calendar:ack:${m.message_id}`,
        'Уточнение принято. Сообщу, когда событие будет записано в календарь.',
      );
    return true;
  }
  async tick(): Promise<void> {
    if (this.c.BUSINESS_CALENDAR_ENABLED && this.store.getSetting('business.paused') !== 'true')
      await this.worker?.tick();
  }
  status(): string {
    return !this.c.BUSINESS_CALENDAR_ENABLED
      ? 'Календарь: выключен.'
      : this.worker
        ? 'Календарь: подключён\nСоздание событий — только по твоей команде.'
        : 'Календарь: ещё не подключён.\n' + this.setupMessage();
  }
  private setupMessage(): string {
    return `Событие пока не создано: календарь ещё не подключён.\nНужно настроить: ${this.missing.join(', ') || 'OpenAI и Google Calendar'}.\nИнструкция: docs/calendar-setup.md. После подключения напишите новую команду в переписке.`;
  }
}
