import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault } from '../src/security/vault.js';
import { Store, operationKey } from '../src/storage/database.js';
import { emptyAnalysis } from '../src/domain/schema.js';
import { resolveContext } from '../src/application/context.js';
import { decide, inNightWindow } from '../src/application/policy.js';
import { Control } from '../src/services/control.js';
import { harness, message, analysis, ref } from './helpers.js';

const stores: Store[] = [];
const h = (...args: Parameters<typeof harness>) => {
  const result = harness(...args);
  stores.push(result.s);
  return result;
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) if (s.db.open) s.close();
});
describe('Приёмка: календарь и задачи', () => {
  it('обычное согласие не создаёт действие', async () => {
    const { w, s, calendar } = h({}, { '102': emptyAnalysis() });
    w.ingest(message('102', 'Да, буду'));
    await w.tick();
    expect(calendar.events.size).toBe(0);
    expect(s.db.prepare('SELECT status FROM processed_messages').get()).toEqual({
      status: 'denied',
    });
  });
  it('создаёт одно событие, не придумывает адрес, отмечает длительность', async () => {
    const { w, s, calendar } = h();
    expect(w.ingest(message())).toBe(true);
    expect(w.ingest(message())).toBe(false);
    await w.tick();
    expect(await w.tick()).toBe(false);
    expect(calendar.events.size).toBe(1);
    const event = [...calendar.events.values()][0]!;
    expect(event.location).toBeNull();
    expect(Date.parse(event.endAt) - Date.parse(event.startAt)).toBe(3600000);
    const out = s.db.prepare('SELECT payload FROM outbox').get() as { payload: string };
    const text = s.vault.open<string>(out.payload);
    expect(text).toContain('за 60 мин');
    expect(text).toContain('принята по умолчанию');
  });
  it('отказ от посещения блокирует создание', async () => {
    const a = { ...analysis(), attendance: 'declined' as const };
    const { w, calendar } = h({}, { '102': a });
    w.ingest(message('102', 'Нет, не смогу, занесу в календарь'));
    await w.tick();
    expect(calendar.events.size).toBe(0);
  });
  it('неизвестная дата вызывает вопрос только владельцу; уточнение продолжает операцию', async () => {
    const a = analysis('calendar.create', { startAt: null });
    const { w, s, ai, calendar } = h({}, { '102': a });
    w.ingest(message());
    await w.tick();
    expect(calendar.events.size).toBe(0);
    expect(s.db.prepare('SELECT status FROM processed_messages').get()).toEqual({
      status: 'awaiting_input',
    });
    expect(s.clarify(operationKey(message()), '29 октября в 18:30')).toBe(true);
    vi.spyOn(ai, 'classify').mockResolvedValue(analysis());
    await w.tick();
    expect(calendar.events.size).toBe(1);
  });
  it('Reply создаёт задачу с исходным сообщением и без придуманного дедлайна', async () => {
    const { w, s } = h(
      {},
      { '102': analysis('task.create', { title: 'Подготовить вопросы', startAt: null }) },
    );
    w.ingest(message('102', 'Добавлю себе в задачник'));
    await w.tick();
    const row = s.db.prepare('SELECT source_message_id,payload,status FROM tasks').get() as {
      source_message_id: string;
      payload: string;
      status: string;
    };
    expect(row.source_message_id).toBe('101');
    expect(row.status).toBe('open');
    expect(s.vault.open<{ dueAt: null }>(row.payload).dueAt).toBeNull();
  });
  it('несколько задач: не закрывает произвольную', async () => {
    const { w, s } = h({}, { '102': analysis('task.complete', { targetId: 'task-a' }) });
    for (const id of ['task-a', 'task-b'])
      s.db
        .prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?)')
        .run(id, '1', '10', '101', s.vault.seal({ title: 'Вопросы' }), 'open', Date.now());
    w.ingest(message('102', 'Сделал', true, null));
    await w.tick();
    expect(s.db.prepare("SELECT count(*) AS n FROM tasks WHERE status='open'").get()).toEqual({
      n: 2,
    });
    expect(s.db.prepare('SELECT status FROM processed_messages').get()).toEqual({
      status: 'awaiting_input',
    });
  });
  it('исходящее сообщение постороннего и поддельная evidence запрещены', () => {
    const { c, s } = h();
    const m = message();
    const ctx = resolveContext(s, c, m, null, []);
    expect(decide(c, { ...ctx, trigger: { ...m, senderId: '99' } }, analysis()).kind).toBe('deny');
    expect(decide(c, ctx, { ...analysis(), evidence: 'не было такой фразы' }).kind).toBe('deny');
    expect(decide(c, ctx, { ...analysis(), sourceMessageIds: ['999'] }).kind).toBe('deny');
  });
  it('явное изменение и отмена однозначно связанного события', async () => {
    const { w, s, ai, calendar } = h();
    w.ingest(message());
    await w.tick();
    const id = operationKey(message());
    vi.spyOn(ai, 'classify').mockResolvedValue({
      ...analysis('calendar.update', { targetId: id, startAt: '2026-10-30T18:30:00+03:00' }),
      evidence: 'Перенеси',
      sourceMessageIds: ['102', '103'],
    });
    w.ingest(message('103', 'Перенеси встречу на 30 октября', true, '102'));
    await w.tick();
    expect(calendar.events.get(id)?.startAt).toBe('2026-10-30T18:30:00+03:00');
    vi.mocked(ai.classify).mockResolvedValue({
      ...analysis('calendar.cancel', { targetId: id }),
      evidence: 'Отмени',
      sourceMessageIds: ['102', '104'],
    });
    w.ingest(message('104', 'Отмени встречу', true, '102'));
    await w.tick();
    expect(calendar.events.size).toBe(0);
    expect(s.db.prepare('SELECT status FROM events').get()).toEqual({ status: 'cancelled' });
  });
  it('Reply закрывает единственную связанную задачу', async () => {
    const { w, s, ai } = h({}, { '102': analysis('task.create', { title: 'Вопросы' }) });
    w.ingest(message('102', 'Добавлю себе в задачник'));
    await w.tick();
    vi.spyOn(ai, 'classify').mockResolvedValue({
      ...analysis('task.complete', { targetId: operationKey(message()) }),
      sourceMessageIds: ['101', '103'],
    });
    w.ingest(message('103', 'Сделал', true, '101'));
    await w.tick();
    expect(s.db.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'done' });
  });
  it('выключенный модуль и dry-run не выполняют предметные операции', async () => {
    for (const flags of [{ CALENDAR_ENABLED: false }, { DRY_RUN: true }]) {
      const { w, calendar, s } = h(flags);
      w.ingest(message());
      await w.tick();
      expect(calendar.events.size).toBe(0);
      expect(s.db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    }
  });
});
describe('Приёмка: автоответы', () => {
  function auto() {
    return {
      ...analysis('auto_reply', { topic: 'work', knowledgeId: 'kb' }),
      explicitUserIntent: false,
      evidence: null,
    };
  }
  function config() {
    return {
      AUTO_REPLY_ENABLED: true,
      AUTO_REPLY_CHATS: ['10'],
      AUTO_REPLY_TOPICS: ['work'],
      AUTO_REPLY_START: '23:00',
      AUTO_REPLY_END: '08:00',
    };
  }
  it('личное входящее ночью остаётся без ответа', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T22:00:00Z'));
    const { w, autoSend } = h(config(), { '102': emptyAnalysis() });
    w.ingest(message('102', 'Привет, скучаю', false, null));
    await w.tick();
    expect(autoSend).not.toHaveBeenCalled();
  });
  it('разрешённый вопрос: один маркированный ответ из базы на серию', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T22:00:00Z'));
    const { w, autoSend } = h(config(), {
      '102': auto(),
      '103': { ...auto(), sourceMessageIds: ['103'] },
    });
    w.ingest(message('102', 'Как создать команду?', false, null));
    await w.tick();
    w.ingest(message('103', 'Подскажи?', false, null));
    await w.tick();
    expect(autoSend).toHaveBeenCalledTimes(1);
    expect(autoSend.mock.calls[0]?.[1]).toContain('Я ИИ-помощник.');
  });
  it('активность владельца приостанавливает ответы', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T22:00:00Z'));
    const { w, autoSend } = h(config(), { '102': auto() });
    w.ingest({ ...message('owner', 'Я отвечу сам', true, null), sentAt: new Date().toISOString() });
    w.ingest(message('102', 'Как создать команду?', false, null));
    while (await w.tick()) {}
    expect(autoSend).not.toHaveBeenCalled();
  });
  it('дневное окно и отсутствующая база блокируют ответ', () => {
    expect(inNightWindow(new Date('2026-10-25T09:00:00Z'), 'Europe/Moscow', '23:00', '08:00')).toBe(
      false,
    );
    expect(inNightWindow(new Date('2026-10-25T21:00:00Z'), 'Europe/Moscow', '23:00', '08:00')).toBe(
      true,
    );
  });
});
describe('Приёмка: восстановление и управление', () => {
  it('сбой после создания у провайдера не дублирует событие при повторе', async () => {
    const { w, s, calendar } = h();
    const create = calendar.create.bind(calendar);
    let calls = 0;
    vi.spyOn(calendar, 'create').mockImplementation(async (id, d) => {
      const e = await create(id, d);
      if (++calls === 1) throw new Error('connection lost after commit');
      return e;
    });
    w.ingest(message());
    await w.tick();
    expect(s.db.prepare('SELECT status FROM processed_messages').get()).toEqual({
      status: 'retry',
    });
    s.db.prepare('UPDATE processed_messages SET available_at=0').run();
    await w.tick();
    expect(calendar.events.size).toBe(1);
    expect(s.db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 });
  });
  it('перезапуск сохраняет дедупликацию и не повторяет неопределённое уведомление', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kronk-test-')),
      path = join(dir, 'db.sqlite'),
      vault = new Vault(randomBytes(32));
    try {
      const a = h({}, undefined, path, vault);
      a.w.ingest(message());
      await a.w.tick();
      a.s.db.prepare("UPDATE outbox SET status='sending'").run();
      a.s.close();
      const b = h({}, undefined, path, vault);
      expect(b.w.ingest(message())).toBe(false);
      expect(b.s.db.prepare('SELECT status FROM outbox').get()).toEqual({ status: 'uncertain' });
      b.s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('служебный бот игнорирует чужие команды и группы', async () => {
    const { c, s, registration } = h();
    const control = new Control(c, s, registration);
    expect(await control.handle('99', true, '/pause')).toBeNull();
    expect(await control.handle('1', false, '/pause')).toBeNull();
    expect(s.getSetting('paused')).toBeNull();
    expect(await control.handle('1', true, '/pause')).toContain('приостановлена');
    expect(s.getSetting('paused')).toBe('true');
  });
  it('обрезает контекст Reply до ограниченной цепочки в том же чате', () => {
    const { s, c } = h();
    s.db.prepare('DELETE FROM messages WHERE message_id=?').run('101');
    s.remember({
      ...message('101', 'Контекст', false, null),
      replyTo: { ...ref('else'), chatId: '999' },
    });
    const ctx = resolveContext(s, c, message(), null, []);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]?.text).toBe('Контекст');
  });
  it('ограниченный кэш не теряет контекст уже принятой операции', async () => {
    const { w, s, calendar } = h();
    w.ingest(message());
    for (let i = 200; i < 230; i++)
      s.remember(message(i.toString(), 'Новое сообщение', false, null));
    expect(s.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 20 });
    expect(s.message('1', '10', '101')).toBeNull();
    await w.tick();
    expect(calendar.events.size).toBe(1);
  });
  it('retention очищает содержимое, сохраняя ключ дедупликации', async () => {
    const { w, s } = h();
    w.ingest(message());
    await w.tick();
    s.db.prepare('UPDATE processed_messages SET updated_at=0').run();
    s.db.prepare('UPDATE messages SET created_at=0').run();
    s.prune(1);
    expect(s.db.prepare('SELECT payload FROM processed_messages').get()).toEqual({ payload: '' });
    expect(w.ingest(message())).toBe(false);
  });
});
