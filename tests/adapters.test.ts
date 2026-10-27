import { describe, it, expect, vi, afterEach } from 'vitest';
import { GoogleCalendar } from '../src/adapters/calendar.js';
import { Telegram } from '../src/adapters/telegram.js';
import { harness, analysis } from './helpers.js';
afterEach(() => vi.restoreAllMocks());
describe('Адаптеры внешних сервисов без сети', () => {
  it('Calendar отправляет reminder=60, timezone и stable id; 409 сверяет по GET', async () => {
    const { c, s } = harness();
    try {
      const calendar = new GoogleCalendar(c, s);
      const auth = (calendar as unknown as { auth: { request: (o: unknown) => Promise<unknown> } })
        .auth;
      const event = {
        id: 'stableid',
        htmlLink: 'https://calendar.google.com/event',
        summary: 'Встреча',
        start: { dateTime: '2026-10-29T18:30:00+03:00' },
        end: { dateTime: '2026-10-29T19:30:00+03:00' },
      };
      const request = vi
        .spyOn(auth, 'request')
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockRejectedValueOnce({ response: { status: 409 } })
        .mockResolvedValue({ data: event });
      const result = await calendar.create('stableid', analysis().data);
      expect(result.id).toBe('stableid');
      expect(request.mock.calls[1]?.[0]).toMatchObject({
        method: 'POST',
        data: {
          id: 'stableid',
          start: { timeZone: 'Europe/Moscow' },
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
        },
      });
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      s.close();
    }
  });
  it('Calendar не обещает успех при недоступном API', async () => {
    const { c, s } = harness();
    try {
      const calendar = new GoogleCalendar(c, s);
      const auth = (calendar as unknown as { auth: { request: () => Promise<unknown> } }).auth;
      vi.spyOn(auth, 'request').mockRejectedValue({ response: { status: 503 } });
      await expect(calendar.create('id', analysis().data)).rejects.toMatchObject({
        response: { status: 503 },
      });
    } finally {
      s.close();
    }
  });
  it('outbox адресуется только владельцу и не повторяет неопределённую отправку', async () => {
    const { c, s } = harness();
    try {
      const sendMessage = vi
        .fn()
        .mockRejectedValue(new Error('socket closed after server accepted'));
      const telegram = { c, store: s, bot: { api: { sendMessage } } };
      s.notify('notification', 'Только владельцу');
      await Telegram.prototype.flushOutbox.call(telegram as unknown as Telegram);
      await Telegram.prototype.flushOutbox.call(telegram as unknown as Telegram);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[0]).toBe('1');
      expect(s.db.prepare('SELECT status FROM outbox').get()).toEqual({ status: 'uncertain' });
    } finally {
      s.close();
    }
  });
  it('dry-run не отправляет даже служебные уведомления', async () => {
    const { c, s } = harness({ DRY_RUN: true });
    try {
      const sendMessage = vi.fn();
      s.notify('n', 'Тест');
      await Telegram.prototype.flushOutbox.call({
        c,
        store: s,
        bot: { api: { sendMessage } },
      } as unknown as Telegram);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      s.close();
    }
  });
});
