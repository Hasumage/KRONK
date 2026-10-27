import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { BusinessConnection, Message } from 'grammy/types';
import { businessSettings } from '../src/config/business.js';
import { BusinessCalendar, businessCalendarSettings } from '../src/services/business-calendar.js';
import { BusinessMath, type BusinessApi } from '../src/services/business-math.js';
import { OwnerOutbox } from '../src/services/owner-outbox.js';
import { MockAI } from '../src/adapters/ai.js';
import { MockCalendar } from '../src/adapters/calendar.js';
import { Store } from '../src/storage/database.js';
import { Vault } from '../src/security/vault.js';
import { emptyAnalysis, type Analysis } from '../src/domain/schema.js';

const owner = 123456789;
const asReply = (m: Message): NonNullable<Message['reply_to_message']> => {
  const copy = { ...m };
  delete copy.reply_to_message;
  return copy as unknown as NonNullable<Message['reply_to_message']>;
};
type BusinessMessage = NonNullable<import('grammy/types').Update['business_message']>;
const incoming = (
  id = 101,
  text = '29 октября в 18:30 встречаемся, адрес позже',
): BusinessMessage => ({
  business_connection_id: 'conn',
  message_id: id,
  date: Math.floor(Date.now() / 1000),
  chat: { id: 555, type: 'private', first_name: 'Friend' },
  from: { id: 555, is_bot: false, first_name: 'Friend' },
  text,
});
const outgoing = (text = 'Хорошо, буду, занесу в календарь', id = 102): BusinessMessage => ({
  ...incoming(id, text),
  from: { id: owner, is_bot: false, first_name: 'Owner' },
});
const connection: BusinessConnection = {
  id: 'conn',
  user: { id: owner, is_bot: false, first_name: 'Owner' },
  user_chat_id: owner,
  date: 1,
  is_enabled: true,
  rights: { can_reply: true },
};
const a = (): Analysis => ({
  ...emptyAnalysis(),
  intent: 'calendar.create',
  confidence: 0.99,
  explicitUserIntent: true,
  evidence: 'занесу в календарь',
  attendance: 'accepted',
  sourceMessageIds: ['101', '102'],
  data: { ...emptyAnalysis().data, title: 'Встреча', startAt: '2026-10-29T18:30:00+03:00' },
});
const stores: Store[] = [];
function setup(ready = true) {
  const b = businessSettings({
    TELEGRAM_BOT_TOKEN: 'test',
    OWNER_TELEGRAM_ID: owner.toString(),
    BUSINESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BUSINESS_CALENDAR_ENABLED: 'true',
    BUSINESS_MATH_ENABLED: 'true',
    BUSINESS_DRY_RUN: 'false',
  });
  const c = businessCalendarSettings(b, {}),
    s = new Store(':memory:', new Vault(randomBytes(32)));
  stores.push(s);
  const api = {
    getBusinessConnection: vi.fn(async () => connection),
    sendMessage: vi.fn(async (_chat: number | string, _text: string, _options?: object) => ({
      ...incoming(),
      message_id: 999,
    })),
  };
  const ai = new MockAI({ '102': a() }),
    calendar = new MockCalendar(c),
    bridge = new BusinessCalendar(
      b,
      c,
      s,
      api as unknown as BusinessApi,
      ready ? { ai, calendar } : null,
      ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    );
  const math = new BusinessMath(b, s, api as unknown as BusinessApi, bridge),
    outbox = new OwnerOutbox(s, api as unknown as BusinessApi, b.OWNER_TELEGRAM_ID, false);
  return { b, c, s, api, ai, calendar, bridge, math, outbox };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
});
describe('Календарь через Автоматизацию чатов', () => {
  it('только исходящее намерение владельца создаёт событие и подтверждение отдельно в ЛС', async () => {
    const { math, bridge, calendar, api, outbox, s } = setup();
    await math.handle({ update_id: 1, business_message: incoming() });
    await bridge.tick();
    expect(calendar.events.size).toBe(0);
    await math.handle({ update_id: 2, business_message: outgoing() });
    expect(api.sendMessage).not.toHaveBeenCalled();
    await bridge.tick();
    await outbox.flush();
    expect(calendar.events.size).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(
      owner.toString(),
      expect.stringContaining('✅ Занесено в календарь.'),
      expect.objectContaining({ link_preview_options: { is_disabled: true } }),
    );
    expect(api.sendMessage.mock.calls[0]?.[2]).not.toHaveProperty('business_connection_id');
    expect(s.db.prepare('SELECT status FROM processed_messages').get()).toEqual({
      status: 'succeeded',
    });
  });
  it.each(['занесу в календарь', 'впишу себе', 'отмечу у себя', 'забью встречу'])(
    'фраза собеседника не вызывает создание или уведомление: %s',
    async (phrase) => {
      const { math, bridge, calendar, api, outbox } = setup();
      await math.handle({ update_id: 1, business_message: incoming(101, phrase) });
      await bridge.tick();
      await outbox.flush();
      expect(calendar.events.size).toBe(0);
      expect(api.sendMessage).not.toHaveBeenCalled();
    },
  );
  it('обычное согласие и отказ от встречи не создают событий', async () => {
    for (const declined of [false, true]) {
      const { math, bridge, calendar, ai } = setup();
      vi.spyOn(ai, 'classify').mockResolvedValue(
        declined ? { ...a(), attendance: 'declined' } : emptyAnalysis(),
      );
      await math.handle({ update_id: 1, business_message: incoming() });
      await math.handle({
        update_id: 2,
        business_message: outgoing(declined ? 'Нет, не смогу, занесу в календарь' : 'Да, буду'),
      });
      await bridge.tick();
      expect(calendar.events.size).toBe(0);
    }
  });
  it('ошибка модели не превращает обычное согласие в разрешение на создание', async () => {
    const { bridge, calendar, ai } = setup();
    vi.spyOn(ai, 'classify').mockResolvedValue({ ...a(), evidence: 'Да, буду' });
    await bridge.receive(incoming());
    await bridge.receive(outgoing('Да, буду'));
    await bridge.tick();
    expect(calendar.events.size).toBe(0);
  });
  it('обычное исходящее сообщение не ставится в очередь и не вызывает модель', async () => {
    const { bridge, ai, s } = setup();
    const classify = vi.spyOn(ai, 'classify');
    await bridge.receive(incoming());
    await bridge.receive(outgoing('Да, буду'));
    await bridge.tick();
    expect(classify).not.toHaveBeenCalled();
    expect(s.db.prepare('SELECT count(*) AS n FROM processed_messages').get()).toEqual({ n: 0 });
  });
  it('похожие фразы проходят семантический анализ, а не фиксированный триггер', async () => {
    const { bridge, calendar, ai } = setup();
    vi.spyOn(ai, 'classify').mockResolvedValue({ ...a(), evidence: 'добавлю себе встречу' });
    await bridge.receive(incoming());
    await bridge.receive(outgoing('Добавлю себе встречу в календарь'));
    await bridge.tick();
    expect(calendar.events.size).toBe(1);
  });
  it.each([
    'Ок, закину в календарь',
    'Впишу себе',
    'Отмечу у себя',
    'Помечу себе',
    'Забью встречу',
  ])('неформальная фраза владельца запускает запись по контексту: %s', async (phrase) => {
    const { bridge, calendar, ai, api, outbox } = setup();
    vi.spyOn(ai, 'classify').mockResolvedValue({ ...a(), evidence: phrase });
    await bridge.receive(incoming());
    await bridge.receive(outgoing(phrase));
    await bridge.tick();
    await outbox.flush();
    expect(calendar.events.size).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(
      owner.toString(),
      expect.stringContaining('Занесено в календарь'),
      expect.not.objectContaining({ business_connection_id: expect.anything() }),
    );
  });
  it('Reply даёт контекст даже если исходное сообщение не было в кэше', async () => {
    const { bridge, calendar } = setup();
    await bridge.receive({ ...outgoing(), reply_to_message: asReply(incoming()) });
    await bridge.tick();
    expect(calendar.events.size).toBe(1);
  });
  it('уточнение даты запрашивается в личке и Reply владельца продолжает исходную операцию', async () => {
    const { bridge, ai, calendar, api, outbox, s } = setup();
    vi.spyOn(ai, 'classify').mockResolvedValue({ ...a(), data: { ...a().data, startAt: null } });
    await bridge.receive(incoming());
    await bridge.receive(outgoing());
    await bridge.tick();
    await outbox.flush();
    expect(calendar.events.size).toBe(0);
    expect(api.sendMessage.mock.calls[0]?.[0]).toBe(owner.toString());
    const reply: Message = {
      message_id: 77,
      date: Math.floor(Date.now() / 1000),
      chat: { id: owner, type: 'private', first_name: 'Owner' },
      from: { id: owner, is_bot: false, first_name: 'Owner' },
      text: '29 октября, 18:30',
      reply_to_message: asReply({
        ...incoming(),
        message_id: 999,
        chat: { id: owner, type: 'private', first_name: 'Owner' },
      }),
    };
    expect(bridge.ownerMessage(reply)).toBe(true);
    vi.mocked(ai.classify).mockResolvedValue(a());
    await bridge.tick();
    await outbox.flush();
    expect(calendar.events.size).toBe(1);
    expect(s.db.prepare("SELECT count(*) AS n FROM outbox WHERE status='sent'").get()).toEqual({
      n: 3,
    });
  });
  it('сбой Google не приводит к ложному подтверждению; повтор и дубликат update не дублируют событие', async () => {
    const { bridge, calendar, s, outbox, api } = setup();
    const original = calendar.create.bind(calendar);
    let attempts = 0;
    vi.spyOn(calendar, 'create').mockImplementation(async (id, d) => {
      const event = await original(id, d);
      if (++attempts === 1) throw new Error('lost response after write');
      return event;
    });
    await bridge.receive(incoming());
    await bridge.receive(outgoing());
    await bridge.tick();
    await outbox.flush();
    expect(api.sendMessage).not.toHaveBeenCalled();
    s.db.prepare('UPDATE processed_messages SET available_at=0').run();
    await bridge.tick();
    await bridge.receive(outgoing());
    await bridge.tick();
    await outbox.flush();
    expect(calendar.events.size).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('отсутствующие настройки дают только честное личное уведомление о необходимости подключения', async () => {
    const { bridge, calendar, outbox, api } = setup(false);
    await bridge.receive(incoming());
    await bridge.receive(outgoing());
    await bridge.tick();
    await outbox.flush();
    expect(calendar.events.size).toBe(0);
    expect(api.sendMessage.mock.calls[0]?.[0]).toBe(owner.toString());
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain('Событие пока не создано');
    expect(api.sendMessage.mock.calls[0]?.[1]).not.toContain('✅');
  });
  it('не запускает другие намерения, свои бот-сообщения, чужое соединение и режим паузы', async () => {
    const { bridge, calendar, ai, api, s } = setup();
    const classify = vi.spyOn(ai, 'classify');
    api.getBusinessConnection.mockResolvedValue({
      ...connection,
      user: { id: 99, is_bot: false, first_name: 'Other' },
    });
    await bridge.receive(outgoing());
    expect(classify).not.toHaveBeenCalled();
    api.getBusinessConnection.mockResolvedValue(connection);
    s.setSetting('business.paused', 'true');
    await bridge.receive(outgoing());
    await bridge.tick();
    expect(classify).not.toHaveBeenCalled();
    s.setSetting('business.paused', 'false');
    await bridge.receive({
      ...outgoing(),
      sender_business_bot: { id: 999, is_bot: true, first_name: 'Bot' },
    });
    await bridge.tick();
    expect(classify).not.toHaveBeenCalled();
    classify.mockResolvedValue({ ...a(), intent: 'calendar.cancel' });
    await bridge.receive(outgoing());
    await bridge.tick();
    expect(calendar.events.size).toBe(0);
  });
});
