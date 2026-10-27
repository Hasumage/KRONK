import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import type { Settings } from '../config/settings.js';
import type { Store } from '../storage/database.js';

async function prompt(label: string, hidden = false): Promise<string> {
  let mute = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!mute) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
  process.stdout.write(label);
  mute = hidden;
  try {
    return await rl.question('');
  } finally {
    rl.close();
    if (hidden) process.stdout.write('\n');
  }
}
export async function login(c: Settings, s: Store): Promise<void> {
  if (!c.ENCRYPTION_KEY || !c.TELEGRAM_API_ID || !c.TELEGRAM_API_HASH)
    throw new Error('TELEGRAM_SETUP_CONFIG_REQUIRED');
  const client = new TelegramClient(new StringSession(''), c.TELEGRAM_API_ID, c.TELEGRAM_API_HASH, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
  });
  try {
    await client.start({
      phoneNumber: () => prompt('Телефон: '),
      phoneCode: () => prompt('Код Telegram: ', true),
      password: () => prompt('Пароль 2FA: ', true),
      onError: () => {
        throw new Error('TELEGRAM_AUTH_FAILED');
      },
    });
    const me = await client.getMe();
    if (me.id.toString() !== c.OWNER_TELEGRAM_ID) throw new Error('TELEGRAM_OWNER_MISMATCH');
    s.putSecret('telegram', client.session.save());
    s.setSetting('session_revoked', 'false');
    console.info('Telegram-сессия сохранена в зашифрованном виде.');
  } finally {
    await client.disconnect();
  }
}
export async function oauth(c: Settings, s: Store): Promise<void> {
  if (!c.ENCRYPTION_KEY || !c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET)
    throw new Error('GOOGLE_SETUP_CONFIG_REQUIRED');
  const redirect = `http://127.0.0.1:${c.OAUTH_PORT}/callback`;
  const auth = new OAuth2Client(c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET, redirect);
  const state = randomBytes(32).toString('hex');
  const pkce = await auth.generateCodeVerifierAsync();
  await new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', redirect);
        const received = Buffer.from(url.searchParams.get('state') ?? '');
        const expected = Buffer.from(state);
        if (
          url.pathname !== '/callback' ||
          received.length !== expected.length ||
          !timingSafeEqual(received, expected) ||
          !url.searchParams.get('code')
        ) {
          res.writeHead(400);
          res.end('Invalid callback');
          return;
        }
        const result = await auth.getToken({
          code: url.searchParams.get('code')!,
          codeVerifier: pkce.codeVerifier,
          redirect_uri: redirect,
        });
        s.putSecret('google', result.tokens);
        res.end('Google Calendar connected. You may close this tab.');
        clearTimeout(timer);
        server.close();
        resolve();
      })().catch(() => {
        res.writeHead(500);
        res.end('OAuth failed');
        clearTimeout(timer);
        server.close();
        reject(new Error('OAUTH_FAILED'));
      });
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('OAUTH_TIMEOUT'));
    }, 300000);
    server.on('error', () => {
      clearTimeout(timer);
      reject(new Error('OAUTH_LISTEN_FAILED'));
    });
    server.listen(c.OAUTH_PORT, '127.0.0.1', () =>
      console.info(
        'Откройте в браузере для подключения Calendar:\n' +
          auth.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: ['https://www.googleapis.com/auth/calendar.events'],
            state,
            code_challenge: pkce.codeChallenge!,
            code_challenge_method: CodeChallengeMethod.S256,
          }),
      ),
    );
  });
}
