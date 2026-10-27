import { z } from 'zod';

export const refSchema = z
  .object({ accountId: z.string(), chatId: z.string(), messageId: z.string() })
  .strict();
export const messageSchema = z
  .object({
    ref: refSchema,
    senderId: z.string(),
    direction: z.enum(['incoming', 'outgoing']),
    text: z.string(),
    sentAt: z.iso.datetime({ offset: true }),
    replyTo: refSchema.nullable(),
    generatedByAssistant: z.boolean(),
    attachment: z
      .object({ name: z.string(), size: z.number(), mime: z.string() })
      .nullable()
      .default(null),
  })
  .strict();
export type InputMessage = z.infer<typeof messageSchema>;
export const analysisSchema = z
  .object({
    intent: z.enum([
      'none',
      'calendar.create',
      'calendar.update',
      'calendar.cancel',
      'task.create',
      'task.complete',
      'registration.prepare',
      'document.summarize',
      'auto_reply',
    ]),
    confidence: z.number().min(0).max(1),
    explicitUserIntent: z.boolean(),
    evidence: z.string().nullable(),
    attendance: z.enum(['accepted', 'declined', 'unknown']),
    requiresClarification: z.boolean(),
    question: z.string().nullable(),
    sourceMessageIds: z.array(z.string()),
    data: z
      .object({
        title: z.string().nullable(),
        description: z.string().nullable(),
        startAt: z.string().nullable(),
        endAt: z.string().nullable(),
        location: z.string().nullable(),
        dueAt: z.string().nullable(),
        targetId: z.string().nullable(),
        url: z.string().nullable(),
        documentMessageId: z.string().nullable(),
        topic: z.string().nullable(),
        knowledgeId: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type Analysis = z.infer<typeof analysisSchema>;
export const emptyAnalysis = (): Analysis => ({
  intent: 'none',
  confidence: 1,
  explicitUserIntent: false,
  evidence: null,
  attendance: 'unknown',
  requiresClarification: false,
  question: null,
  sourceMessageIds: [],
  data: {
    title: null,
    description: null,
    startAt: null,
    endAt: null,
    location: null,
    dueAt: null,
    targetId: null,
    url: null,
    documentMessageId: null,
    topic: null,
    knowledgeId: null,
  },
});
export interface ResolvedContext {
  trigger: InputMessage;
  messages: InputMessage[];
  now: string;
  timezone: string;
  clarification: string | null;
  candidates: {
    tasks: { id: string; title: string; sourceMessageId: string }[];
    events: { id: string; title: string; sourceMessageId: string }[];
  };
  knowledge: { id: string; topic: string; question: string; answer: string }[];
}
