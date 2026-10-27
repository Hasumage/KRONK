import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pino from 'pino';
import { z } from 'zod';
import { settings } from './config/settings.js';
import { localVault } from './security/vault.js';
import { Store } from './storage/database.js';
import { analysisSchema, messageSchema, type ResolvedContext } from './domain/schema.js';
import { MockAI, OpenAIEngine } from './adapters/ai.js';
import { MockCalendar, GoogleCalendar } from './adapters/calendar.js';
import { Telegram } from './adapters/telegram.js';
import { login, oauth } from './adapters/setup.js';
import { Registrations } from './services/registrations.js';
import { Control } from './services/control.js';
import { Worker } from './application/worker.js';

const log = pino({ level: 'info', base: null });
async function main(): Promise<void> {
  const c = settings();
  const command = process.argv[2] ?? 'demo';
  if (!['demo', 'serve', 'inspect', 'login', 'oauth', 'backup'].includes(command))
    throw new Error('UNKNOWN_COMMAND');
  if (c.MODE === 'live' && command === 'serve' && !process.argv.includes('--live'))
    throw new Error('EXPLICIT_LIVE_FLAG_REQUIRED');
  if (c.MODE === 'live' && command === 'demo') throw new Error('DEMO_REQUIRES_MOCK_MODE');
  const path = resolve(c.DATABASE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw new Error('DATABASE_IN_USE');
    unlinkSync(lock);
  }
  writeFileSync(lock, process.pid.toString(), { flag: 'wx', mode: 0o600 });
  let s: Store | undefined;
  let telegram: Telegram | undefined;
  let health: ReturnType<typeof createServer> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let cleanup: NodeJS.Timeout | undefined;
  try {
    s = new Store(path, localVault(path, c.ENCRYPTION_KEY, c.MODE === 'live'));
    const store = s;
    if (command === 'login') {
      await login(c, s);
      return;
    }
    if (command === 'oauth') {
      await oauth(c, s);
      return;
    }
    if (command === 'backup') {
      const destination = process.argv[3];
      if (!destination || existsSync(destination)) throw new Error('NEW_BACKUP_PATH_REQUIRED');
      await s.db.backup(destination);
      log.info({ event: 'backup_complete' });
      return;
    }
    if (command === 'inspect') {
      const rows = s.db
        .prepare('SELECT id,status,payload FROM outbox ORDER BY created_at DESC LIMIT 20')
        .all() as { id: string; status: string; payload: string }[];
      for (const r of rows)
        console.info(JSON.stringify({ ...r, payload: r.payload ? s.vault.open(r.payload) : null }));
      return;
    }
    const fixture = z
      .object({ messages: z.array(messageSchema), analyses: z.record(z.string(), analysisSchema) })
      .parse(JSON.parse(readFileSync('fixtures/demo.json', 'utf8')));
    const knowledgeSchema = z.array(
      z.object({
        id: z.string(),
        topic: z.string(),
        question: z.string(),
        answer: z.string().max(3000),
      }),
    );
    const knowledge: ResolvedContext['knowledge'] = existsSync(c.KNOWLEDGE_PATH)
      ? knowledgeSchema.parse(JSON.parse(readFileSync(c.KNOWLEDGE_PATH, 'utf8')))
      : [];
    const ai = c.MODE === 'live' ? new OpenAIEngine(c, s) : new MockAI(fixture.analyses);
    const calendar = c.MODE === 'live' ? new GoogleCalendar(c, s) : new MockCalendar(c);
    const registrations = new Registrations(c, s);
    const control = new Control(c, s, registrations);
    const worker = new Worker(
      c,
      s,
      ai,
      calendar,
      async (m, max) => {
        if (!telegram) throw new Error('MOCK_ATTACHMENT_NOT_CONFIGURED');
        return telegram.download(m, max);
      },
      registrations,
      async (m, text, id) => {
        if (!telegram) {
          store.audit(id, 'auto_reply', 'mock');
          return;
        }
        await telegram.autoSend(m, text, id);
      },
      knowledge,
    );
    if (command === 'demo') {
      for (const m of fixture.messages) worker.ingest(m);
      while (await worker.tick()) {
        /* Drain ready jobs only. */
      }
      console.info(
        JSON.stringify(
          {
            mode: c.MODE,
            dryRun: c.DRY_RUN,
            jobs: s.db
              .prepare(
                'SELECT message_id,intent,status FROM processed_messages ORDER BY created_at',
              )
              .all(),
          },
          null,
          2,
        ),
      );
      console.info('Предпросмотр уведомлений: npm run inspect');
      return;
    }
    let shuttingDown = false,
      active = false,
      lastTick = Date.now();
    const server = createServer((req, res) => {
      if (req.url !== '/health') {
        res.writeHead(404);
        res.end();
        return;
      }
      const ok = !shuttingDown && Date.now() - lastTick < 120000;
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok,
          mode: c.MODE,
          dryRun: c.DRY_RUN,
          paused: store.getSetting('paused') === 'true',
          jobs: store.db
            .prepare('SELECT status,count(*) AS count FROM processed_messages GROUP BY status')
            .all(),
        }),
      );
    });
    health = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(c.HEALTH_PORT, '0.0.0.0', resolve);
    });
    if (c.MODE === 'live') {
      telegram = new Telegram(c, s);
      await telegram.start(worker, control);
    }
    log.info({ event: 'started', mode: c.MODE, dryRun: c.DRY_RUN });
    timer = setInterval(() => {
      if (active || shuttingDown) return;
      active = true;
      void (async () => {
        try {
          await worker.tick();
          await telegram?.flushOutbox();
          lastTick = Date.now();
          if (store.getSetting('session_revoked') === 'true') process.emit('SIGTERM');
        } catch {
          store.audit(null, 'runtime', 'tick_failed');
        } finally {
          active = false;
        }
      })();
    }, 500);
    store.prune(c.RETENTION_DAYS);
    cleanup = setInterval(() => store.prune(c.RETENTION_DAYS), 3600000);
    await new Promise<void>((resolve) => {
      const stop = () => {
        shuttingDown = true;
        clearInterval(timer);
        clearInterval(cleanup);
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    while (active) await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    clearInterval(timer);
    clearInterval(cleanup);
    await telegram?.stop().catch(() => {});
    if (health?.listening) await new Promise<void>((resolve) => health!.close(() => resolve()));
    s?.close();
    unlinkSync(lock);
  }
}
main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message)
      ? error.message
      : 'CONFIG_OR_RUNTIME_ERROR';
  log.error({
    event: 'startup_or_runtime_failure',
    code,
    message:
      'Проверьте конфигурацию и инструкции README. Секреты и тексты ошибок провайдеров не выводятся.',
  });
  process.exitCode = 1;
});
