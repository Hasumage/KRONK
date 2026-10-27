import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
export function businessSettings(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      TELEGRAM_BOT_TOKEN: z.string().min(1),
      OWNER_TELEGRAM_ID: z
        .string()
        .regex(/^[1-9]\d+$/)
        .refine((v) => v !== '1'),
      BUSINESS_ENCRYPTION_KEY: z.string().min(1),
      BUSINESS_DATABASE_PATH: z.string().default('data/business.sqlite'),
      BUSINESS_MATH_ENABLED: bool.default(false),
      BUSINESS_JOKES_ENABLED: bool.default(false),
      BUSINESS_CALENDAR_ENABLED: bool.default(false),
      BUSINESS_TASKS_ENABLED: bool.default(false),
      BUSINESS_TASK_REMINDERS_ENABLED: bool.default(false),
      BUSINESS_DOCUMENTS_ENABLED: bool.default(false),
      BUSINESS_REPLY_ENABLED: bool.default(false),
      BUSINESS_REPLY_MODE: z.enum(['preview', 'live']).default('preview'),
      BUSINESS_REPLY_SCOPE: z.enum(['all', 'selected']).default('all'),
      BUSINESS_REPLY_SCHEDULE: z.enum(['always', 'window']).default('always'),
      BUSINESS_REPLY_KNOWLEDGE_PATH: z.string().default('data/auto-reply-knowledge.json'),
      BUSINESS_REPLY_DEBOUNCE_SECONDS: z.coerce.number().int().min(0).max(60).default(10),
      BUSINESS_REPLY_PREVIEW_TTL_MINUTES: z.coerce.number().int().min(1).max(30).default(10),
      BUSINESS_EXTENSION_ENTRY: z.string().default(''),
      BUSINESS_DRY_RUN: bool.default(true),
      BUSINESS_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
      BUSINESS_MATH_MAX_AGE_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
      BUSINESS_MATH_PER_CHAT_PER_MINUTE: z.coerce.number().int().positive().default(20),
      BUSINESS_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
    })
    .parse(env);
}
export type BusinessSettings = ReturnType<typeof businessSettings>;
