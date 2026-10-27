import type { Settings } from '../config/settings.js';
import type { Analysis, ResolvedContext } from '../domain/schema.js';
import { z } from 'zod';
import { hasCalendarCommitment } from '../domain/calendar-intent.js';

export type Decision =
  { kind: 'deny'; reason: string } | { kind: 'clarify'; question: string } | { kind: 'allow' };
export const validInstant = (s: string | null): s is string =>
  !!s && z.iso.datetime({ offset: true }).safeParse(s).success && Number.isFinite(Date.parse(s));
export function inNightWindow(now: Date, timezone: string, start: string, end: string): boolean {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return start < end ? time >= start && time < end : start > end && (time >= start || time < end);
}
export function decide(c: Settings, ctx: ResolvedContext, a: Analysis): Decision {
  const deny = (reason: string): Decision => ({ kind: 'deny', reason });
  const ask = (question: string): Decision => ({ kind: 'clarify', question });
  const m = ctx.trigger;
  if (m.generatedByAssistant || a.intent === 'none') return deny('no_action');
  const enabled = a.intent.startsWith('calendar.')
    ? c.CALENDAR_ENABLED
    : a.intent.startsWith('task.')
      ? c.TASKS_ENABLED
      : a.intent === 'registration.prepare'
        ? c.REGISTRATIONS_ENABLED
        : a.intent === 'document.summarize'
          ? c.DOCUMENTS_ENABLED
          : c.AUTO_REPLY_ENABLED;
  if (!enabled) return deny('module_disabled');
  const ids = new Set([m.ref.messageId, ...ctx.messages.map((v) => v.ref.messageId)]);
  if (!a.sourceMessageIds.length || a.sourceMessageIds.some((id) => !ids.has(id)))
    return deny('invalid_sources');
  if (a.intent === 'auto_reply') {
    if (
      m.direction !== 'incoming' ||
      m.senderId === c.OWNER_TELEGRAM_ID ||
      !c.AUTO_REPLY_CHATS.includes(m.ref.chatId) ||
      !a.data.topic ||
      !c.AUTO_REPLY_TOPICS.includes(a.data.topic)
    )
      return deny('auto_reply_scope');
    if (!inNightWindow(new Date(), c.TIMEZONE, c.AUTO_REPLY_START, c.AUTO_REPLY_END))
      return deny('daytime');
    if (
      a.confidence < 0.95 ||
      a.requiresClarification ||
      !ctx.knowledge.some((k) => k.id === a.data.knowledgeId && k.topic === a.data.topic)
    )
      return deny('no_grounding');
    return { kind: 'allow' };
  }
  if (m.direction !== 'outgoing' || m.senderId !== c.OWNER_TELEGRAM_ID) return deny('owner_only');
  if (!a.sourceMessageIds.includes(m.ref.messageId)) return deny('missing_owner_source');
  // Evidence must be an actual substring of the owner's trigger, not an incoming instruction.
  if (
    !a.explicitUserIntent ||
    !a.evidence ||
    !m.text.toLocaleLowerCase().includes(a.evidence.toLocaleLowerCase())
  )
    return deny('no_explicit_owner_intent');
  if (a.intent === 'calendar.create' && !hasCalendarCommitment(m.text))
    return deny('calendar_intent_marker_missing');
  if (a.confidence < 0.9 || a.requiresClarification)
    return ask(a.question ?? 'Уточните, какое действие выполнить и с какими параметрами.');
  if (a.intent === 'calendar.create') {
    if (a.attendance === 'declined') return deny('attendance_declined');
    if (!a.data.title || !validInstant(a.data.startAt))
      return ask('Как назвать событие и на какую дату и время его поставить?');
    if (
      a.data.endAt &&
      (!validInstant(a.data.endAt) || Date.parse(a.data.endAt) <= Date.parse(a.data.startAt))
    )
      return ask('Уточните время окончания встречи.');
  }
  if (a.intent === 'calendar.update' || a.intent === 'calendar.cancel') {
    if (!a.data.targetId || !ctx.candidates.events.some((e) => e.id === a.data.targetId))
      return ask('Какое именно событие изменить или отменить?');
    if (!boundTarget(ctx, ctx.candidates.events, a.data.targetId))
      return ask('Уточните событие: укажите его ID или ответьте на исходное сообщение.');
    if (
      a.intent === 'calendar.update' &&
      (!validInstant(a.data.startAt) ||
        (a.data.endAt &&
          (!validInstant(a.data.endAt) || Date.parse(a.data.endAt) <= Date.parse(a.data.startAt))))
    )
      return ask('Уточните новую дату и время события.');
  }
  if (a.intent === 'task.create') {
    if (
      !m.replyTo ||
      !ctx.messages.some((v) => v.ref.messageId === m.replyTo?.messageId) ||
      !a.data.title
    )
      return ask('Ответьте через Reply на сообщение, которое нужно добавить в задачи.');
    if (a.data.dueAt && !validInstant(a.data.dueAt)) return ask('Уточните срок задачи.');
  }
  if (
    a.intent === 'task.complete' &&
    (!a.data.targetId || !boundTarget(ctx, ctx.candidates.tasks, a.data.targetId))
  )
    return ask('Какую именно задачу закрыть? Укажите её ID из /tasks.');
  if (a.intent === 'registration.prepare' && !a.data.url)
    return ask('Пришлите ссылку на мероприятие.');
  if (
    a.intent === 'document.summarize' &&
    (!m.replyTo ||
      a.data.documentMessageId !== m.replyTo.messageId ||
      !ctx.messages.some((v) => v.ref.messageId === a.data.documentMessageId && v.attachment))
  )
    return ask('Ответьте через Reply на нужный документ.');
  return { kind: 'allow' };
}
function boundTarget(
  ctx: ResolvedContext,
  candidates: { id: string; title: string; sourceMessageId: string }[],
  id: string,
): boolean {
  const target = candidates.find((t) => t.id === id);
  if (!target) return false;
  const text = ctx.trigger.text + ' ' + (ctx.clarification ?? '');
  if (text.includes(id)) return true;
  if (ctx.trigger.replyTo)
    return (
      candidates.filter((t) => t.sourceMessageId === ctx.trigger.replyTo!.messageId).length === 1 &&
      target.sourceMessageId === ctx.trigger.replyTo.messageId
    );
  return candidates.length === 1;
}
