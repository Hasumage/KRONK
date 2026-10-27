import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Bot } from 'grammy';
import type { BusinessConnection, Update } from 'grammy/types';
import { businessSettings } from '../src/config/business.js';
import { BusinessMath, type BusinessApi } from '../src/services/business-math.js';
import { Store } from '../src/storage/database.js';
import { Vault } from '../src/security/vault.js';

type PrivateMessage = NonNullable<Update['business_message']>;
const owner = 123456789;
const connection = (): BusinessConnection => ({
  id: 'connection-1',
  user: { id: owner, is_bot: false, first_name: 'Owner' },
  user_chat_id: owner,
  date: Math.floor(Date.now() / 1000),
  is_enabled: true,
  rights: { can_reply: true },
});
const incoming = (text = '125 × 48', id = 42): PrivateMessage => ({
  message_id: id,
  date: Math.floor(Date.now() / 1000),
  chat: { id: 555, type: 'private', first_name: 'Friend' },
  from: { id: 555, is_bot: false, first_name: 'Friend' },
  business_connection_id: 'connection-1',
  text,
});
const stores: Store[] = [];
function setup() {
  const c = businessSettings({
    TELEGRAM_BOT_TOKEN: 'test',
    OWNER_TELEGRAM_ID: owner.toString(),
    BUSINESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BUSINESS_MATH_ENABLED: 'true',
    BUSINESS_DRY_RUN: 'false',
  });
  const s = new Store(':memory:', new Vault(randomBytes(32)));
  stores.push(s);
  const api = {
    getBusinessConnection: vi.fn(async () => connection()),
    sendMessage: vi.fn(async () => ({ ...incoming(), message_id: 100 })),
  };
  const service = new BusinessMath(c, s, api as unknown as BusinessApi);
  return { c, s, api, service };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
});
describe('Автоматизация чатов: математические ответы', () => {
  it('получает business_message и отвечает в исходном чате от подключённого аккаунта', async () => {
    const { service, api, s } = setup();
    await service.handle({ update_id: 1, business_message: incoming() });
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(
      555,
      '6000',
      expect.objectContaining({
        business_connection_id: 'connection-1',
        reply_parameters: { message_id: 42, allow_sending_without_reply: false },
      }),
    );
    expect(s.db.prepare('SELECT status FROM business_math').get()).toEqual({ status: 'sent' });
    expect(JSON.stringify(s.db.prepare('SELECT * FROM business_math').all())).not.toContain('6000');
  });
  it('отправляет вычисленный десятичный результат деления без подписи', async () => {
    const { service, api } = setup();
    await service.handle({ update_id: 1, business_message: incoming('10/3') });
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(
      555,
      '≈ 3.33',
      expect.objectContaining({ business_connection_id: 'connection-1' }),
    );
  });
  it('отвечает решением уравнения в исходном личном чате', async () => {
    const { service, api } = setup();
    await service.handle({ update_id: 1, business_message: incoming('x+10=2x') });
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(
      555,
      'x = 10',
      expect.objectContaining({ business_connection_id: 'connection-1' }),
    );
  });
  it('повторный update не вызывает повторную отправку', async () => {
    const { service, api } = setup();
    await service.handle({ update_id: 1, business_message: incoming() });
    await service.handle({ update_id: 2, business_message: incoming() });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
  it.each(['Привет', '2026-10-25', '+79991234567', '125 рублей'])(
    'не вмешивается в обычную переписку: %s',
    async (text) => {
      const { service, api } = setup();
      await service.handle({ update_id: 1, business_message: incoming(text) });
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(api.getBusinessConnection).not.toHaveBeenCalled();
    },
  );
  it('игнорирует собственные сообщения, ботов, исправления и старые сообщения', async () => {
    const { service, api } = setup();
    const m = incoming();
    const variants: PrivateMessage[] = [
      { ...m, from: { id: owner, is_bot: false, first_name: 'Owner' } },
      { ...m, from: { id: 555, is_bot: true, first_name: 'Bot' } },
      { ...m, date: m.date - 1000 },
    ];
    for (const message of variants)
      await service.handle({ update_id: 1, business_message: message });
    await service.handle({
      update_id: 2,
      edited_business_message: { ...m, edit_date: m.date + 1 },
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it('проверяет владельца подключения и актуальное право отвечать', async () => {
    const { service, api } = setup();
    for (const c of [
      { ...connection(), is_enabled: false },
      { ...connection(), rights: {} },
      { ...connection(), user: { id: 999, is_bot: false, first_name: 'Other' } },
    ]) {
      api.getBusinessConnection.mockResolvedValue(c);
      await service.handle({ update_id: 1, business_message: incoming() });
    }
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it('paused, выключенный модуль и dry-run не отправляют ответы', async () => {
    const { c, s, service, api } = setup();
    s.setSetting('business.paused', 'true');
    await service.handle({ update_id: 1, business_message: incoming() });
    s.setSetting('business.paused', 'false');
    c.BUSINESS_MATH_ENABLED = false;
    await service.handle({ update_id: 2, business_message: incoming() });
    c.BUSINESS_MATH_ENABLED = true;
    c.BUSINESS_DRY_RUN = true;
    await service.handle({ update_id: 3, business_message: incoming() });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(s.db.prepare('SELECT status FROM business_math').get()).toEqual({ status: 'dry_run' });
  });
  it('не повторяет неоднозначную отправку, в том числе после восстановления сервиса', async () => {
    const { c, s, api, service } = setup();
    api.sendMessage.mockRejectedValue(new Error('lost response after acceptance'));
    await service.handle({ update_id: 1, business_message: incoming() });
    const restarted = new BusinessMath(c, s, api as unknown as BusinessApi);
    await restarted.handle({ update_id: 2, business_message: incoming() });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(s.db.prepare('SELECT status FROM business_math').get()).toEqual({ status: 'uncertain' });
  });
  it('команды паузы доступны только владельцу в личном чате с ботом', async () => {
    const { service, s, api } = setup();
    const { business_connection_id: _, ...m } = incoming('/pause');
    await service.handle({ update_id: 1, message: { ...m, from: m.from! } });
    expect(s.getSetting('business.paused')).toBeNull();
    await service.handle({
      update_id: 2,
      message: {
        ...m,
        from: { id: owner, is_bot: false, first_name: 'Owner' },
        chat: { id: owner, type: 'private', first_name: 'Owner' },
      },
    });
    expect(s.getSetting('business.paused')).toBe('true');
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('ограничивает поток примеров в одном чате', async () => {
    const { service, c, api } = setup();
    c.BUSINESS_MATH_PER_CHAT_PER_MINUTE = 1;
    await service.handle({ update_id: 1, business_message: incoming('2+2', 1) });
    await service.handle({ update_id: 2, business_message: incoming('3+3', 2) });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('настоящий grammY принимает сырой Update и сериализует business_connection_id', async () => {
    const { c, s } = setup();
    const requests: { method: string; payload: unknown }[] = [];
    const bot = new Bot('123:test', {
      botInfo: {
        id: 123,
        is_bot: true,
        first_name: 'Test',
        username: 'test_bot',
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: true,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        can_manage_bots: false,
        supports_join_request_queries: false,
      },
    });
    const fakeCall = async (_prev: unknown, method: string, payload: unknown) => {
      requests.push({ method, payload });
      if (method === 'getBusinessConnection') return { ok: true, result: connection() };
      return { ok: true, result: { ...incoming(), message_id: 100 } };
    };
    bot.api.config.use(fakeCall as Parameters<typeof bot.api.config.use>[0]);
    const service = new BusinessMath(c, s, bot.api);
    bot.use((ctx) => service.handle(ctx.update));
    await bot.handleUpdate({ update_id: 1, business_message: incoming() } as Update);
    expect(requests.find((r) => r.method === 'sendMessage')?.payload).toMatchObject({
      business_connection_id: 'connection-1',
      chat_id: 555,
      text: '6000',
    });
  });
});
