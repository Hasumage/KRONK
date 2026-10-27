import { randomBytes } from 'node:crypto';
import { settings, type Settings } from '../src/config/settings.js';
import { Vault } from '../src/security/vault.js';
import { Store } from '../src/storage/database.js';
import { emptyAnalysis, type InputMessage, type Analysis } from '../src/domain/schema.js';
import { MockAI } from '../src/adapters/ai.js';
import { MockCalendar } from '../src/adapters/calendar.js';
import { Registrations } from '../src/services/registrations.js';
import { Worker } from '../src/application/worker.js';
import { vi } from 'vitest';

export const ref = (id: string) => ({ accountId: '1', chatId: '10', messageId: id });
export function message(
  id = '102',
  text = 'Да, буду, занесу в календарь',
  out = true,
  reply: string | null = '101',
): InputMessage {
  return {
    ref: ref(id),
    senderId: out ? '1' : '2',
    direction: out ? 'outgoing' : 'incoming',
    text,
    sentAt: '2026-10-25T20:00:00+03:00',
    replyTo: reply ? ref(reply) : null,
    generatedByAssistant: false,
    attachment: null,
  };
}
export function analysis(
  intent: Analysis['intent'] = 'calendar.create',
  data: Partial<Analysis['data']> = {},
): Analysis {
  return {
    ...emptyAnalysis(),
    intent,
    explicitUserIntent: true,
    evidence:
      intent === 'task.create'
        ? 'Добавлю себе в задачник'
        : intent === 'task.complete'
          ? 'Сделал'
          : intent === 'document.summarize'
            ? 'Изучу договор'
            : 'занесу в календарь',
    attendance: 'accepted',
    sourceMessageIds: ['101', '102'],
    data: {
      ...emptyAnalysis().data,
      title: 'Встреча',
      startAt: '2026-10-29T18:30:00+03:00',
      ...data,
    },
  };
}
export function harness(
  overrides: Partial<Settings> = {},
  fixtures: Record<string, Analysis> = { '102': analysis() },
  path = ':memory:',
  vault = new Vault(randomBytes(32)),
) {
  const c = { ...settings({}), DRY_RUN: false, ...overrides };
  const s = new Store(path, vault),
    ai = new MockAI(fixtures),
    calendar = new MockCalendar(c),
    registration = new Registrations(c, s),
    autoSend = vi.fn(async (_m: InputMessage, _text: string, _id: string) => {}),
    download = vi.fn(async () => Buffer.from('Предмет: тестовый договор.'));
  const knowledge = [
    {
      id: 'kb',
      topic: 'work',
      question: 'Как создать команду?',
      answer: 'Создайте команду на проверенном портале.',
    },
  ];
  const w = new Worker(c, s, ai, calendar, download, registration, autoSend, knowledge);
  s.remember(message('101', '29 октября 18:30, встреча, адрес позже', false, null));
  return { c, s, w, ai, calendar, registration, autoSend, download, knowledge };
}
