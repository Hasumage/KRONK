import { createHash, randomInt } from 'node:crypto';
import type { Message } from 'grammy/types';
import type { BusinessSettings } from '../config/business.js';
import type { Store } from '../storage/database.js';
import type { BusinessApi } from '../services/business-math.js';
import { jokes, jokeIntent } from './library.js';

export class BusinessJokes {
  constructor(
    private readonly c: BusinessSettings,
    private readonly store: Store,
    private readonly api: BusinessApi,
  ) {
    store.db.prepare("UPDATE joke_deliveries SET state='uncertain' WHERE state='sending'").run();
  }
  private allowed(): boolean {
    return (
      this.c.BUSINESS_JOKES_ENABLED &&
      !this.c.BUSINESS_DRY_RUN &&
      this.store.getSetting('business.paused') !== 'true'
    );
  }
  async receive(m: Message): Promise<boolean> {
    if (
      !m.text ||
      !jokeIntent(m.text) ||
      m.chat.type !== 'private' ||
      m.from?.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
      m.from.is_bot ||
      m.sender_business_bot ||
      m.forward_origin
    )
      return false;
    if (!this.allowed() || Date.now() / 1000 - m.date > 120 || m.date > Date.now() / 1000 + 30)
      return true;
    const connection = m.business_connection_id ?? 'direct';
    if (connection === 'direct' && m.chat.id.toString() !== this.c.OWNER_TELEGRAM_ID) return true;
    const chatKey = createHash('sha256')
      .update(JSON.stringify([this.c.OWNER_TELEGRAM_ID, connection, m.chat.id]))
      .digest('hex');
    const id = createHash('sha256')
      .update(JSON.stringify([chatKey, m.message_id]))
      .digest('hex');
    if (this.store.db.prepare('SELECT 1 FROM joke_deliveries WHERE id=?').get(id)) return true;
    if (connection !== 'direct') {
      try {
        const c = await this.api.getBusinessConnection(connection);
        if (
          c.id !== connection ||
          c.user.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
          !c.is_enabled ||
          !c.rights?.can_reply
        )
          return true;
      } catch {
        this.store.audit(id, 'joke.reply', 'connection_lookup_failed');
        return true;
      }
    }
    if (!this.allowed()) return true;
    const selected = this.store.db.transaction(() => {
      if (this.store.db.prepare('SELECT 1 FROM joke_deliveries WHERE id=?').get(id)) return null;
      const recent = this.store.db
        .prepare(
          "SELECT joke_id,created_at FROM joke_deliveries WHERE chat_key=? AND state IN ('sending','sent','uncertain') ORDER BY created_at DESC,rowid DESC LIMIT ?",
        )
        .all(chatKey, jokes.length - 1) as { joke_id: string; created_at: number }[];
      if (recent.filter((r) => r.created_at > Date.now() - 60000).length >= 3) return null;
      const used = new Set(recent.map((r) => r.joke_id));
      const candidates = jokes.filter((j) => !used.has(j.id));
      const joke = candidates[randomInt(candidates.length)]!;
      this.store.db
        .prepare(
          "INSERT INTO joke_deliveries(id,chat_key,joke_id,state,created_at) VALUES (?,?,?,'sending',?)",
        )
        .run(id, chatKey, joke.id, Date.now());
      return joke;
    })();
    if (!selected) return true;
    try {
      const sent = await this.api.sendMessage(m.chat.id, selected.text, {
        ...(connection !== 'direct' ? { business_connection_id: connection } : {}),
        link_preview_options: { is_disabled: true },
      });
      this.store.db
        .prepare("UPDATE joke_deliveries SET state='sent',sent_message_id=? WHERE id=?")
        .run(sent.message_id, id);
      this.store.audit(id, 'joke.reply', 'sent');
    } catch (error) {
      const rejected = typeof error === 'object' && error !== null && 'error_code' in error;
      this.store.db
        .prepare('UPDATE joke_deliveries SET state=? WHERE id=?')
        .run(rejected ? 'rejected' : 'uncertain', id);
      this.store.audit(id, 'joke.reply', rejected ? 'telegram_rejected' : 'uncertain');
    }
    return true;
  }
  prune(): void {
    this.store.db
      .prepare("UPDATE joke_deliveries SET joke_id='' WHERE created_at<? AND state!='sending'")
      .run(Date.now() - this.c.BUSINESS_RETENTION_DAYS * 86400000);
  }
}
