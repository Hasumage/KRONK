import { DateTime } from 'luxon';
import { validInstant } from '../application/policy.js';

export function normalizeDeadline(
  dueAt: string | null,
  dueDate: string | null,
  timezone: string,
): { dueAt: string | null; dueDate: string | null; dueSort: number | null } {
  if (dueAt && dueDate) throw new Error('TASK_AMBIGUOUS_DEADLINE');
  if (dueAt) {
    if (!validInstant(dueAt)) throw new Error('TASK_INVALID_DEADLINE');
    const date = DateTime.fromISO(dueAt, { setZone: true });
    if (!date.isValid) throw new Error('TASK_INVALID_DEADLINE');
    return { dueAt: date.toUTC().toISO()!, dueDate: null, dueSort: date.toMillis() };
  }
  if (dueDate) {
    const date = DateTime.fromISO(dueDate, { zone: timezone });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !date.isValid || date.toISODate() !== dueDate)
      throw new Error('TASK_INVALID_DEADLINE');
    return { dueAt: null, dueDate, dueSort: date.endOf('day').toMillis() };
  }
  return { dueAt: null, dueDate: null, dueSort: null };
}
export function deadlineLabel(
  task: { dueAt: string | null; dueDate: string | null },
  timezone: string,
): string {
  if (task.dueDate)
    return (
      DateTime.fromISO(task.dueDate, { zone: timezone }).setLocale('ru').toFormat('dd LLL yyyy') +
      ' (до конца дня)'
    );
  if (task.dueAt)
    return DateTime.fromISO(task.dueAt, { setZone: true })
      .setZone(timezone)
      .setLocale('ru')
      .toFormat('dd LLL yyyy, HH:mm');
  return 'без срока';
}
export function dueToday(dueSort: number | null, timezone: string, now = Date.now()): boolean {
  return (
    dueSort !== null &&
    DateTime.fromMillis(dueSort, { zone: timezone }).toISODate() ===
      DateTime.fromMillis(now, { zone: timezone }).toISODate()
  );
}
