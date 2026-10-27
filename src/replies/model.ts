import type { KnowledgeEntry } from './knowledge.js';
export interface ReplySelection {
  kind: 'answer' | 'ignore';
  entryIds: string[];
  confidence: number;
  reason: 'work_question' | 'personal' | 'smalltalk' | 'off_topic' | 'insufficient' | 'ambiguous';
}
export interface ReplySelector {
  select(
    messages: readonly string[],
    knowledge: readonly KnowledgeEntry[],
  ): Promise<ReplySelection>;
}
export interface ReplyChat {
  number: number;
  owner_id: string;
  connection_id: string;
  chat_id: string;
  name: string;
  enabled: number;
  explicit_allow: number;
  owner_active_at: number;
  paused_until: number;
  revision: number;
  cooldown_until: number;
  day: string;
  generated_count: number;
}
export interface ReplyJob {
  number: number;
  id: string;
  owner_id: string;
  chat_number: number;
  state: string;
  payload: string;
  answer: string | null;
  knowledge_hash: string | null;
  chat_revision: number;
  attempts: number;
  available_at: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
}
export interface ReplyPayload {
  messages: { id: number; text: string; date: number }[];
}
export interface ReplyAnswer {
  text: string;
  entryIds: string[];
  sources: string[];
}
