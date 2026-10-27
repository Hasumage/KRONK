// Optional real API check. Uses synthetic text and a separate in-memory database.
// Run after npm run build. Never writes tasks or sends Telegram messages.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { businessSettings } from '../dist/config/business.js';
import { businessCalendarSettings } from '../dist/services/business-calendar.js';
import { OpenAITaskExtractor } from '../dist/adapters/ai.js';
import { Store } from '../dist/storage/database.js';
import { Vault } from '../dist/security/vault.js';
const store = new Store(':memory:', new Vault(randomBytes(32)));
const config = businessCalendarSettings(businessSettings());
const extractor = new OpenAITaskExtractor(config, store);
const base = {
  mode: 'create',
  text: '',
  referenceTime: '2026-10-26T10:00:00Z',
  timezone: 'Europe/Moscow',
  context: [],
  replyMessageId: null,
  clarification: null,
  current: null,
};
const parent = (text) => ({
  ref: { accountId: '123', chatId: '456', messageId: '100' },
  senderId: '456',
  direction: 'incoming',
  text,
  sentAt: base.referenceTime,
  replyTo: null,
  generatedByAssistant: false,
  attachment: null,
});
const current = { title: 'Отправить отчёт', description: null, dueAt: null, dueDate: '2026-11-01' };
const cases = [
  [
    'no deadline',
    { text: 'Добавь задачу купить молоко' },
    (r) => {
      assert.equal(r.requiresClarification, false);
      assert.equal(r.hasDeadline, false);
      assert.match(r.title, /молок/iu);
      assert.equal(r.dueAt, null);
      assert.equal(r.dueDate, null);
    },
  ],
  [
    'reply and date-only',
    {
      text: 'закину в задачи',
      replyMessageId: '100',
      context: [parent('Отправь отчёт до пятницы')],
    },
    (r) => {
      assert.equal(r.requiresClarification, false);
      assert.equal(r.dueDate, '2026-10-30');
      assert.equal(r.dueAt, null);
      assert.match(r.title, /отч/iu);
    },
  ],
  [
    'exact time',
    { text: 'Добавь задачу отправить отчёт завтра к 18:00' },
    (r) => {
      assert.equal(Date.parse(r.dueAt), Date.parse('2026-10-27T18:00:00+03:00'));
      assert.equal(r.dueDate, null);
    },
  ],
  [
    'missing content',
    { text: 'добавлю в задачи' },
    (r) => assert.equal(r.requiresClarification, true),
  ],
  [
    'edit preserves deadline',
    { mode: 'edit', text: 'Отправить итоговый отчёт директору', current },
    (r) => {
      assert.equal(r.clearDeadline, false);
      assert.equal(r.hasDeadline ? r.dueDate : current.dueDate, current.dueDate);
      assert.equal(r.dueAt, null);
      assert.match(r.title, /отч/iu);
    },
  ],
  [
    'clear deadline',
    { mode: 'deadline', text: 'без срока', current },
    (r) => {
      assert.equal(r.clearDeadline, true);
      assert.equal(r.hasDeadline, false);
    },
  ],
];
try {
  const results = await Promise.allSettled(
    cases.map(async ([name, request, check]) => {
      const result = await extractor.extract({ ...base, ...request });
      try {
        check(result);
      } catch (error) {
        console.log('Synthetic extraction for ' + name + ': ' + JSON.stringify(result));
        throw error;
      }
      if (!result.requiresClarification) assert.ok(result.confidence >= 0.9);
      return name;
    }),
  );
  let failed = false;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') console.log('PASS ' + result.value);
    else {
      failed = true;
      console.log(
        'FAIL ' +
          cases[i][0] +
          ': ' +
          (result.reason instanceof assert.AssertionError
            ? result.reason.message
            : 'API_OR_CONFIGURATION_ERROR'),
      );
    }
  });
  if (failed) process.exitCode = 1;
} finally {
  store.close();
}
