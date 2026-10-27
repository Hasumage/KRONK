import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Message, CallbackQuery } from 'grammy/types';
import { Store } from '../src/storage/database.js';
import { Vault } from '../src/security/vault.js';
import { businessSettings } from '../src/config/business.js';
import { businessCalendarSettings } from '../src/services/business-calendar.js';
import type { Settings } from '../src/config/settings.js';
import { BusinessMath } from '../src/services/business-math.js';
import { OwnerOutbox } from '../src/services/owner-outbox.js';
import { BusinessReplies } from '../src/replies/service.js';
import { ReplyKnowledge } from '../src/replies/knowledge.js';
import type { ReplySelection, ReplyJob, ReplyPayload } from '../src/replies/model.js';

const owner = 123456789,
  stores: Store[] = [];
const facts = () => ({
  version: 1,
  topics: [
    {
      id: 'demo',
      title: 'Тестовый проект',
      enabled: true,
      entries: [
        {
          id: 'demo_team',
          question: 'Как создать команду в тестовом проекте?',
          answer: 'В тестовом проекте команда создаётся через учебный портал.',
          source: 'Изолированная тестовая фикстура, не реальные условия программы.',
          approved: true,
          expiresAt: null as string | null,
        },
      ],
    },
  ],
});
const selected = (): ReplySelection => ({
  kind: 'answer',
  entryIds: ['demo_team'],
  confidence: 1,
  reason: 'work_question',
});
const incoming = (
  text = 'Как создать команду в тестовом проекте?',
  id = 1,
  chat = 555,
): Message => ({
  message_id: id,
  date: Math.floor(Date.now() / 1000),
  business_connection_id: 'conn',
  chat: { id: chat, type: 'private', first_name: 'Friend' },
  from: { id: chat, is_bot: false, first_name: 'Friend' },
  text,
});
const direct = (text: string, id = 100, from = owner): Message => ({
  message_id: id,
  date: Math.floor(Date.now() / 1000),
  chat: { id: owner, type: 'private', first_name: 'Owner' },
  from: { id: from, is_bot: false, first_name: 'Owner' },
  text,
});
const outgoing = (text = 'Я сам отвечу', id = 2): Message => ({
  ...incoming(text, id),
  from: { id: owner, is_bot: false, first_name: 'Owner' },
});
function setup(
  env: NodeJS.ProcessEnv = {},
  app: Partial<Settings> = {},
  knowledge: ReplyKnowledge | null = new ReplyKnowledge(facts()),
) {
  const b = businessSettings({
    TELEGRAM_BOT_TOKEN: 'test',
    OWNER_TELEGRAM_ID: String(owner),
    BUSINESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BUSINESS_REPLY_ENABLED: 'true',
    BUSINESS_REPLY_DEBOUNCE_SECONDS: '0',
    BUSINESS_DRY_RUN: 'false',
    ...env,
  });
  const c = { ...businessCalendarSettings(b, {}), ...app },
    s = new Store(':memory:', new Vault(randomBytes(32)));
  stores.push(s);
  const api = {
    getBusinessConnection: vi.fn(async () => ({
      id: 'conn',
      user: { id: owner, is_bot: false, first_name: 'Owner' },
      user_chat_id: owner,
      date: 1,
      is_enabled: true,
      rights: { can_reply: true },
    })),
    sendMessage: vi.fn(async (_chat: string | number, _text: string, _options?: object) => ({
      ...incoming(),
      message_id: 999,
    })),
    answerCallbackQuery: vi.fn(async (_id: string, _options?: object) => true),
  };
  const typedApi = api as unknown as ConstructorParameters<typeof BusinessReplies>[3],
    outbox = new OwnerOutbox(s, typedApi, String(owner), b.BUSINESS_DRY_RUN),
    selector = {
      select: vi.fn(async (_messages: readonly string[], _knowledge: unknown) => selected()),
    };
  const service = new BusinessReplies(
    b,
    c,
    s,
    typedApi,
    outbox,
    selector,
    ...(knowledge ? [knowledge] : []),
  );
  const math = new BusinessMath(b, s, typedApi, undefined, undefined, undefined, service);
  const job = () =>
    s.db.prepare('SELECT * FROM reply_jobs ORDER BY number DESC LIMIT 1').get() as
      ReplyJob | undefined;
  const callback = (action = 'send', id = 'click', from = owner): CallbackQuery => ({
    id,
    from: { id: from, is_bot: false, first_name: 'Owner' },
    chat_instance: 'private',
    message: direct('Preview'),
    data: `reply:${action}:1`,
  });
  return { b, c, s, api, typedApi, outbox, selector, service, math, job, callback };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
});
describe('База знаний: только одобренные факты', () => {
  it('не выдумывает знания, фильтрует отключённые, неодобренные и просроченные записи', () => {
    const data = facts();
    data.topics[0]!.entries[0]!.approved = false;
    expect(new ReplyKnowledge(data).active()).toHaveLength(0);
    data.topics[0]!.entries[0]!.approved = true;
    data.topics[0]!.entries[0]!.expiresAt = '2020-01-01T00:00:00Z';
    expect(new ReplyKnowledge(data).active()).toHaveLength(0);
    data.topics[0]!.entries[0]!.expiresAt = null;
    data.topics[0]!.enabled = false;
    expect(new ReplyKnowledge(data).active()).toHaveLength(0);
    expect(new ReplyKnowledge({ version: 1, topics: [] }).active()).toHaveLength(0);
  });
  it('проверяет схему, уникальность и ограничивает передаваемый контекст', () => {
    const data = facts();
    data.topics[0]!.entries.push({ ...data.topics[0]!.entries[0]! });
    expect(() => new ReplyKnowledge(data)).toThrow('REPLY_DUPLICATE_ENTRY');
    expect(() => new ReplyKnowledge({ version: 1, topics: [{ id: 'demo' }] })).toThrow();
    const kb = new ReplyKnowledge(facts());
    expect(kb.candidates('Команда', 10)).toHaveLength(0);
    expect(kb.candidates('Команда', 5000)).toHaveLength(1);
    const changed = facts();
    changed.topics[0]!.entries[0]!.answer = 'Другая утверждённая формулировка.';
    expect(new ReplyKnowledge(changed).hash).not.toBe(kb.hash);
  });
});
describe('Модуль по умолчанию выключен', () => {
  it('настройки сохраняют все чаты и круглосуточный режим, флаг запуска false', () => {
    const c = businessSettings({
      TELEGRAM_BOT_TOKEN: 'test',
      OWNER_TELEGRAM_ID: String(owner),
      BUSINESS_ENCRYPTION_KEY: 'test',
    });
    expect(c.BUSINESS_REPLY_ENABLED).toBe(false);
    expect(c.BUSINESS_REPLY_SCOPE).toBe('all');
    expect(c.BUSINESS_REPLY_SCHEDULE).toBe('always');
    expect(c.BUSINESS_REPLY_MODE).toBe('preview');
  });
  it('выключенный модуль не читает KB, не сохраняет сообщения, не вызывает API или модель', async () => {
    const { service, api, selector, s, math } = setup(
      { BUSINESS_REPLY_ENABLED: 'false', BUSINESS_REPLY_KNOWLEDGE_PATH: 'missing-file.json' },
      {},
      null,
    );
    await math.handle({
      update_id: 1,
      business_message: incoming() as NonNullable<
        import('grammy/types').Update['business_message']
      >,
    });
    await service.tick();
    service.prune();
    expect(api.getBusinessConnection).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(selector.select).not.toHaveBeenCalled();
    expect(s.db.prepare('SELECT count(*) AS n FROM reply_seen').get()).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT count(*) AS n FROM reply_jobs').get()).toEqual({ n: 0 });
    expect(service.status()).toContain('выключены');
  });
  it('снятие паузы и старая кнопка не включают модуль', async () => {
    const { service, api, selector, callback } = setup({ BUSINESS_REPLY_ENABLED: 'false' });
    service.ownerMessage(direct('/reply_resume all'));
    await service.callback(callback());
    await service.receive(incoming());
    await service.tick();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(selector.select).not.toHaveBeenCalled();
    expect(service.status()).toContain('выключены');
  });
});
describe('Изолированный стенд: охват и правила', () => {
  it('смена all/selected сохраняет явные разрешения и исключения', async () => {
    const { service, b, c, s, typedApi, outbox, selector } = setup();
    await service.receive(incoming());
    const selectedService = new BusinessReplies(
      { ...b, BUSINESS_REPLY_SCOPE: 'selected' },
      c,
      s,
      typedApi,
      outbox,
      selector,
      new ReplyKnowledge(facts()),
    );
    await selectedService.receive(incoming(undefined, 2));
    await selectedService.tick();
    expect(selector.select).not.toHaveBeenCalled();
    selectedService.ownerMessage(direct('/reply_allow 1'));
    await selectedService.receive(incoming(undefined, 3));
    await selectedService.tick();
    expect(selector.select).toHaveBeenCalledOnce();
    selectedService.ownerMessage(direct('/reply_block 1', 101));
    const allService = new BusinessReplies(
      b,
      c,
      s,
      typedApi,
      outbox,
      selector,
      new ReplyKnowledge(facts()),
    );
    await allService.receive(incoming(undefined, 4));
    await allService.tick();
    expect(selector.select).toHaveBeenCalledOnce();
  });
  it('соблюдает суточный лимит чата и восстанавливает квоту на следующий день', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T09:00:00Z'));
    const { service, selector } = setup({}, { AUTO_REPLY_DAILY_LIMIT: 1 });
    await service.receive(incoming());
    await service.tick();
    await vi.advanceTimersByTimeAsync(31 * 60000);
    await service.receive(incoming(undefined, 2));
    await service.tick();
    expect(selector.select).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(24 * 3600000);
    await service.receive(incoming(undefined, 3));
    await service.tick();
    expect(selector.select).toHaveBeenCalledTimes(2);
  });
  it('общий лимит входящих ограничивает запросы к модели в новых чатах', async () => {
    const { service, selector, s } = setup({}, { MAX_MESSAGES_PER_DAY: 1 });
    await service.receive(incoming());
    await service.receive(incoming(undefined, 1, 777));
    await service.tick();
    await service.tick();
    expect(selector.select).toHaveBeenCalledOnce();
    expect(s.db.prepare('SELECT count(*) AS n FROM reply_jobs').get()).toEqual({ n: 1 });
  });
  it('охватывает новые доступные личные чаты круглосуточно; дубликат обновления не создаёт повтор', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T09:00:00Z'));
    const { service, selector, s, outbox, api } = setup();
    await service.receive(incoming());
    await service.receive(incoming());
    await service.receive(incoming(undefined, 1, 777));
    await service.tick();
    await service.tick();
    await outbox.flush();
    expect(s.db.prepare('SELECT count(*) AS n FROM reply_chats').get()).toEqual({ n: 2 });
    expect(selector.select).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls).toHaveLength(2);
    expect(api.sendMessage.mock.calls.every((c) => c[0] === String(owner))).toBe(true);
  });
  it.each(['window', 'selected'])('не выходит за выбранный режим %s', async (mode) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T09:00:00Z'));
    const { service, selector } = setup(
      mode === 'window'
        ? { BUSINESS_REPLY_SCHEDULE: 'window' }
        : { BUSINESS_REPLY_SCOPE: 'selected' },
    );
    await service.receive(incoming());
    await service.tick();
    expect(selector.select).not.toHaveBeenCalled();
  });
  it('ничего не делает при пустой базе, выключенных темах, dry-run и общей паузе', async () => {
    for (const mode of ['empty', 'dry', 'pause']) {
      const { service, s, selector, api } = setup(
        mode === 'dry' ? { BUSINESS_DRY_RUN: 'true' } : {},
        {},
        mode === 'empty'
          ? new ReplyKnowledge({ version: 1, topics: [] })
          : new ReplyKnowledge(facts()),
      );
      if (mode === 'pause') s.setSetting('business.paused', 'true');
      await service.receive(incoming());
      await service.tick();
      expect(selector.select).not.toHaveBeenCalled();
      expect(api.sendMessage).not.toHaveBeenCalled();
    }
  });
  it('проверяет владельца соединения, направление, бота, возраст и тип чата', async () => {
    const { service, api, selector } = setup();
    api.getBusinessConnection.mockResolvedValueOnce({
      id: 'conn',
      user: { id: 777, is_bot: false, first_name: 'Other' },
      user_chat_id: 777,
      date: 1,
      is_enabled: true,
      rights: { can_reply: true },
    });
    await service.receive(incoming());
    await service.receive({
      ...incoming(undefined, 2),
      chat: { id: -5, type: 'group', title: 'Group' },
    });
    await service.receive({ ...incoming(undefined, 3), date: 1 });
    await service.receive({
      ...incoming(undefined, 4),
      sender_business_bot: { id: 5, is_bot: true, first_name: 'Bot' },
    });
    await service.tick();
    expect(selector.select).not.toHaveBeenCalled();
  });
  it.each(['привет', 'спасибо', '125 × 48', '10/3'])(
    'не смешивает рабочие ответы с приветствиями и математикой: %s',
    async (text) => {
      const { service, selector } = setup();
      await service.receive(incoming(text));
      await service.tick();
      expect(selector.select).not.toHaveBeenCalled();
    },
  );
  it.each([
    { kind: 'ignore', reason: 'personal', entryIds: [], confidence: 1 },
    { kind: 'answer', reason: 'work_question', entryIds: ['unknown'], confidence: 1 },
    { kind: 'answer', reason: 'work_question', entryIds: ['demo_team'], confidence: 0.8 },
    { kind: 'answer', reason: 'work_question', entryIds: ['demo_team'], confidence: NaN },
  ] as ReplySelection[])(
    'не отвечает без подходящего подтверждённого основания %#',
    async (value) => {
      const { service, selector, api, job } = setup();
      selector.select.mockResolvedValue(value);
      await service.receive(incoming());
      await service.tick();
      expect(job()!.state).toBe('ignored');
      expect(api.sendMessage).not.toHaveBeenCalled();
    },
  );
  it('объединяет серию сообщений, отвечает на последнее, не анализирует раньше debounce', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T09:00:00Z'));
    const { service, selector, callback, api } = setup({ BUSINESS_REPLY_DEBOUNCE_SECONDS: '10' });
    await service.receive(incoming('Как создать', 1));
    await service.tick();
    expect(selector.select).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await service.receive(incoming('команду в тестовом проекте?', 2));
    await service.tick();
    expect(selector.select).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11000);
    await service.tick();
    expect(selector.select.mock.calls[0]![0]).toEqual([
      'Как создать',
      'команду в тестовом проекте?',
    ]);
    await service.callback(callback());
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(
      '555',
      expect.stringContaining('Я ИИ-помощник.'),
      expect.objectContaining({
        reply_parameters: { message_id: 2, allow_sending_without_reply: false },
        business_connection_id: 'conn',
      }),
    );
  });
  it('ограничивает burst и не отвечает по обрезанной части вопроса', async () => {
    const { service, selector } = setup();
    await service.receive(incoming('x'.repeat(3001)));
    await service.tick();
    expect(selector.select).not.toHaveBeenCalled();
  });
  it('любое участие владельца, в том числе стикер, отменяет ожидающий ответ', async () => {
    const { service, selector, job } = setup();
    await service.receive(incoming());
    const sticker = outgoing();
    delete sticker.text;
    await service.receive(sticker);
    await service.tick();
    expect(job()!.state).toBe('cancelled');
    expect(selector.select).not.toHaveBeenCalled();
  });
  it('проверяет вмешательство владельца после ожидания модели', async () => {
    const { service, selector, job, api } = setup();
    let finish!: (value: ReplySelection) => void;
    selector.select.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await service.receive(incoming());
    const work = service.tick();
    await Promise.resolve();
    await service.receive(outgoing());
    finish(selected());
    await work;
    expect(job()!.state).toBe('cancelled');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it('новое входящее во время анализа делает старый результат неактуальным и сохраняет всю серию', async () => {
    const { service, selector, s } = setup();
    let finish!: (value: ReplySelection) => void;
    selector.select.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await service.receive(incoming());
    const work = service.tick();
    await Promise.resolve();
    await service.receive(incoming('И уточни условия участия', 2));
    finish(selected());
    await work;
    await service.tick();
    expect(selector.select.mock.calls[1]![0]).toHaveLength(2);
    expect(
      s.db.prepare("SELECT count(*) AS n FROM reply_jobs WHERE state='preview'").get(),
    ).toEqual({ n: 1 });
  });
  it('новый входящий текст отменяет прежний preview даже во время cooldown', async () => {
    const { service, callback, job, api } = setup();
    await service.receive(incoming());
    await service.tick();
    await service.receive(incoming('Вопрос уже неактуален', 2));
    await service.callback(callback());
    expect(job()!.state).toBe('cancelled');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
describe('Изолированный стенд: подтверждение, доставка и восстановление', () => {
  it('preview отправляется только владельцу, точный ответ из KB — по его кнопке, один раз', async () => {
    const { service, selector, outbox, api, callback, job } = setup();
    await service.receive(incoming());
    await service.tick();
    await outbox.flush();
    await service.tick();
    expect(api.sendMessage.mock.calls[0]![0]).toBe(String(owner));
    expect(api.sendMessage.mock.calls[0]![2]).not.toHaveProperty('business_connection_id');
    await service.callback(callback());
    await service.callback(callback('send', 'duplicate'));
    expect(api.sendMessage.mock.calls.filter((c) => c[0] === '555')).toHaveLength(1);
    expect(api.sendMessage.mock.calls[1]![1]).toBe(
      'Я ИИ-помощник.\n\n' + facts().topics[0]!.entries[0]!.answer,
    );
    expect(selector.select).toHaveBeenCalledOnce();
    expect(job()!.state).toBe('sent');
  });
  it('чужой пользователь и групповой callback не могут подтвердить отправку', async () => {
    const { service, callback, api } = setup();
    await service.receive(incoming());
    await service.tick();
    await service.callback(callback('send', 'foreign', 777));
    const group = callback();
    group.message = { ...direct('Preview'), chat: { id: -5, type: 'group', title: 'Group' } };
    await service.callback(group);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it('будущий live-режим перепроверяет права соединения перед отправкой', async () => {
    const { service, api, job } = setup({ BUSINESS_REPLY_MODE: 'live' });
    await service.receive(incoming());
    await service.tick();
    api.getBusinessConnection.mockResolvedValueOnce({
      id: 'conn',
      user: { id: owner, is_bot: false, first_name: 'Owner' },
      user_chat_id: owner,
      date: 1,
      is_enabled: true,
      rights: { can_reply: false },
    });
    await service.tick();
    await service.tick();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(job()!.state).toBe('failed');
  });
  it('вмешательство владельца во время проверки соединения отменяет отправку', async () => {
    const { service, api, callback, job } = setup();
    await service.receive(incoming());
    await service.tick();
    const connection = await api.getBusinessConnection();
    api.getBusinessConnection.mockImplementationOnce(async () => {
      await service.receive(outgoing());
      return connection;
    });
    await service.callback(callback());
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(job()!.state).toBe('cancelled');
  });
  it('отрицательный ответ Telegram и сетевой timeout не вызывают слепой повтор', async () => {
    const { service, api, callback, job, b, c, s, typedApi, outbox, selector } = setup();
    await service.receive(incoming());
    await service.tick();
    api.sendMessage.mockRejectedValueOnce(new Error('ambiguous timeout'));
    await service.callback(callback());
    expect(job()!.state).toBe('uncertain');
    const restarted = new BusinessReplies(
      b,
      c,
      s,
      typedApi,
      outbox,
      selector,
      new ReplyKnowledge(facts()),
    );
    await restarted.callback(callback());
    await restarted.tick();
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
  it('429 повторяется только после указанной задержки', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T09:00:00Z'));
    const { service, api, callback, job } = setup();
    await service.receive(incoming());
    await service.tick();
    api.sendMessage.mockRejectedValueOnce({ error_code: 429, parameters: { retry_after: 5 } });
    await service.callback(callback());
    await service.callback(callback());
    expect(api.sendMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6000);
    await service.callback(callback());
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(job()!.state).toBe('sent');
  });
  it('TTL и истечение записи знаний блокируют отправку', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T09:00:00Z'));
    const data = facts();
    data.topics[0]!.entries[0]!.expiresAt = '2026-10-26T09:01:00Z';
    const { service, api, callback } = setup({}, {}, new ReplyKnowledge(data));
    await service.receive(incoming());
    await service.tick();
    await vi.advanceTimersByTimeAsync(61000);
    await service.callback(callback());
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it('пауза и исключение чата отменяют готовый вариант, возобновление не обходит глобальный флаг', async () => {
    const { service, api, callback, job } = setup();
    await service.receive(incoming());
    await service.tick();
    service.ownerMessage(direct('/reply_block 1'));
    await service.callback(callback());
    expect(job()!.state).toBe('cancelled');
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(service.ownerMessage(direct('/reply_allow 1', 101, 777))).toBe(false);
  });
  it('восстанавливает pending, сохраняет preview и переводит sending в uncertain', async () => {
    const { service, s, b, c, typedApi, outbox, selector, job } = setup();
    await service.receive(incoming());
    s.db.prepare("UPDATE reply_jobs SET state='running'").run();
    const restarted = new BusinessReplies(
      b,
      c,
      s,
      typedApi,
      outbox,
      selector,
      new ReplyKnowledge(facts()),
    );
    await restarted.tick();
    expect(job()!.state).toBe('preview');
    s.db.prepare("UPDATE reply_jobs SET state='sending'").run();
    new BusinessReplies(b, c, s, typedApi, outbox, selector, new ReplyKnowledge(facts()));
    expect(job()!.state).toBe('uncertain');
  });
  it('шифрует вопросы и ответы, очищает содержимое, сохраняя дедупликацию', async () => {
    const { service, s, job, selector } = setup();
    await service.receive(incoming());
    await service.tick();
    expect(job()!.payload).not.toContain('Как создать');
    expect(job()!.answer).not.toContain('учебный портал');
    expect(s.vault.open<ReplyPayload>(job()!.payload).messages[0]!.text).toContain('Как создать');
    s.db.prepare('UPDATE reply_jobs SET created_at=0').run();
    service.prune();
    expect(job()!.payload).toBe('');
    expect(job()!.answer).toBeNull();
    await service.receive(incoming());
    await service.tick();
    expect(selector.select).toHaveBeenCalledOnce();
  });
  it('исчерпанный API-бюджет завершает запрос без отправки', async () => {
    const { service, selector, job, api } = setup();
    selector.select.mockRejectedValue(new Error('API_BUDGET_EXCEEDED'));
    await service.receive(incoming());
    await service.tick();
    await service.tick();
    expect(selector.select).toHaveBeenCalledOnce();
    expect(job()!.state).toBe('failed');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
