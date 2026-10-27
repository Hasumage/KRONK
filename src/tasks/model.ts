import type { InlineKeyboardMarkup, ForceReply } from 'grammy/types';
import type { InputMessage } from '../domain/schema.js';
export interface TaskData {
  title: string;
  description: string | null;
  dueAt: string | null;
  dueDate: string | null;
}
export interface Task extends TaskData {
  id: string;
  number: number;
  owner: string;
  chatId: string;
  sourceMessageId: string;
  triggerMessageId: string | null;
  status: 'open' | 'done' | 'cancelled';
  revision: number;
  archivedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
  dueSort: number | null;
}
export type TaskFilter = 'open' | 'done' | 'archive' | 'today' | 'overdue' | 'all';
export type TaskAction = 'done' | 'open' | 'archive' | 'restore';
export interface TaskCard {
  text: string;
  photoBase64?: string;
  replyMarkup?: InlineKeyboardMarkup | ForceReply;
}
export interface TaskRequest {
  mode: 'create' | 'deadline' | 'edit';
  text: string;
  referenceTime: string;
  timezone: string;
  context: InputMessage[];
  replyMessageId: string | null;
  clarification: string | null;
  current: TaskData | null;
}
export interface TaskExtraction {
  title: string | null;
  description: string | null;
  dueAt: string | null;
  dueDate: string | null;
  hasDeadline: boolean;
  clearDeadline: boolean;
  requiresClarification: boolean;
  question: string | null;
  confidence: number;
}
export interface TaskExtractor {
  extract(request: TaskRequest): Promise<TaskExtraction>;
}
export interface TaskJobPayload {
  request: TaskRequest;
  source: InputMessage;
}
export interface TaskJob {
  id: string;
  kind: TaskRequest['mode'];
  task_number: number | null;
  expected_revision: number | null;
  state: string;
  payload: string;
  attempts: number;
  created_at: number;
}
