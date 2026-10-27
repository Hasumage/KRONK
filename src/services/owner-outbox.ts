import type { Api } from 'grammy';
import type { Store } from '../storage/database.js';
import type { TaskCard } from '../tasks/model.js';
import { InputFile } from 'grammy';

/** The recipient is fixed to the owner. Never sends through a business connection. */
export class OwnerOutbox {
  constructor(
    private readonly store: Store,
    private readonly api: Pick<Api, 'sendMessage'> & Partial<Pick<Api, 'sendPhoto'>>,
    private readonly owner: string,
    private readonly dryRun: boolean,
  ) {}
  enqueue(id: string, card: TaskCard): void {
    if (card.text.length > 4000) throw new Error('OWNER_CARD_TOO_LARGE');
    if (card.photoBase64 && (card.text.length > 1024 || card.photoBase64.length > 8_000_000))
      throw new Error('OWNER_PHOTO_TOO_LARGE');
    this.store.db
      .prepare('INSERT OR IGNORE INTO outbox(id,payload,created_at) VALUES (?,?,?)')
      .run(id, this.store.vault.seal(card), Date.now());
  }
  async flush(): Promise<void> {
    if (this.dryRun || Number(this.store.getSetting('owner.outbox.backoff') ?? 0) > Date.now())
      return;
    const rows = this.store.db
      .prepare(
        "SELECT id,payload FROM outbox WHERE status='pending' ORDER BY created_at,id LIMIT 5",
      )
      .all() as { id: string; payload: string }[];
    for (const row of rows) {
      if (
        !this.store.db
          .prepare("UPDATE outbox SET status='sending' WHERE id=? AND status='pending'")
          .run(row.id).changes
      )
        continue;
      try {
        const payload = this.store.vault.open<string | TaskCard>(row.payload);
        const card = typeof payload === 'string' ? { text: payload } : payload;
        const sent = card.photoBase64
          ? await (() => {
              if (!this.api.sendPhoto) throw new Error('OWNER_PHOTO_UNAVAILABLE');
              return this.api.sendPhoto(
                this.owner,
                new InputFile(Buffer.from(card.photoBase64, 'base64'), 'registration.png'),
                { caption: card.text },
              );
            })()
          : await this.api.sendMessage(this.owner, card.text, {
              link_preview_options: { is_disabled: true },
              ...(card.replyMarkup ? { reply_markup: card.replyMarkup } : {}),
            });
        this.store.db
          .prepare("UPDATE outbox SET status='sent',telegram_message_id=? WHERE id=?")
          .run(sent.message_id.toString(), row.id);
      } catch (error) {
        const e = error as { error_code?: number; parameters?: { retry_after?: number } };
        const retry = e.error_code === 429 && e.parameters?.retry_after;
        this.store.db
          .prepare('UPDATE outbox SET status=? WHERE id=?')
          .run(retry ? 'pending' : e.error_code ? 'failed' : 'uncertain', row.id);
        if (retry)
          this.store.setSetting('owner.outbox.backoff', (Date.now() + retry * 1000).toString());
        this.store.audit(
          null,
          'owner.notification',
          retry ? 'rate_limit' : e.error_code ? 'rejected' : 'uncertain',
        );
        break;
      }
    }
  }
}
