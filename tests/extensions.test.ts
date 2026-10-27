import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { businessSettings } from '../src/config/business.js';
import { loadBusinessExtensions, type ExtensionContext } from '../src/extensions/business.js';
import { BusinessMath } from '../src/services/business-math.js';
import { Store } from '../src/storage/database.js';
import { Vault } from '../src/security/vault.js';
import type { Update } from 'grammy/types';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
it('standalone core does not load or require an extension', async () => {
  expect(await loadBusinessExtensions('', {} as ExtensionContext)).toEqual([]);
});
it('extension receives messages while core explicit actions remain available', async () => {
  const c = businessSettings({
    TELEGRAM_BOT_TOKEN: 'test',
    OWNER_TELEGRAM_ID: '123456789',
    BUSINESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BUSINESS_MATH_ENABLED: 'true',
    BUSINESS_DRY_RUN: 'false',
  });
  const store = new Store(':memory:', new Vault(randomBytes(32)));
  stores.push(store);
  const api = { sendMessage: vi.fn(), getBusinessConnection: vi.fn() };
  const extension = {
    receive: vi.fn(async () => true),
    status: () => 'Example extension: enabled',
  };
  const calendar = { receive: vi.fn(async () => undefined), status: () => 'Calendar: configured' };
  const core = new BusinessMath(
    c,
    store,
    api as never,
    calendar as never,
    undefined,
    undefined,
    undefined,
    undefined,
    [extension],
  );
  const update: Update = {
    update_id: 1,
    business_message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      business_connection_id: 'test',
      chat: { id: 100, type: 'private', first_name: 'Example' },
      from: { id: 200, is_bot: false, first_name: 'Example' },
      text: '1+1',
    },
  };
  await core.handle(update);
  expect(extension.receive).toHaveBeenCalledTimes(1);
  expect(calendar.receive).toHaveBeenCalledTimes(1);
  expect(api.sendMessage).not.toHaveBeenCalled();
  expect(core.status()).toContain('Example extension: enabled');
});
