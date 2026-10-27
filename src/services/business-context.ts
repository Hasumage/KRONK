import type { Message } from 'grammy/types';
import type { Store } from '../storage/database.js';
import type { BusinessSettings } from '../config/business.js';
import type { BusinessApi } from './business-math.js';
import type { InputMessage } from '../domain/schema.js';

function map(m: Message, c: BusinessSettings): InputMessage | null {
  if (!m.from || (!m.text && !m.document)) return null;
  const ref = {
    accountId: c.OWNER_TELEGRAM_ID,
    chatId: m.chat.id.toString(),
    messageId: m.message_id.toString(),
  };
  return {
    ref,
    senderId: m.from.id.toString(),
    direction: m.from.id.toString() === c.OWNER_TELEGRAM_ID ? 'outgoing' : 'incoming',
    text: m.text || m.caption || '',
    sentAt: new Date(m.date * 1000).toISOString(),
    replyTo:
      m.reply_to_message && m.reply_to_message.chat.id === m.chat.id
        ? { ...ref, messageId: m.reply_to_message.message_id.toString() }
        : null,
    generatedByAssistant: !!m.sender_business_bot,
    attachment: m.document
      ? {
          name: m.document.file_name ?? 'document',
          size: m.document.file_size ?? 0,
          mime: m.document.mime_type ?? 'application/octet-stream',
        }
      : null,
  };
}
/** Reads only updates from this owner's enabled connection, never arbitrary chat history. */
export async function rememberBusinessMessage(
  c: BusinessSettings,
  store: Store,
  api: BusinessApi,
  m: Message,
  maxChars: number,
): Promise<InputMessage | null> {
  if (
    m.chat.type !== 'private' ||
    !m.business_connection_id ||
    !m.from ||
    m.from.is_bot ||
    m.sender_business_bot ||
    Date.now() / 1000 - m.date > c.BUSINESS_RETENTION_DAYS * 86400 ||
    m.date > Date.now() / 1000 + 30
  )
    return null;
  const row = store.db
    .prepare('SELECT owner_id,enabled FROM business_connections WHERE id=?')
    .get(m.business_connection_id) as { owner_id: string; enabled: number } | undefined;
  if (row) {
    if (row.owner_id !== c.OWNER_TELEGRAM_ID || !row.enabled) return null;
  } else {
    let connection;
    try {
      connection = await api.getBusinessConnection(m.business_connection_id);
    } catch {
      store.audit(null, 'tasks.ingest', 'connection_lookup_failed');
      return null;
    }
    if (
      connection.id !== m.business_connection_id ||
      connection.user.id.toString() !== c.OWNER_TELEGRAM_ID ||
      !connection.is_enabled
    )
      return null;
    store.db
      .prepare('INSERT OR REPLACE INTO business_connections VALUES (?,?,?,?,?)')
      .run(
        connection.id,
        c.OWNER_TELEGRAM_ID,
        1,
        Number(!!connection.rights?.can_reply),
        Date.now(),
      );
  }
  const trigger = map(m, c);
  if (!trigger) return null;
  if (
    m.reply_to_message &&
    m.reply_to_message.chat.id === m.chat.id &&
    !m.reply_to_message.sender_business_bot
  ) {
    const parent = map(m.reply_to_message, c);
    if (parent) store.remember(parent, maxChars);
  }
  store.remember(trigger, maxChars);
  return trigger;
}
