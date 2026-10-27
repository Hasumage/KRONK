import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { settings } from '../dist/config/settings.js';
import { Store } from '../dist/storage/database.js';
import { Vault } from '../dist/security/vault.js';
import { OpenAICalendarEngine } from '../dist/adapters/ai.js';
import { decide } from '../dist/application/policy.js';
import { emptyAnalysis } from '../dist/domain/schema.js';

// Synthetic examples only. No real chat history is sent by this diagnostic.
const config = settings({ ...process.env, MODE: 'mock', OWNER_TELEGRAM_ID: '1' });
const store = new Store(':memory:', new Vault(randomBytes(32)));
const ai = new OpenAICalendarEngine(config, store);
const ref = (id) => ({ accountId: '1', chatId: '10', messageId: id });
const source = {
  ref: ref('101'),
  senderId: '2',
  direction: 'incoming',
  text: '29 октября 2026 года в 18:30 встречаемся. Адрес пришлю позже.',
  sentAt: '2026-10-25T20:00:00+03:00',
  replyTo: null,
  generatedByAssistant: false,
  attachment: null,
};
try {
  const checks = process.argv.includes('--informal')
    ? [
        ['Впишу себе', 'allow'],
        ['Отмечу у себя', 'allow'],
        ['Забью встречу', 'allow'],
        ['Ок, буду', 'deny'],
        ['Запишу себе номер телефона', 'deny'],
      ]
    : [
        ['занесу в календарь', 'allow'],
        ['Хорошо, буду, занесу в календарь', 'allow'],
        ['Внесу себе эту встречу в календарь', 'allow'],
        ['Да, буду', 'deny'],
        ['Нет, не смогу, занесу в календарь', 'deny'],
      ];
  for (const [text, expected] of checks) {
    const trigger = {
      ...source,
      ref: ref('102'),
      senderId: '1',
      direction: 'outgoing',
      text,
      replyTo: ref('101'),
    };
    const context = {
      trigger,
      messages: [source],
      now: trigger.sentAt,
      timezone: 'Europe/Moscow',
      clarification: null,
      candidates: { tasks: [], events: [] },
      knowledge: [],
    };
    const result = await ai.classify(context),
      policy = decide(
        config,
        context,
        result.intent === 'calendar.create' ? result : emptyAnalysis(),
      );
    const expectedStart = '2026-10-29T18:30:00+03:00';
    const ok =
      policy.kind === expected &&
      (expected !== 'allow' ||
        (Date.parse(result.data.startAt) === Date.parse(expectedStart) &&
          result.data.location === null));
    console.info(JSON.stringify({ ok, intent: result.intent, decision: policy.kind, expected }));
    if (!ok) process.exitCode = 1;
  }
} catch (error) {
  console.info(
    JSON.stringify({
      ok: false,
      status: error.status ?? null,
      code: error.code ?? 'AI_CHECK_FAILED',
    }),
  );
  process.exitCode = 1;
} finally {
  store.close();
}
