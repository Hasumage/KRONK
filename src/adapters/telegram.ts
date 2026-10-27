import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import bigInt from 'big-integer';
import { Bot, InlineKeyboard } from 'grammy';
import type { Settings } from '../config/settings.js';
import type { Store } from '../storage/database.js';
import type { InputMessage } from '../domain/schema.js';
import type { Worker } from '../application/worker.js';
import type { Control } from '../services/control.js';

export class Telegram {
  readonly client: TelegramClient;
  readonly bot: Bot;
  private timer: NodeJS.Timeout | null = null;
  private catchingUp = false;
  private botId = '';
  constructor(
    private readonly c: Settings,
    private readonly store: Store,
  ) {
    const session = store.secret<string>('telegram');
    if (!session) throw new Error('TELEGRAM_LOGIN_REQUIRED');
    this.client = new TelegramClient(
      new StringSession(session),
      c.TELEGRAM_API_ID,
      c.TELEGRAM_API_HASH,
      {
        connectionRetries: 5,
        requestRetries: 1,
        floodSleepThreshold: 60,
        baseLogger: new Logger(LogLevel.NONE),
      },
    );
    this.bot = new Bot(c.TELEGRAM_BOT_TOKEN);
  }
  async start(worker: Worker, control: Control): Promise<void> {
    if (this.store.getSetting('session_revoked') === 'true')
      throw new Error('TELEGRAM_LOGIN_REQUIRED');
    await this.client.connect();
    const me = await this.client.getMe();
    if (me.id.toString() !== this.c.OWNER_TELEGRAM_ID) throw new Error('TELEGRAM_OWNER_MISMATCH');
    await this.bot.init();
    this.botId = this.bot.botInfo.id.toString();
    this.client.addEventHandler(async (event: NewMessageEvent) => {
      try {
        await this.receive(event.message, worker);
      } catch {
        this.store.audit(null, 'telegram', 'ingest_failed');
      }
    }, new NewMessage({}));
    this.bot.on('message:text', async (ctx) => {
      const sender = ctx.from.id.toString();
      if (sender !== this.c.OWNER_TELEGRAM_ID || ctx.chat.type !== 'private') return;
      const key = `bot:${ctx.update.update_id}`;
      if (this.store.getSetting(key)) return;
      this.store.setSetting(key, 'processing');
      try {
        const result = await control.handle(
          sender,
          true,
          ctx.message.text,
          ctx.message.reply_to_message?.message_id.toString(),
        );
        if (result) this.store.notify(key, result);
        this.store.setSetting(key, 'done');
      } catch {
        this.store.notify(key, 'Операция не подтверждена. Проверьте /status.');
        this.store.setSetting(key, 'uncertain');
      }
    });
    this.bot.on('callback_query:data', async (ctx) => {
      if (
        ctx.from.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
        ctx.callbackQuery.message?.chat.type !== 'private'
      )
        return;
      const data = ctx.callbackQuery.data;
      if (!data.startsWith('approve:')) return;
      const result = await control.handle(
        ctx.from.id.toString(),
        true,
        `/approve ${data.slice(8)}`,
      );
      if (result) this.store.notify(`callback:${ctx.callbackQuery.id}`, result);
      await ctx.answerCallbackQuery({ text: 'Запрос обработан' });
    });
    this.bot.catch(() => this.store.audit(null, 'bot', 'polling_error'));
    void this.bot
      .start({
        drop_pending_updates: false,
        onStart: () => this.store.audit(null, 'bot', 'started'),
      })
      .catch(() => this.store.audit(null, 'bot', 'stopped'));
    await this.catchUp(worker);
    this.timer = setInterval(() => {
      void this.catchUp(worker).catch(() => this.store.audit(null, 'telegram', 'catchup_failed'));
    }, 30000);
  }
  private map(m: Api.Message): InputMessage | null {
    if (!m.chatId || !m.senderId) return null;
    const chat = m.chatId.toString();
    if (chat === this.botId || m.senderId.toString() === this.botId) return null;
    const ref = { accountId: this.c.OWNER_TELEGRAM_ID, chatId: chat, messageId: m.id.toString() };
    const attachment = m.file
      ? {
          name: String(m.file.name ?? 'document'),
          size: Number(m.file.size),
          mime: m.file.mimeType ?? 'application/octet-stream',
        }
      : null;
    return {
      ref,
      senderId: m.senderId.toString(),
      direction: m.out ? 'outgoing' : 'incoming',
      text: m.message ?? '',
      sentAt: new Date(m.date * 1000).toISOString(),
      replyTo: m.replyToMsgId ? { ...ref, messageId: m.replyToMsgId.toString() } : null,
      generatedByAssistant: !!m.out && (m.message ?? '').startsWith('Я ИИ-помощник.'),
      attachment,
    };
  }
  private async receive(m: Api.Message, worker: Worker): Promise<void> {
    const mapped = this.map(m);
    if (!mapped) return;
    if (mapped.replyTo) {
      let current = m;
      for (let i = 0; i < 5; i++) {
        const reply = await current.getReplyMessage();
        if (!reply) break;
        const parent = this.map(reply);
        if (parent && parent.ref.chatId === mapped.ref.chatId)
          this.store.remember(parent, this.c.MAX_CONTEXT_CHARS);
        else break;
        current = reply;
      }
    }
    const sender = await m.getSender();
    if (!(sender instanceof Api.User && sender.bot)) worker.ingest(mapped);
    // Polling cursor advances only from ordered catch-up batches. Live updates can arrive out of order.
    const cursor = `cursor:${mapped.ref.chatId}`;
    if (!this.store.getSetting(cursor)) this.store.setSetting(cursor, mapped.ref.messageId);
  }
  private async catchUp(worker: Worker): Promise<void> {
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      const dialogs = await this.client.getDialogs({ limit: 100 });
      for (const dialog of dialogs) {
        if (!dialog.id || !dialog.message || !(dialog.message instanceof Api.Message)) continue;
        const chat = dialog.id.toString(),
          key = `cursor:${chat}`;
        let cursor = this.store.getSetting(key);
        if (!cursor) {
          this.store.setSetting(key, dialog.message.id.toString());
          continue;
        }
        // Read only messages newer than persisted cursor, in chronological batches.
        for (let page = 0; page < 5; page++) {
          const batch = await this.client.getMessages(dialog.inputEntity, {
            minId: Number(cursor),
            reverse: true,
            limit: 100,
          });
          for (const m of batch) {
            await this.receive(m, worker);
            this.store.setSetting(key, m.id.toString());
          }
          cursor = this.store.getSetting(key) ?? cursor;
          if (batch.length < 100) break;
          if (page === 4) this.store.audit(null, 'telegram', 'catchup_continues_next_poll');
        }
      }
    } finally {
      this.catchingUp = false;
    }
  }
  async download(m: InputMessage, maxBytes: number): Promise<Buffer> {
    const list = await this.client.getMessages(bigInt(m.ref.chatId), {
      ids: [Number(m.ref.messageId)],
    });
    const original = list[0];
    if (!original || Number(original.file?.size ?? 0) > maxBytes)
      throw new Error('DOCUMENT_TOO_LARGE_OR_MISSING');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of this.client.iterDownload({
      file: original.media!,
      requestSize: 65536,
    })) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('DOCUMENT_TOO_LARGE');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async autoSend(m: InputMessage, text: string, id: string): Promise<void> {
    if (
      this.c.DRY_RUN ||
      !this.c.AUTO_REPLY_ENABLED ||
      !this.c.AUTO_REPLY_CHATS.includes(m.ref.chatId) ||
      this.store.getSetting('paused') === 'true'
    )
      throw new Error('AUTO_REPLY_DISABLED');
    // Check owner activity again immediately before MTProto invocation.
    const state = this.store.db
      .prepare('SELECT last_owner_activity_at FROM auto_reply_state WHERE chat_id=?')
      .get(m.ref.chatId) as { last_owner_activity_at: number } | undefined;
    if (
      state &&
      state.last_owner_activity_at + this.c.AUTO_REPLY_OWNER_PAUSE_MINUTES * 60000 > Date.now()
    )
      return;
    await this.client.invoke(
      new Api.messages.SendMessage({
        peer: await this.client.getInputEntity(bigInt(m.ref.chatId)),
        message: text,
        randomId: bigInt(id.slice(0, 15), 16),
        noWebpage: true,
      }),
    );
  }
  async flushOutbox(): Promise<void> {
    if (this.c.DRY_RUN) return; // Never send even owner notifications in dry-run.
    const rows = this.store.db
      .prepare("SELECT id,payload FROM outbox WHERE status='pending' ORDER BY created_at LIMIT 5")
      .all() as { id: string; payload: string }[];
    for (const r of rows) {
      const text = this.store.vault.open<string>(r.payload);
      this.store.db.prepare("UPDATE outbox SET status='sending' WHERE id=?").run(r.id);
      try {
        const token = text.match(/\/approve ([A-Za-z0-9_-]+)/)?.[1];
        const sent = await this.bot.api.sendMessage(this.c.OWNER_TELEGRAM_ID, text, {
          link_preview_options: { is_disabled: true },
          ...(token
            ? {
                reply_markup: new InlineKeyboard().text('Подтвердить отправку', `approve:${token}`),
              }
            : {}),
        });
        this.store.db
          .prepare("UPDATE outbox SET status='sent',telegram_message_id=? WHERE id=?")
          .run(sent.message_id.toString(), r.id);
      } catch (e) {
        // Explicit 429 means Telegram rejected it; wait, then retry. Other failures are ambiguous.
        const retry = (e as { parameters?: { retry_after?: number } }).parameters?.retry_after;
        this.store.db
          .prepare('UPDATE outbox SET status=? WHERE id=?')
          .run(retry ? 'pending' : 'uncertain', r.id);
        if (retry) await new Promise((resolve) => setTimeout(resolve, Math.min(retry, 60) * 1000));
        break;
      }
    }
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.bot.isRunning()) await this.bot.stop();
    await this.client.disconnect();
  }
}
