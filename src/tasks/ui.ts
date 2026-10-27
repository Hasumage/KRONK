import type { Task, TaskCard, TaskFilter } from './model.js';
import type { TaskRepository } from './repository.js';
import { deadlineLabel } from './deadline.js';
const button = (text: string, callback_data: string) => ({ text, callback_data });
const names: Record<TaskFilter, string> = {
  open: 'Открытые задачи',
  done: 'Выполненные задачи',
  archive: 'Архив',
  today: 'Задачи на сегодня',
  overdue: 'Просроченные задачи',
  all: 'Все задачи',
};
export function taskCard(task: Task, timezone: string, heading = ''): TaskCard {
  const state =
    task.archivedAt !== null
      ? '📦 В архиве'
      : task.status === 'done'
        ? '✅ Выполнена'
        : '🔵 Открыта';
  const overdue =
    task.archivedAt === null &&
    task.status === 'open' &&
    task.dueSort !== null &&
    task.dueSort < Date.now();
  const prefix = `task:`;
  const action = (kind: string) => `${prefix}${kind}:${task.number}:${task.revision}`;
  const rows = [];
  if (task.archivedAt !== null)
    rows.push([button('♻️ Восстановить', action('restore')), button('↩️ Открыть', action('open'))]);
  else {
    rows.push([
      task.status === 'open'
        ? button('✅ Выполнено', action('done'))
        : button('↩️ Открыть снова', action('open')),
      button('📦 В архив', action('archive')),
    ]);
    rows.push([button('🕒 Дедлайн', action('due')), button('✏️ Изменить', action('edit'))]);
  }
  rows.push([button('← Открытые', 'task:list:open:0'), button('📚 Архив', 'task:list:archive:0')]);
  return {
    text: `${heading ? heading + '\n\n' : ''}#${task.number} · ${task.title}\n${state}${overdue ? ' · ⚠️ Просрочена' : ''}\nДедлайн: ${deadlineLabel(task, timezone)}${task.dueAt ? ' (' + timezone + ')' : ''}${task.description ? '\n\n' + task.description : ''}`,
    replyMarkup: { inline_keyboard: rows },
  };
}
export function taskList(
  repo: TaskRepository,
  filter: TaskFilter = 'open',
  page = 0,
  search = '',
): TaskCard {
  const data = repo.list(filter, page, search);
  const lines = data.tasks.map((task) => {
    const marker =
      task.archivedAt !== null
        ? '📦'
        : task.status === 'done'
          ? '✅'
          : task.dueSort !== null && task.dueSort < Date.now()
            ? '⚠️'
            : '🔹';
    return `${marker} #${task.number} ${task.title}\n   ${deadlineLabel(task, repo.timezone)}`;
  });
  const rows = data.tasks.map((t) => [
    button(`#${t.number} ${t.title.slice(0, 42)}`, `task:view:${t.number}`),
  ]);
  if (!search && data.pages > 1)
    rows.push([
      ...(data.page > 0 ? [button('← Назад', `task:list:${filter}:${data.page - 1}`)] : []),
      ...(data.page < data.pages - 1
        ? [button('Далее →', `task:list:${filter}:${data.page + 1}`)]
        : []),
    ]);
  rows.push([
    button('🔵 Открытые', 'task:list:open:0'),
    button('📅 Сегодня', 'task:list:today:0'),
    button('⚠️ Просрочено', 'task:list:overdue:0'),
  ]);
  rows.push([
    button('✅ Выполненные', 'task:list:done:0'),
    button('📦 Архив', 'task:list:archive:0'),
  ]);
  rows.push([button('➕ Создать', 'task:new'), button('🔎 Поиск', 'task:search')]);
  const searchNote =
    search && data.count > data.tasks.length
      ? '\nПоказаны первые 6 совпадений. Уточните запрос для остальных.'
      : '';
  return {
    text: `${search ? 'Поиск задач: ' + search : names[filter]} · ${data.count}\n${!search ? 'Страница ' + (data.page + 1) + ' из ' + data.pages + '\n' : ''}\n${lines.join('\n\n') || 'Здесь пока нет задач.'}${searchNote}`,
    replyMarkup: { inline_keyboard: rows },
  };
}
