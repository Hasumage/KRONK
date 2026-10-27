import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
const positive = z.coerce.number().int().positive();
const envSchema = z.object({
  MODE: z.enum(['mock', 'live']).default('mock'),
  DRY_RUN: bool.default(true),
  TIMEZONE: z
    .string()
    .default('Europe/Moscow')
    .refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
  DATABASE_PATH: z.string().default('data/kronk.sqlite'),
  ENCRYPTION_KEY: z.string().default(''),
  OWNER_TELEGRAM_ID: z.string().regex(/^\d+$/).default('1'),
  TELEGRAM_API_ID: z.coerce.number().int().default(0),
  TELEGRAM_API_HASH: z.string().default(''),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default(''),
  OPENAI_INPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(0),
  OPENAI_OUTPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(0),
  MONTHLY_API_BUDGET_USD: positive.default(5),
  MAX_OUTPUT_TOKENS: positive.default(2000),
  MAX_CONTEXT_CHARS: positive.default(12000),
  MAX_MESSAGES_PER_DAY: positive.default(200),
  MAX_DOCUMENT_BYTES: positive.default(5_000_000),
  MAX_DOCUMENT_PAGES: positive.default(50),
  MAX_DOCUMENT_CHARS: positive.default(100000),
  DOCUMENT_MAX_OUTPUT_TOKENS: positive.default(6000),
  DOCUMENT_REVIEW_PERSONA: z
    .string()
    .min(1)
    .max(1000)
    .default('Нейтральный разбор содержания, структуры и ясности.'),
  DOCUMENT_VISUAL_MAX_PAGES: positive.max(12).default(8),
  RETENTION_DAYS: positive.default(7),
  DOCUMENT_RETENTION_DAYS: positive.default(7),
  CALENDAR_ENABLED: bool.default(true),
  TASKS_ENABLED: bool.default(true),
  DOCUMENTS_ENABLED: bool.default(false),
  REGISTRATIONS_ENABLED: bool.default(false),
  CALENDAR_REMINDER_MINUTES: positive.max(40320).default(60),
  DEFAULT_EVENT_DURATION_MINUTES: positive.default(60),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CALENDAR_ID: z.string().default('primary'),
  OAUTH_PORT: positive.default(8765),
  AUTO_REPLY_ENABLED: bool.default(false),
  AUTO_REPLY_START: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('23:00'),
  AUTO_REPLY_END: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('08:00'),
  AUTO_REPLY_CHATS: csv,
  AUTO_REPLY_TOPICS: csv,
  AUTO_REPLY_COOLDOWN_MINUTES: positive.default(30),
  AUTO_REPLY_OWNER_PAUSE_MINUTES: positive.default(120),
  AUTO_REPLY_DAILY_LIMIT: positive.default(5),
  KNOWLEDGE_PATH: z.string().default('data/knowledge.json'),
  REGISTRATION_DOMAINS: csv,
  REGISTRATION_PROFILE_PATH: z.string().default('data/profile.json'),
  APPROVAL_TTL_MINUTES: positive.default(10),
  HEALTH_PORT: positive.default(3000),
});
export type Settings = z.infer<typeof envSchema>;
export function settings(env: NodeJS.ProcessEnv = process.env): Settings {
  const c = envSchema.parse(env);
  if (
    c.MODE === 'live' &&
    (!c.OPENAI_API_KEY ||
      !c.OPENAI_MODEL ||
      !c.TELEGRAM_API_HASH ||
      !c.TELEGRAM_API_ID ||
      !c.TELEGRAM_BOT_TOKEN ||
      c.OWNER_TELEGRAM_ID === '1')
  )
    throw new Error('LIVE_CONFIGURATION_INCOMPLETE');
  if (
    c.MODE === 'live' &&
    (!c.ENCRYPTION_KEY || !c.OPENAI_INPUT_USD_PER_MILLION || !c.OPENAI_OUTPUT_USD_PER_MILLION)
  )
    throw new Error('LIVE_KEY_AND_PRICES_REQUIRED');
  return c;
}
