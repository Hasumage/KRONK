import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Api } from 'grammy';
import { OwnerOutbox } from '../src/services/owner-outbox.js';
import { Store } from '../src/storage/database.js';
import { Vault } from '../src/security/vault.js';

const stores: Store[] = [];
function setup(dryRun = false) {
  const store = new Store(':memory:', new Vault(randomBytes(32)));
  stores.push(store);
  const sendMessage = vi.fn(async (_chat: string | number, _text: string, _options?: object) => ({
    message_id: 91,
  }));
  const api = { sendMessage } as unknown as Pick<Api, 'sendMessage'>;
  return { store, sendMessage, outbox: new OwnerOutbox(store, api, '123456789', dryRun) };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
describe('Личные подтверждения владельцу', () => {
  it('доставляет скриншот только владельцу и не повторяет его', async () => {
    const { store } = setup();
    const sendPhoto = vi.fn(async (_chat: string) => ({ message_id: 92 }));
    const sendMessage = vi.fn();
    const box = new OwnerOutbox(store, { sendMessage, sendPhoto } as never, '123456789', false);
    box.enqueue('photo', {
      text: 'Запись подтверждена',
      photoBase64: Buffer.from('png').toString('base64'),
    });
    await box.flush();
    await box.flush();
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendPhoto.mock.calls[0]?.[0]).toBe('123456789');
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('доставляет один раз лично владельцу без business_connection_id', async () => {
    const { store, sendMessage, outbox } = setup();
    store.notify('result', '✅ Занесено в календарь.');
    await outbox.flush();
    await outbox.flush();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('123456789', '✅ Занесено в календарь.', {
      link_preview_options: { is_disabled: true },
    });
    expect(store.db.prepare('SELECT status,telegram_message_id FROM outbox').get()).toEqual({
      status: 'sent',
      telegram_message_id: '91',
    });
  });
  it('не повторяет отправку с неизвестным результатом', async () => {
    const { store, sendMessage, outbox } = setup();
    sendMessage.mockRejectedValue(new Error('connection lost'));
    store.notify('result', 'Уведомление');
    await outbox.flush();
    await outbox.flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(store.db.prepare('SELECT status FROM outbox').get()).toEqual({ status: 'uncertain' });
  });
  it('ждёт retry_after при явном 429', async () => {
    const { store, sendMessage, outbox } = setup();
    sendMessage.mockRejectedValueOnce({ error_code: 429, parameters: { retry_after: 30 } });
    store.notify('result', 'Уведомление');
    await outbox.flush();
    await outbox.flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    store.setSetting('owner.outbox.backoff', '0');
    await outbox.flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
  it('dry-run не пишет даже владельцу', async () => {
    const { store, sendMessage, outbox } = setup(true);
    store.notify('result', 'Уведомление');
    await outbox.flush();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
