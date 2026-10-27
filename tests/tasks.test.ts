import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { CallbackQuery, Message } from 'grammy/types';
import { Store } from '../src/storage/database.js';
import { Vault } from '../src/security/vault.js';
import { businessSettings } from '../src/config/business.js';
import { businessCalendarSettings } from '../src/services/business-calendar.js';
import { OwnerOutbox } from '../src/services/owner-outbox.js';
import { BusinessTasks, type TaskApi } from '../src/tasks/service.js';
import { BusinessMath } from '../src/services/business-math.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { normalizeDeadline, dueToday } from '../src/tasks/deadline.js';
import { taskIntent } from '../src/tasks/intent.js';
import { taskCard, taskList } from '../src/tasks/ui.js';
import type { TaskExtraction, TaskJobPayload, TaskRequest } from '../src/tasks/model.js';

const owner = 123456789;
const stores: Store[] = [];
const source = { chatId: '555', sourceMessageId: '100', triggerMessageId: '101' };
const data = { title: 'Отправить отчёт', description: null, dueAt: null, dueDate: null };
const result = (): TaskExtraction => ({
  ...data,
  hasDeadline: false,
  clearDeadline: false,
  requiresClarification: false,
  question: null,
  confidence: 0.99,
});
function message(text: string, id = 1, business = false, author = owner): Message {
  return {
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    chat: { id: business ? 555 : owner, type: 'private', first_name: 'Chat' },
    from: { id: author, is_bot: false, first_name: 'Author' },
    text,
    ...(business ? { business_connection_id: 'conn' } : {}),
  };
}
function reply(m: Message, parent: Message): Message {
  return { ...m, reply_to_message: parent as NonNullable<Message['reply_to_message']> };
}
function setup(extra: NodeJS.ProcessEnv = {}) {
  const b = businessSettings({
    TELEGRAM_BOT_TOKEN: 'test',
    OWNER_TELEGRAM_ID: String(owner),
    BUSINESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BUSINESS_TASKS_ENABLED: 'true',
    BUSINESS_TASK_REMINDERS_ENABLED: 'true',
    BUSINESS_DRY_RUN: 'false',
    ...extra,
  });
  const c = businessCalendarSettings(b, {}),
    store = new Store(':memory:', new Vault(randomBytes(32)));
  stores.push(store);
  let sentId = 1000;
  const api = {
    getBusinessConnection: vi.fn(async () => ({
      id: 'conn',
      user: { id: owner, is_bot: false, first_name: 'Owner' },
      user_chat_id: owner,
      date: 1,
      is_enabled: true,
      rights: { can_reply: true },
    })),
    sendMessage: vi.fn(async (_chat: number | string, text: string, _options?: object) =>
      message(text, ++sentId),
    ),
    editMessageText: vi.fn(async () => true),
    answerCallbackQuery: vi.fn(async () => true),
  };
  const typedApi = api as unknown as TaskApi;
  const outbox = new OwnerOutbox(store, typedApi, String(owner), b.BUSINESS_DRY_RUN);
  const extractor = { extract: vi.fn(async (_r: TaskRequest) => result()) };
  const service = new BusinessTasks(b, c, store, typedApi, outbox, extractor);
  const math = new BusinessMath(b, store, typedApi, undefined, service);
  const callback = (action: string, id = 'callback-1'): CallbackQuery => ({
    id,
    from: { id: owner, is_bot: false, first_name: 'Owner' },
    chat_instance: 'chat',
    message: message('Card', 100),
    data: action,
  });
  return {
    b,
    c,
    store,
    api,
    typedApi,
    outbox,
    extractor,
    service,
    repo: service.repo,
    math,
    callback,
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
});

describe('Намерения задач', () => {
  it.each([
    'добавлю себе в задачи',
    'закину в таски',
    'запиши задачу: купить молоко',
    'поставь задачу отправить отчёт',
    'занесу в туду',
  ])('создаёт: %s', (text) => expect(taskIntent(text)).toBe('create'));
  it.each([
    'сделаю завтра',
    'у меня много задач',
    'не добавляй в задачи',
    'не буду закрывать задачу',
    'он сказал «добавлю в задачи»',
    'не сделал',
  ])('не создаёт и не закрывает: %s', (text) => expect(taskIntent(text, true)).toBeNull());
  it.each(['закрой задачу #1', 'Сделал, можно закрывать', 'готово'])(
    'закрывает с Reply: %s',
    (text) => expect(taskIntent(text, true)).toBe('complete'),
  );
  it('готово без связи не закрывает', () => expect(taskIntent('готово')).toBeNull());
});
describe('Сроки и жизненный цикл', () => {
  it('дата без времени — конец дня в Москве; неверная дата отклоняется', () => {
    expect(normalizeDeadline(null, '2026-10-27', 'Europe/Moscow').dueSort).toBe(
      Date.parse('2026-10-27T23:59:59.999+03:00'),
    );
    expect(() => normalizeDeadline(null, '2026-02-30', 'Europe/Moscow')).toThrow();
    expect(() =>
      normalizeDeadline('2026-10-27T12:00:00+03:00', '2026-10-27', 'Europe/Moscow'),
    ).toThrow();
    expect(() => normalizeDeadline('2026-10-27T12:00:00', null, 'Europe/Moscow')).toThrow();
  });
  it('правильно учитывает зону и переход DST', () => {
    const due = normalizeDeadline(null, '2026-10-25', 'Europe/Berlin');
    expect(due.dueSort).toBe(Date.parse('2026-10-25T23:59:59.999+01:00'));
    expect(
      dueToday(
        Date.parse('2026-10-26T21:30:00Z'),
        'Europe/Moscow',
        Date.parse('2026-10-27T08:00:00Z'),
      ),
    ).toBe(true);
  });
  it('создание идемпотентно, содержимое зашифровано, другой владелец не видит задачу', () => {
    const { repo, store } = setup();
    const a = repo.create('id', data, source);
    expect(repo.create('id', { ...data, title: 'Duplicate' }, source).number).toBe(a.number);
    expect(repo.all()).toHaveLength(1);
    expect(JSON.stringify(store.db.prepare('SELECT payload FROM tasks').get())).not.toContain(
      data.title,
    );
    expect(new TaskRepository(store, '777', 'Europe/Moscow').get(a.number)).toBeNull();
    expect(repo.get(NaN)).toBeNull();
  });
  it('выполнение, архив, восстановление и повторное открытие сохраняют смысл статусов', () => {
    const { repo } = setup();
    const t = repo.create('id', data, source);
    repo.transition(t.number, 'done', 'done', 1);
    expect(repo.list('open').count).toBe(0);
    expect(repo.list('done').count).toBe(1);
    repo.transition(t.number, 'archive', 'archive', 2);
    expect(repo.list('done').count).toBe(0);
    expect(repo.list('archive').count).toBe(1);
    expect(repo.transition(t.number, 'restore', 'restore', 3).status).toBe('done');
    const open = repo.transition(t.number, 'open', 'reopen', 4);
    expect(open.completedAt).toBeNull();
    expect(open.archivedAt).toBeNull();
    expect(repo.list('open').count).toBe(1);
    expect(repo.transition(t.number, 'open', 'reopen', 4).revision).toBe(5);
    expect(() => repo.transition(t.number, 'done', 'stale', 1)).toThrow('TASK_STALE');
  });
  it('редактирование сохраняет прежний срок, срок можно убрать, архив защищён', () => {
    const { repo } = setup();
    const t = repo.create('id', { ...data, dueDate: '2026-11-01' }, source);
    const edited = repo.edit(t.number, { title: 'Новый отчёт' }, 'edit', 1);
    expect(edited.dueDate).toBe('2026-11-01');
    expect(repo.edit(t.number, { dueAt: null, dueDate: null }, 'clear', 2).dueSort).toBeNull();
    repo.transition(t.number, 'archive', 'archive', 3);
    expect(() => repo.edit(t.number, { title: 'oops' }, 'bad', 4)).toThrow('TASK_ARCHIVED');
  });
  it('сортирует по сроку, фильтрует и разбивает на страницы, ищет включая архив', () => {
    const { repo } = setup();
    for (let i = 0; i < 8; i++)
      repo.create(
        'id' + i,
        { ...data, title: 'Отчёт ' + i, dueDate: i === 0 ? '2026-10-27' : null },
        source,
      );
    const first = repo.list('open');
    expect(first.count).toBe(8);
    expect(first.tasks).toHaveLength(6);
    expect(first.tasks[0]!.title).toBe('Отчёт 0');
    expect(repo.list('open', 1).tasks).toHaveLength(2);
    const t = first.tasks[0]!;
    repo.transition(t.number, 'archive', 'a');
    expect(repo.list('all', 0, 'отчет 0').count).toBe(1);
    expect(repo.list('open', 0, 'отчет 0').count).toBe(0);
    expect(repo.list('today', 0, '', Date.parse('2026-10-27T10:00:00Z')).count).toBe(0);
    expect(JSON.stringify(taskCard(repo.get(t.number)!, 'Europe/Moscow'))).toContain('restore');
    expect(JSON.stringify(taskList(repo))).toContain('task:list:open:1');
  });
  it('напоминание одно на срок, только у открытых; новый срок имеет новое напоминание', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
    const { repo } = setup();
    const t = repo.create('id', { ...data, dueAt: '2026-10-26T11:00:00Z' }, source);
    expect(repo.reminderCandidates()).toHaveLength(0);
    vi.setSystemTime(new Date('2026-10-26T11:01:00Z'));
    expect(repo.reminderCandidates()).toHaveLength(1);
    repo.markReminded(repo.get(t.number)!);
    expect(repo.reminderCandidates()).toHaveLength(0);
    repo.edit(t.number, { dueAt: '2026-10-26T12:00:00Z' }, 'reschedule', 1);
    vi.setSystemTime(new Date('2026-10-26T12:01:00Z'));
    expect(repo.reminderCandidates()).toHaveLength(1);
    repo.transition(t.number, 'done', 'done');
    expect(repo.reminderCandidates()).toHaveLength(0);
  });
});
describe('Живой маршрут Business API и личный задачник', () => {
  it('Reply владельца создаёт одну задачу, подтверждение с кнопками только в ЛС', async () => {
    const { math, service, extractor, repo, outbox, api } = setup();
    const parent = message('Пришли отчёт до пятницы', 100, true, 555);
    const own = reply(message('добавлю в задачи', 101, true), parent);
    extractor.extract.mockResolvedValue({ ...result(), hasDeadline: true, dueDate: '2026-10-30' });
    await math.handle({
      update_id: 1,
      business_message: own as NonNullable<import('grammy/types').Update['business_message']>,
    });
    await service.receive(own);
    await service.tick();
    await service.tick();
    await outbox.flush();
    expect(repo.all()).toHaveLength(1);
    expect(extractor.extract).toHaveBeenCalledOnce();
    expect(extractor.extract.mock.calls[0]![0].context.map((m) => m.text)).toContain(parent.text);
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(
      String(owner),
      expect.stringContaining('Задача добавлена'),
      expect.objectContaining({
        reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
      }),
    );
    expect(api.sendMessage.mock.calls[0]![2]).not.toHaveProperty('business_connection_id');
    await service.receive(reply(message('готово', 102, true), parent));
    await outbox.flush();
    expect(repo.all()[0]!.status).toBe('done');
    await service.receive(reply(message('готово', 102, true), parent));
    await outbox.flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });
  it('собеседник, бот, старое сообщение и чужая связь не создают задачу', async () => {
    const { service, extractor, repo, api } = setup();
    await service.receive(message('добавлю в задачи', 1, true, 555));
    await service.receive({
      ...message('добавлю в задачи', 2, true),
      from: { id: owner, is_bot: true, first_name: 'Bot' },
    });
    await service.receive({
      ...message('добавлю в задачи', 3, true),
      date: Math.floor(Date.now() / 1000) - 200,
    });
    api.getBusinessConnection.mockResolvedValueOnce({
      id: 'other',
      user: { id: 777, is_bot: false, first_name: 'Other' },
      user_chat_id: 777,
      date: 1,
      is_enabled: true,
      rights: { can_reply: true },
    });
    await service.receive({
      ...message('добавлю в задачи', 4, true),
      business_connection_id: 'other',
    });
    await service.tick();
    expect(repo.all()).toHaveLength(0);
    expect(extractor.extract).not.toHaveBeenCalled();
  });
  it('пауза/dry-run исключают изменения; чтение доступно; чужие ЛС и кнопки игнорируются', async () => {
    const { service, store, repo, callback, api } = setup();
    const t = repo.create('id', data, source);
    store.setSetting('business.paused', 'true');
    await service.ownerMessage(message('/add Купить хлеб'));
    await service.tick();
    await service.callback(callback(`task:done:${t.number}:1`));
    expect(repo.get(t.number)!.status).toBe('open');
    expect(await service.ownerMessage(message('/tasks'))).toBe(true);
    expect(await service.ownerMessage(message('/tasks', 2, false, 777))).toBe(false);
    const foreign = callback(`task:done:${t.number}:1`, 'foreign');
    foreign.from.id = 777;
    await service.callback(foreign);
    expect(api.editMessageText).not.toHaveBeenCalled();
    const dry = setup({ BUSINESS_DRY_RUN: 'true' });
    await dry.service.ownerMessage(message('/add Test'));
    await dry.service.tick();
    expect(dry.repo.all()).toHaveLength(0);
  });
  it('кнопки обновляют карточку; устаревшая кнопка не перезаписывает новое состояние', async () => {
    const { service, repo, callback, api } = setup();
    const t = repo.create('id', data, source);
    await service.callback(callback(`task:done:${t.number}:1`));
    await service.callback(callback(`task:archive:${t.number}:1`, 'stale'));
    expect(repo.get(t.number)!.status).toBe('done');
    expect(repo.get(t.number)!.archivedAt).toBeNull();
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.answerCallbackQuery).toHaveBeenLastCalledWith(
      'stale',
      expect.objectContaining({ text: expect.stringContaining('уже изменилась') }),
    );
  });
  it('последовательные уточнения не теряются и каждый вопрос доставляется', async () => {
    const { service, extractor, outbox, api, repo } = setup();
    extractor.extract
      .mockResolvedValueOnce({ ...result(), requiresClarification: true, question: 'Что сделать?' })
      .mockResolvedValueOnce({ ...result(), requiresClarification: true, question: 'Когда?' })
      .mockResolvedValueOnce({ ...result(), dueDate: '2026-10-30', hasDeadline: true });
    await service.ownerMessage(message('/add Добавь это'));
    await service.tick();
    await outbox.flush();
    const question1 = api.sendMessage.mock.results[0]!;
    const sent1 = await question1.value;
    await service.ownerMessage(reply(message('Отправить отчёт', 2), sent1));
    await service.tick();
    await outbox.flush();
    const sent2 = api.sendMessage.mock.calls.findIndex((c) => c[1].startsWith('Когда?'));
    expect(sent2).toBeGreaterThanOrEqual(0);
    await service.ownerMessage(
      reply(message('В пятницу', 3), await api.sendMessage.mock.results[sent2]!.value),
    );
    await service.tick();
    expect(extractor.extract.mock.calls[2]![0].clarification).toContain('Отправить отчёт');
    expect(extractor.extract.mock.calls[2]![0].clarification).toContain('В пятницу');
    expect(repo.all()).toHaveLength(1);
  });
  it('перенос срока не меняет текст; редактирование без срока сохраняет его', async () => {
    const { service, repo, extractor, callback, outbox, api } = setup();
    const t = repo.create('id', { ...data, dueDate: '2026-11-01' }, source);
    extractor.extract.mockResolvedValueOnce({
      ...result(),
      title: 'Не менять',
      hasDeadline: true,
      dueDate: '2026-11-02',
    });
    await service.ownerMessage(message(`/due ${t.number} до понедельника`));
    await service.tick();
    expect(repo.get(t.number)!.title).toBe(data.title);
    expect(repo.get(t.number)!.dueDate).toBe('2026-11-02');
    await service.callback(callback(`task:edit:${t.number}:2`));
    await outbox.flush();
    const idx = api.sendMessage.mock.calls.findIndex((c) => c[1].includes('новым названием'));
    extractor.extract.mockResolvedValueOnce({ ...result(), title: 'Обновлённый отчёт' });
    await service.ownerMessage(
      reply(message('Обновлённый отчёт', 2), await api.sendMessage.mock.results[idx]!.value),
    );
    await service.tick();
    expect(repo.get(t.number)!.dueDate).toBe('2026-11-02');
    expect(repo.get(t.number)!.title).toBe('Обновлённый отчёт');
    await service.ownerMessage(message(`/due ${t.number} без срока`, 3));
    expect(repo.get(t.number)!.dueSort).toBeNull();
  });
  it('изменение во время извлечения не затирается; очередь восстанавливается после перезапуска', async () => {
    const { service, repo, store, b, c, typedApi, outbox, extractor } = setup();
    const t = repo.create('id', data, source);
    await service.ownerMessage(message(`/due ${t.number} завтра`));
    store.db.prepare("UPDATE task_jobs SET state='running'").run();
    const restarted = new BusinessTasks(b, c, store, typedApi, outbox, extractor);
    repo.transition(t.number, 'archive', 'archived');
    extractor.extract.mockResolvedValueOnce({
      ...result(),
      dueDate: '2026-11-01',
      hasDeadline: true,
    });
    await restarted.tick();
    expect(repo.get(t.number)!.dueDate).toBeNull();
    expect(store.db.prepare('SELECT state FROM task_jobs').get()).toEqual({ state: 'failed' });
  });
  it('неоднозначный срок требует уточнения; ошибки повторяются ограниченно', async () => {
    const { service, extractor, repo, store } = setup();
    extractor.extract.mockResolvedValueOnce({ ...result(), hasDeadline: true });
    await service.ownerMessage(message('/add Отчёт когда-нибудь'));
    await service.tick();
    expect(repo.all()).toHaveLength(0);
    expect(store.db.prepare('SELECT state FROM task_jobs').get()).toEqual({
      state: 'awaiting_input',
    });
    extractor.extract.mockRejectedValue(new Error('network'));
    await service.ownerMessage(message('/add Отчёт', 2));
    for (let i = 0; i < 3; i++) {
      store.db
        .prepare("UPDATE task_jobs SET available_at=0 WHERE state IN ('pending','retry')")
        .run();
      await service.tick();
    }
    expect(
      store.db.prepare("SELECT count(*) AS n FROM task_jobs WHERE state='failed'").get(),
    ).toEqual({ n: 1 });
  });
  it('одно напоминание после срока и перезапуска, доставка только владельцу', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
    const { service, repo, outbox, api, store, b, c, typedApi, extractor } = setup();
    repo.create('id', { ...data, dueAt: '2026-10-26T11:00:00Z' }, source);
    vi.setSystemTime(new Date('2026-10-26T11:01:00Z'));
    await service.tick();
    await outbox.flush();
    const restarted = new BusinessTasks(b, c, store, typedApi, outbox, extractor);
    await restarted.tick();
    await outbox.flush();
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage.mock.calls[0]![0]).toBe(String(owner));
    expect(api.sendMessage.mock.calls[0]![1]).toContain('Истёк дедлайн');
  });
  it('шифрует очередь и чистит старые данные, сохраняя защиту от дублей', async () => {
    const { service, store } = setup();
    await service.ownerMessage(message('/add Секретный отчёт'));
    const job = store.db.prepare('SELECT id,payload FROM task_jobs').get() as {
      id: string;
      payload: string;
    };
    expect(job.payload).not.toContain('Секретный');
    expect(store.vault.open<TaskJobPayload>(job.payload).request.text).toContain('Секретный');
    store.db.prepare('UPDATE task_jobs SET created_at=0').run();
    service.prune();
    expect(store.db.prepare('SELECT state,payload FROM task_jobs').get()).toEqual({
      state: 'failed',
      payload: '',
    });
    await service.ownerMessage(message('/add Секретный отчёт'));
    expect(store.db.prepare('SELECT count(*) AS n FROM task_jobs').get()).toEqual({ n: 1 });
  });
});
