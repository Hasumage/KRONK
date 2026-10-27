import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Update } from 'grammy/types';
import { jokes, jokeIntent } from '../src/jokes/library.js';
import { BusinessJokes } from '../src/jokes/service.js';
import { businessSettings } from '../src/config/business.js';
import { Store } from '../src/storage/database.js';
import { Vault } from '../src/security/vault.js';
import { BusinessMath } from '../src/services/business-math.js';

const owner = 123456789,
  stores: Store[] = [];
const message = (
  id = 1,
  text = 'внимание шутка',
): NonNullable<Update['business_message']> & NonNullable<Update['message']> => ({
  message_id: id,
  date: Math.floor(Date.now() / 1000),
  chat: { id: 555, type: 'private', first_name: 'Chat' },
  from: { id: owner, is_bot: false, first_name: 'Owner' },
  business_connection_id: 'conn',
  text,
});
function setup(env: NodeJS.ProcessEnv = {}) {
  const c = businessSettings({
    TELEGRAM_BOT_TOKEN: 'test',
    OWNER_TELEGRAM_ID: String(owner),
    BUSINESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BUSINESS_JOKES_ENABLED: 'true',
    BUSINESS_DRY_RUN: 'false',
    ...env,
  });
  const store = new Store(':memory:', new Vault(randomBytes(32)));
  stores.push(store);
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
      message_id: 91,
    })),
  };
  const service = new BusinessJokes(c, store, api as never);
  const app = new BusinessMath(
    c,
    store,
    api as never,
    undefined,
    undefined,
    undefined,
    undefined,
    service,
  );
  return { c, store, api, service, app };
}
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});
describe('Calm curated jokes', () => {
  it.each([
    'внимание шутка',
    'Внимание, шутка!',
    'сейчас будет шутка',
    'Сейчас  будет шутка.',
    '/joke',
  ])('explicit trigger: %s', (t) => expect(jokeIntent(t)).toBe(true));
  it.each([
    'не сейчас будет шутка',
    'внимание шутка?',
    'он написал: внимание шутка',
    'сейчас будет шутка или нет',
    'обычное сообщение',
  ])('ignores conversation: %s', (t) => expect(jokeIntent(t)).toBe(false));
  it('sends a library joke in same chat independently of math setting', async () => {
    const s = setup();
    await s.app.handle({ update_id: 1, business_message: message() });
    expect(s.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(s.api.sendMessage.mock.calls[0]?.[0]).toBe(555);
    expect(jokes.some((j) => j.text === s.api.sendMessage.mock.calls[0]?.[1])).toBe(true);
    expect(s.api.sendMessage.mock.calls[0]?.[2]).toMatchObject({ business_connection_id: 'conn' });
  });
  it('owner private command sends to owner without business connection', async () => {
    const s = setup();
    const m = message(1, '/joke');
    delete m.business_connection_id;
    m.chat = { id: owner, type: 'private', first_name: 'Owner' };
    await s.app.handle({ update_id: 1, message: m });
    expect(s.api.sendMessage.mock.calls[0]?.[0]).toBe(owner);
    expect(s.api.sendMessage.mock.calls[0]?.[2]).not.toHaveProperty('business_connection_id');
  });
  it('ignores other people, bots, forwards and stale messages', async () => {
    const s = setup();
    const m = message();
    for (const v of [
      { ...m, from: { id: 999, is_bot: false, first_name: 'Other' } },
      { ...m, from: { id: owner, is_bot: true, first_name: 'Bot' } },
      {
        ...m,
        forward_origin: { type: 'hidden_user' as const, sender_user_name: 'Other', date: m.date },
      },
      { ...m, date: m.date - 121 },
      { ...m, date: m.date + 31 },
    ])
      await s.service.receive(v);
    expect(s.api.sendMessage).not.toHaveBeenCalled();
  });
  it('requires current connection ownership and reply permission', async () => {
    const s = setup();
    for (const c of [
      { ...(await s.api.getBusinessConnection()), is_enabled: false },
      { ...(await s.api.getBusinessConnection()), rights: { can_reply: false } },
      {
        ...(await s.api.getBusinessConnection()),
        user: { id: 999, is_bot: false, first_name: 'Other' },
      },
    ]) {
      s.api.getBusinessConnection.mockResolvedValueOnce(c);
      await s.service.receive(message());
    }
    expect(s.api.sendMessage).not.toHaveBeenCalled();
  });
  it.each([{ BUSINESS_JOKES_ENABLED: 'false' }, { BUSINESS_DRY_RUN: 'true' }])(
    'respects module settings %o',
    async (env) => {
      const s = setup(env);
      await s.service.receive(message());
      expect(s.api.sendMessage).not.toHaveBeenCalled();
      expect(s.store.db.prepare('SELECT count(*) AS n FROM joke_deliveries').get()).toEqual({
        n: 0,
      });
    },
  );
  it('checks pause again after network lookup', async () => {
    const s = setup();
    const c = await s.api.getBusinessConnection();
    s.api.getBusinessConnection.mockImplementationOnce(async () => {
      s.store.setSetting('business.paused', 'true');
      return c;
    });
    await s.service.receive(message());
    expect(s.api.sendMessage).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent updates and limits a chat to three per minute', async () => {
    const s = setup();
    await Promise.all([s.service.receive(message()), s.service.receive(message())]);
    await s.service.receive(message(2));
    await s.service.receive(message(3));
    await s.service.receive(message(4));
    expect(s.api.sendMessage).toHaveBeenCalledTimes(3);
  });
  it('uses full library before repeating and persists history across restart', async () => {
    vi.useFakeTimers();
    const s = setup();
    let service = s.service;
    for (let n = 0; n < jokes.length; n++) {
      vi.setSystemTime(Date.now() + 61000);
      if (n === 12) service = new BusinessJokes(s.c, s.store, s.api as never);
      await service.receive(message(n + 1));
    }
    expect(new Set(s.api.sendMessage.mock.calls.map((c) => c[1])).size).toBe(jokes.length);
    vi.setSystemTime(Date.now() + 61000);
    await service.receive(message(100));
    expect(s.api.sendMessage).toHaveBeenCalledTimes(jokes.length + 1);
  });
  it('does not resend a joke after an ambiguous timeout', async () => {
    const s = setup();
    s.api.sendMessage.mockRejectedValueOnce(Error('timeout'));
    await s.service.receive(message());
    await s.service.receive(message());
    expect(s.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(s.store.db.prepare('SELECT state FROM joke_deliveries').get()).toEqual({
      state: 'uncertain',
    });
  });
});
