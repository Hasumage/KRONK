import { createHash } from 'node:crypto';
import type { Api } from 'grammy';
import type { BusinessConnection, Message, Update } from 'grammy/types';
import type { BusinessSettings } from '../config/business.js';
import type { Store } from '../storage/database.js';
import { solveMath } from './math.js';
import type { BusinessCalendar } from './business-calendar.js';
import type { BusinessTasks } from '../tasks/service.js';
import type { BusinessDocuments } from '../documents/service.js';
import type { BusinessReplies } from '../replies/service.js';
import type { BusinessExtension } from '../extensions/business.js';
import type { BusinessJokes } from '../jokes/service.js';

export type BusinessApi = Pick<Api, 'getBusinessConnection' | 'sendMessage'>;
export class BusinessMath {
  constructor(
    private readonly c: BusinessSettings,
    private readonly store: Store,
    private readonly api: BusinessApi,
    private readonly calendar?: BusinessCalendar,
    private readonly tasks?: BusinessTasks,
    private readonly documents?: BusinessDocuments,
    private readonly replies?: BusinessReplies,
    private readonly jokes?: BusinessJokes,
    private readonly extensions: BusinessExtension[] = [],
  ) {
    store.db.prepare("UPDATE business_math SET status='uncertain' WHERE status='sending'").run();
  }
  connection(connection: BusinessConnection): void {
    if (connection.user.id.toString() !== this.c.OWNER_TELEGRAM_ID) return;
    this.store.db
      .prepare(
        'INSERT INTO business_connections VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,enabled=excluded.enabled,can_reply=excluded.can_reply,updated_at=excluded.updated_at',
      )
      .run(
        connection.id,
        this.c.OWNER_TELEGRAM_ID,
        Number(connection.is_enabled),
        Number(!!connection.rights?.can_reply),
        Date.now(),
      );
    this.store.audit(
      null,
      'business.connection',
      connection.is_enabled
        ? connection.rights?.can_reply
          ? 'enabled'
          : 'reply_permission_missing'
        : 'disabled',
    );
  }
  async handle(update: Update): Promise<void> {
    if (update.callback_query)
      for (const extension of this.extensions)
        if (await extension.callback?.(update.callback_query)) return;
    if (update.callback_query && (await this.tasks?.callback(update.callback_query))) return;
    if (update.callback_query && (await this.replies?.callback(update.callback_query))) return;
    if (update.business_connection) this.connection(update.business_connection);
    if (update.business_message) {
      let claimed = false;
      for (const extension of this.extensions)
        if (await extension.receive?.(update.business_message)) claimed = true;
      if (!claimed) await this.replies?.receive(update.business_message);
      if (await this.jokes?.receive(update.business_message)) return;
      await this.documents?.receive(update.business_message);
      await this.calendar?.receive(update.business_message);
      await this.tasks?.receive(update.business_message);
      if (!claimed) await this.message(update.business_message);
    }
    if (update.message) await this.ownerMessage(update.message);
  }
  private allowed(): boolean {
    return this.c.BUSINESS_MATH_ENABLED && this.store.getSetting('business.paused') !== 'true';
  }
  private async message(m: Message): Promise<void> {
    if (
      !this.allowed() ||
      m.chat.type !== 'private' ||
      !m.text ||
      !m.business_connection_id ||
      !m.from ||
      m.from.is_bot ||
      m.from.id.toString() === this.c.OWNER_TELEGRAM_ID ||
      m.sender_business_bot
    )
      return;
    const age = Date.now() / 1000 - m.date;
    if (age > this.c.BUSINESS_MATH_MAX_AGE_SECONDS || age < -30) return;
    const result = solveMath(m.text);
    if (result.kind === 'ignore') return;
    const id = this.key(m.business_connection_id, m);
    if (this.exists(id)) return;
    // Validate the current connection, not only an old cached BusinessConnection update.
    let connection: BusinessConnection;
    try {
      connection = await this.api.getBusinessConnection(m.business_connection_id);
    } catch {
      this.store.audit(id, 'math.reply', 'connection_lookup_failed');
      return;
    }
    if (
      connection.user.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
      connection.id !== m.business_connection_id
    )
      return;
    this.connection(connection);
    if (!connection.is_enabled || !connection.rights?.can_reply || !this.allowed()) return;
    const count = this.store.db
      .prepare(
        "SELECT count(*) AS n FROM business_math WHERE connection_id=? AND chat_id=? AND created_at>? AND status IN ('sending','sent','uncertain')",
      )
      .get(connection.id, m.chat.id.toString(), Date.now() - 60000) as { n: number };
    if (count.n >= this.c.BUSINESS_MATH_PER_CHAT_PER_MINUTE) {
      this.store.audit(id, 'math.reply', 'chat_rate_limit');
      return;
    }
    const text = result.text;
    await this.send(id, connection.id, m, text);
  }
  private key(connection: string, m: Message): string {
    return createHash('sha256')
      .update(JSON.stringify([this.c.OWNER_TELEGRAM_ID, connection, m.chat.id, m.message_id]))
      .digest('hex');
  }
  private exists(id: string): boolean {
    return !!this.store.db.prepare('SELECT id FROM business_math WHERE id=?').get(id);
  }
  private async send(id: string, connection: string, m: Message, text: string): Promise<void> {
    const status = this.c.BUSINESS_DRY_RUN ? 'dry_run' : 'sending';
    const inserted = this.store.db
      .prepare(
        'INSERT OR IGNORE INTO business_math(id,connection_id,chat_id,message_id,status,answer,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        id,
        connection,
        m.chat.id.toString(),
        m.message_id,
        status,
        this.store.vault.seal(text),
        Date.now(),
      ).changes;
    if (!inserted || this.c.BUSINESS_DRY_RUN) return;
    try {
      const sent = await this.api.sendMessage(m.chat.id, text, {
        ...(connection !== 'direct' ? { business_connection_id: connection } : {}),
        reply_parameters: { message_id: m.message_id, allow_sending_without_reply: false },
        link_preview_options: { is_disabled: true },
      });
      this.store.db
        .prepare("UPDATE business_math SET status='sent',sent_message_id=? WHERE id=?")
        .run(sent.message_id, id);
      this.store.audit(id, 'math.reply', 'sent');
    } catch (error) {
      // Bot API has no idempotency key. Do not duplicate a reply after an ambiguous timeout.
      const rejected = typeof error === 'object' && error !== null && 'error_code' in error;
      this.store.db
        .prepare('UPDATE business_math SET status=? WHERE id=?')
        .run(rejected ? 'rejected' : 'uncertain', id);
      this.store.audit(id, 'math.reply', rejected ? 'telegram_rejected' : 'uncertain');
    }
  }
  private async ownerMessage(m: Message): Promise<void> {
    if (await this.jokes?.receive(m)) return;
    for (const extension of this.extensions) if (await extension.ownerMessage?.(m)) return;
    if (this.replies?.ownerMessage(m)) return;
    if (await this.tasks?.ownerMessage(m)) return;
    if (this.documents?.ownerMessage(m)) return;
    if (this.calendar?.ownerMessage(m)) return;
    if (
      m.chat.type !== 'private' ||
      m.from?.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
      !m.text ||
      m.business_connection_id
    )
      return;
    const id = this.key('direct', m);
    if (this.exists(id)) return;
    const command = m.text.trim().split(/\s+/)[0]?.split('@')[0];
    let text: string;
    if (command === '/pause') {
      this.store.setSetting('business.paused', 'true');
      text = 'Обработка сообщений приостановлена.';
    } else if (command === '/resume') {
      this.store.setSetting('business.paused', 'false');
      text = 'Обработка сообщений возобновлена.';
    } else if (command === '/status') text = this.status();
    else if (command === '/start' || command === '/help')
      text =
        'KRONK: математика, календарь, задачи и документы.\nМатематика: 125 × 48, x+10=2x.\nКалендарь: «занесу в календарь» в переписке.\nЗадачи: Reply «добавлю себе в задачи» либо /add что сделать и срок.\n/tasks — открытые задачи с кнопками\n/today /overdue /done /archive /find текст\n/task номер — карточка\n/due номер новый срок — изменить дедлайн\nДокументы: Reply на PDF/DOCX/TXT «изучу», «посмотрю условия» или /analyze в личке бота.\n/docs — история, /doc номер — выжимка, /forget_doc номер — удалить локальный разбор\n/calendar /status /pause /resume /cancel\nВсе подтверждения приходят только вам в личку.';
    else {
      const result = solveMath(m.text);
      if (result.kind === 'ignore') return;
      text = result.text;
    }
    if (command === '/start' || command === '/help')
      text +=
        '\nШутки: «внимание, шутка», «сейчас будет шутка» в переписке или /joke в личке бота.';
    await this.send(id, 'direct', m, text);
  }
  status(): string {
    const connections = this.store.db
      .prepare('SELECT enabled,can_reply FROM business_connections WHERE owner_id=?')
      .all(this.c.OWNER_TELEGRAM_ID) as { enabled: number; can_reply: number }[];
    const paused = this.store.getSetting('business.paused') === 'true';
    const telegram = connections.some((c) => c.enabled && c.can_reply)
      ? 'подключён, ответы разрешены'
      : connections.some((c) => c.enabled)
        ? 'подключён, нужно разрешить ответы'
        : 'подключение пока не подтверждено';
    return [
      'KRONK · состояние ассистента',
      [
        paused ? '⏸ Ассистент на паузе' : '🟢 Ассистент включён',
        `Telegram: ${telegram}`,
        this.c.BUSINESS_DRY_RUN
          ? 'Режим проверки: действия не выполняются'
          : 'Режим: обычная работа',
      ].join('\n'),
      [
        '🧩 Функции',
        `Математика: ${this.c.BUSINESS_MATH_ENABLED ? 'включена' : 'выключена'}`,
        this.documents?.status() ?? 'Документы: не настроены',
        `Шутки: ${this.c.BUSINESS_JOKES_ENABLED ? 'включены' : 'выключены'}`,
      ].join('\n'),
      '📅 ' + (this.calendar?.status() ?? 'Календарь: не настроен'),
      '✅ ' + (this.tasks?.status() ?? 'Задачи: не настроены'),
      ...this.extensions.flatMap((extension) => (extension.status ? [extension.status()] : [])),
    ].join('\n\n');
  }
  prune(): void {
    this.store.db
      .prepare("UPDATE business_math SET answer='' WHERE created_at<?")
      .run(Date.now() - this.c.BUSINESS_RETENTION_DAYS * 86400000);
  }
}
