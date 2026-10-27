import 'dotenv/config';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { businessSettings } from './config/business.js';
import { businessCalendarSettings } from './services/business-calendar.js';
import { Vault } from './security/vault.js';
import { Store } from './storage/database.js';
import { oauth } from './adapters/setup.js';

async function main(): Promise<void> {
  const business = businessSettings(),
    config = businessCalendarSettings(business);
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET)
    throw new Error('GOOGLE_CLIENT_ID_AND_SECRET_REQUIRED');
  const path = resolve(business.BUSINESS_DATABASE_PATH),
    lock = path + '.lock';
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(lock)) {
    let alive = true;
    const pid = Number(readFileSync(lock, 'utf8'));
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw new Error('STOP_BUSINESS_SERVICE_BEFORE_OAUTH');
    unlinkSync(lock);
  }
  writeFileSync(lock, process.pid.toString(), { flag: 'wx', mode: 0o600 });
  let store: Store | undefined;
  try {
    store = new Store(path, new Vault(Buffer.from(business.BUSINESS_ENCRYPTION_KEY, 'base64')));
    await oauth(config, store);
    console.info('Google Calendar подключён. Можно запускать scripts/start-business.ps1.');
  } finally {
    store?.close();
    unlinkSync(lock);
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : 'GOOGLE_OAUTH_FAILED',
  );
  process.exitCode = 1;
});
