import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
const instant = z.iso.datetime({ offset: true });
export const knowledgeSchema = z
  .object({
    version: z.literal(1),
    topics: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
            title: z.string().trim().min(1).max(100),
            enabled: z.boolean(),
            entries: z
              .array(
                z
                  .object({
                    id: z.string().regex(/^[a-z0-9_-]{1,60}$/),
                    question: z.string().trim().min(1).max(500),
                    answer: z.string().trim().min(1).max(1800),
                    source: z.string().trim().min(1).max(500),
                    approved: z.boolean(),
                    expiresAt: instant.nullable(),
                  })
                  .strict(),
              )
              .max(100),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export interface KnowledgeEntry {
  id: string;
  topic: string;
  topicTitle: string;
  question: string;
  answer: string;
  source: string;
  expiresAt: string | null;
}
export class ReplyKnowledge {
  readonly hash: string;
  private readonly entries: KnowledgeEntry[];
  constructor(value: unknown) {
    const data = knowledgeSchema.parse(value),
      ids = new Set<string>();
    for (const topic of data.topics) {
      if (ids.has('topic:' + topic.id)) throw new Error('REPLY_DUPLICATE_TOPIC');
      ids.add('topic:' + topic.id);
      for (const entry of topic.entries) {
        if (ids.has(entry.id)) throw new Error('REPLY_DUPLICATE_ENTRY');
        ids.add(entry.id);
      }
    }
    this.hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    this.entries = data.topics
      .filter((t) => t.enabled)
      .flatMap((t) =>
        t.entries
          .filter((e) => e.approved)
          .map((e) => ({
            id: e.id,
            topic: t.id,
            topicTitle: t.title,
            question: e.question,
            answer: e.answer,
            source: e.source,
            expiresAt: e.expiresAt,
          })),
      );
  }
  active(now = Date.now()) {
    return this.entries.filter((e) => !e.expiresAt || Date.parse(e.expiresAt) > now);
  }
  /** Candidate matching bounds API context; the model still decides if the whole question fits. */
  candidates(text: string, maxChars: number, now = Date.now()): KnowledgeEntry[] {
    const words = (value: string) =>
      new Set(
        value
          .toLowerCase()
          .replace(/ё/g, 'е')
          .match(/[\p{L}\p{N}]{3,}/gu)
          ?.map((w) => w.slice(0, 5)) ?? [],
      );
    const query = words(text);
    const rows = this.active(now)
      .map((entry) => ({
        entry,
        score: [...words(entry.question + ' ' + entry.topicTitle)].filter((w) => query.has(w))
          .length,
      }))
      .sort((a, b) => b.score - a.score);
    const result: KnowledgeEntry[] = [];
    let size = 0;
    for (const row of rows) {
      const length = JSON.stringify(row.entry).length;
      if (size + length > maxChars) continue;
      result.push(row.entry);
      size += length;
      if (result.length === 10) break;
    }
    return result;
  }
}
export function loadReplyKnowledge(path: string): ReplyKnowledge {
  if (statSync(path).size > 256_000) throw new Error('REPLY_KNOWLEDGE_TOO_LARGE');
  return new ReplyKnowledge(JSON.parse(readFileSync(path, 'utf8')));
}
