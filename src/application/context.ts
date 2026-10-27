import type { Settings } from '../config/settings.js';
import type { InputMessage, ResolvedContext } from '../domain/schema.js';
import type { Store } from '../storage/database.js';

export function resolveContext(
  store: Store,
  config: Settings,
  trigger: InputMessage,
  clarification: string | null,
  knowledge: ResolvedContext['knowledge'],
): ResolvedContext {
  const messages: InputMessage[] = [];
  let parent = trigger.replyTo;
  const seen = new Set<string>([trigger.ref.messageId]);
  let budget = Math.max(
    0,
    config.MAX_CONTEXT_CHARS - trigger.text.length - (clarification?.length ?? 0),
  );
  while (parent && messages.length < 5 && !seen.has(parent.messageId)) {
    if (parent.accountId !== trigger.ref.accountId || parent.chatId !== trigger.ref.chatId) break;
    const m = store.message(parent.accountId, parent.chatId, parent.messageId);
    if (!m || m.text.length > budget) break;
    messages.push(m);
    seen.add(m.ref.messageId);
    budget -= m.text.length;
    parent = m.replyTo;
  }
  if (!trigger.replyTo) {
    const rows = store.db
      .prepare(
        'SELECT payload FROM messages WHERE account_id=? AND chat_id=? AND message_id!=? ORDER BY created_at DESC LIMIT 5',
      )
      .all(trigger.ref.accountId, trigger.ref.chatId, trigger.ref.messageId) as {
      payload: string;
    }[];
    for (const r of rows.reverse()) {
      const m = store.vault.open<InputMessage>(r.payload);
      if (m.sentAt <= trigger.sentAt && m.text.length <= budget) {
        messages.push(m);
        budget -= m.text.length;
      }
    }
  }
  const tasks = store.db
    .prepare(
      "SELECT id,payload,source_message_id FROM tasks WHERE account_id=? AND chat_id=? AND status='open' LIMIT 30",
    )
    .all(trigger.ref.accountId, trigger.ref.chatId) as {
    id: string;
    payload: string;
    source_message_id: string;
  }[];
  const events = store.db
    .prepare(
      "SELECT id,payload,source_message_id FROM events WHERE account_id=? AND chat_id=? AND status='active' LIMIT 30",
    )
    .all(trigger.ref.accountId, trigger.ref.chatId) as {
    id: string;
    payload: string;
    source_message_id: string;
  }[];
  return {
    trigger,
    messages,
    now: trigger.sentAt,
    timezone: config.TIMEZONE,
    clarification,
    knowledge,
    candidates: {
      tasks: tasks.map((r) => ({
        id: r.id,
        title: store.vault.open<{ title: string }>(r.payload).title,
        sourceMessageId: r.source_message_id,
      })),
      events: events.map((r) => ({
        id: r.id,
        title: store.vault.open<{ title: string }>(r.payload).title,
        sourceMessageId: r.source_message_id,
      })),
    },
  };
}
