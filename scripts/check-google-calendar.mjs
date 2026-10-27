import 'dotenv/config';
import Database from 'better-sqlite3';
import { OAuth2Client } from 'google-auth-library';
import { businessSettings } from '../dist/config/business.js';
import { businessCalendarSettings } from '../dist/services/business-calendar.js';
import { Vault } from '../dist/security/vault.js';

// Read-only DB access: do not invoke queue recovery against the running service.
let db;
try {
  const business = businessSettings(),
    config = businessCalendarSettings(business);
  db = new Database(business.BUSINESS_DATABASE_PATH, { readonly: true, fileMustExist: true });
  const row = db.prepare("SELECT value FROM secrets WHERE key='google'").get();
  db.close();
  db = null;
  if (!row) throw new Error('GOOGLE_OAUTH_REQUIRED');
  const credentials = new Vault(Buffer.from(business.BUSINESS_ENCRYPTION_KEY, 'base64')).open(
    row.value,
  );
  const auth = new OAuth2Client(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
  auth.setCredentials(credentials);
  const response = await auth.request({
    url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.GOOGLE_CALENDAR_ID)}/events`,
    params: { maxResults: 1, fields: 'kind,timeZone' },
    timeout: 15000,
    retry: false,
  });
  console.info(
    JSON.stringify({
      ok: true,
      calendar: config.GOOGLE_CALENDAR_ID,
      timeZone: response.data.timeZone ?? null,
      eventDetailsPrinted: false,
      eventsCreated: 0,
    }),
  );
} catch (error) {
  console.info(
    JSON.stringify({
      ok: false,
      status: error.response?.status ?? null,
      reason:
        error.response?.data?.error?.errors?.[0]?.reason ??
        (error.message === 'GOOGLE_OAUTH_REQUIRED'
          ? 'GOOGLE_OAUTH_REQUIRED'
          : 'GOOGLE_CALENDAR_CHECK_FAILED'),
    }),
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
