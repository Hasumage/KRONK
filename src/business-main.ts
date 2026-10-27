import 'dotenv/config';
import { Bot } from 'grammy';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pino from 'pino';
import { businessSettings } from './config/business.js';
import { Vault } from './security/vault.js';
import { Store } from './storage/database.js';
import { BusinessMath } from './services/business-math.js';
import {
  BusinessCalendar,
  businessCalendarSettings,
  missingCalendarSettings,
} from './services/business-calendar.js';
import { OpenAICalendarEngine, OpenAITaskExtractor } from './adapters/ai.js';
import { GoogleCalendar } from './adapters/calendar.js';
import { OwnerOutbox } from './services/owner-outbox.js';
import { BusinessTasks } from './tasks/service.js';
import { BusinessDocuments } from './documents/service.js';
import { OpenAIDocumentAnalyzer } from './adapters/document-ai.js';
import { downloadTelegramDocument } from './documents/download.js';
import { BusinessReplies } from './replies/service.js';
import { OpenAIReplySelector } from './adapters/reply-ai.js';
import { loadBusinessExtensions } from './extensions/business.js';
import { BusinessJokes } from './jokes/service.js';

const log = pino({ base: null });
async function main(): Promise<void> {
  const c = businessSettings();
  if (!c.BUSINESS_DRY_RUN && !process.argv.includes('--live'))
    throw new Error('EXPLICIT_LIVE_FLAG_REQUIRED');
  const path = resolve(c.BUSINESS_DATABASE_PATH),
    lock = path + '.lock';
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw new Error('BUSINESS_ALREADY_RUNNING');
    unlinkSync(lock);
  }
  writeFileSync(lock, process.pid.toString(), { flag: 'wx', mode: 0o600 });
  let store: Store | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let processing: NodeJS.Timeout | undefined;
  let activeWork: Promise<void> | null = null;
  const bot = new Bot(c.TELEGRAM_BOT_TOKEN, { client: { timeoutSeconds: 40 } });
  try {
    store = new Store(path, new Vault(Buffer.from(c.BUSINESS_ENCRYPTION_KEY, 'base64')));
    const appConfig = businessCalendarSettings(c);
    const missing = missingCalendarSettings(appConfig, store);
    const dependencies =
      c.BUSINESS_CALENDAR_ENABLED && !missing.length
        ? {
            ai: new OpenAICalendarEngine(appConfig, store),
            calendar: new GoogleCalendar(appConfig, store),
          }
        : null;
    const calendar = new BusinessCalendar(c, appConfig, store, bot.api, dependencies, missing);
    const notifications = new OwnerOutbox(store, bot.api, c.OWNER_TELEGRAM_ID, c.BUSINESS_DRY_RUN);
    const taskExtractor =
      appConfig.OPENAI_API_KEY &&
      appConfig.OPENAI_MODEL &&
      appConfig.OPENAI_INPUT_USD_PER_MILLION &&
      appConfig.OPENAI_OUTPUT_USD_PER_MILLION
        ? new OpenAITaskExtractor(appConfig, store)
        : null;
    const tasks = new BusinessTasks(c, appConfig, store, bot.api, notifications, taskExtractor);
    const documentAnalyzer = taskExtractor ? new OpenAIDocumentAnalyzer(appConfig, store) : null;
    const documents = new BusinessDocuments(
      c,
      appConfig,
      store,
      bot.api,
      notifications,
      documentAnalyzer,
      (fileId, maxBytes) =>
        downloadTelegramDocument(bot.api, c.TELEGRAM_BOT_TOKEN, fileId, maxBytes),
    );
    const replySelector = taskExtractor ? new OpenAIReplySelector(appConfig, store) : null;
    const replies = new BusinessReplies(c, appConfig, store, bot.api, notifications, replySelector);
    const extensions = await loadBusinessExtensions(c.BUSINESS_EXTENSION_ENTRY, {
      settings: c,
      appConfig,
      store,
      api: bot.api,
      notifications,
      aiReady: !!taskExtractor,
    });
    const jokes = new BusinessJokes(c, store, bot.api);
    const service = new BusinessMath(
      c,
      store,
      bot.api,
      calendar,
      tasks,
      documents,
      replies,
      jokes,
      extensions,
    );
    await bot.init();
    await bot.api
      .setMyCommands(
        [
          { command: 'tasks', description: 'Открытые задачи и управление' },
          { command: 'add', description: 'Добавить задачу' },
          { command: 'today', description: 'Дедлайны на сегодня' },
          { command: 'overdue', description: 'Просроченные задачи' },
          { command: 'done', description: 'Выполненные задачи' },
          { command: 'archive', description: 'Архив задач' },
          { command: 'find', description: 'Поиск задач' },
          { command: 'task', description: 'Карточка задачи по номеру' },
          { command: 'due', description: 'Изменить дедлайн задачи' },
          { command: 'cancel', description: 'Отменить ввод' },
          { command: 'calendar', description: 'Состояние календаря' },
          { command: 'docs', description: 'История разборов документов' },
          { command: 'analyze', description: 'Разобрать файл через Reply' },
          { command: 'doc', description: 'Открыть выжимку по номеру' },
          { command: 'forget_doc', description: 'Удалить локальную выжимку' },
          { command: 'replies', description: 'Состояние рабочих автоответов' },
          { command: 'reply', description: 'Открыть вариант ответа' },
          { command: 'reply_pause', description: 'Приостановить рабочие автоответы' },
          ...extensions.flatMap((extension) => extension.commands ?? []),
          { command: 'joke', description: 'Спокойная шутка из подборки' },
          { command: 'status', description: 'Состояние ассистента' },
          { command: 'pause', description: 'Приостановить ассистента' },
          { command: 'resume', description: 'Возобновить работу' },
          { command: 'help', description: 'Справка' },
        ],
        { scope: { type: 'chat', chat_id: Number(c.OWNER_TELEGRAM_ID) } },
      )
      .catch(() => store!.audit(null, 'business.commands', 'failed'));
    const webhook = await bot.api.getWebhookInfo();
    if (webhook.url) throw new Error('EXISTING_WEBHOOK_REQUIRES_MIGRATION');
    if (!bot.botInfo.can_connect_to_business) throw new Error('BOT_BUSINESS_MODE_REQUIRED');
    bot.use(async (ctx) => {
      await service.handle(ctx.update);
    });
    bot.catch(() => store!.audit(null, 'business.polling', 'handler_error'));
    server = createServer((req, res) => {
      if (req.url !== '/health') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(bot.isRunning() ? 200 : 503, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(
        JSON.stringify({
          ok: bot.isRunning(),
          transport: 'bot-api-business',
          mathEnabled: c.BUSINESS_MATH_ENABLED,
          jokesEnabled: c.BUSINESS_JOKES_ENABLED,
          calendarEnabled: c.BUSINESS_CALENDAR_ENABLED,
          calendarReady: !!dependencies,
          tasksEnabled: c.BUSINESS_TASKS_ENABLED,
          taskExtractionReady: !!taskExtractor,
          documentsEnabled: c.BUSINESS_DOCUMENTS_ENABLED,
          documentAnalysisReady: !!documentAnalyzer,
          workRepliesEnabled: c.BUSINESS_REPLY_ENABLED,
          workRepliesMode: c.BUSINESS_REPLY_MODE,
          extensionsLoaded: extensions.length,
          dryRun: c.BUSINESS_DRY_RUN,
          paused: store!.getSetting('business.paused') === 'true',
          status: service.status(),
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(c.BUSINESS_HEALTH_PORT, '127.0.0.1', resolve);
    });
    service.prune();
    tasks.prune();
    documents.prune();
    replies.prune();
    for (const extension of extensions) extension.prune?.();
    jokes.prune();
    timer = setInterval(() => {
      service.prune();
      tasks.prune();
      documents.prune();
      replies.prune();
      for (const extension of extensions) extension.prune?.();
      jokes.prune();
      store!.prune(c.BUSINESS_RETENTION_DAYS);
    }, 3600000);
    processing = setInterval(() => {
      if (activeWork) return;
      activeWork = (async () => {
        try {
          await notifications.flush();
          for (const extension of extensions) await extension.tick?.();
          await replies.tick();
          await calendar.tick();
          await tasks.tick();
          await notifications.flush();
          await documents.tick();
          await notifications.flush();
        } catch {
          store!.audit(null, 'business.calendar', 'tick_failed');
        }
      })().finally(() => {
        activeWork = null;
      });
    }, 500);
    const stop = () => {
      if (bot.isRunning()) void bot.stop();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    log.info({
      event: 'business_started',
      bot: bot.botInfo.username,
      math: c.BUSINESS_MATH_ENABLED,
      dryRun: c.BUSINESS_DRY_RUN,
    });
    await bot.start({
      allowed_updates: ['business_connection', 'business_message', 'message', 'callback_query'],
      drop_pending_updates: false,
    });
  } finally {
    clearInterval(timer);
    clearInterval(processing);
    await activeWork;
    if (bot.isRunning()) await bot.stop();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    store?.close();
    unlinkSync(lock);
  }
}
main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message)
      ? error.message
      : 'BUSINESS_STARTUP_OR_NETWORK_ERROR';
  log.error({ event: 'business_failed', code });
  process.exitCode = 1;
});
