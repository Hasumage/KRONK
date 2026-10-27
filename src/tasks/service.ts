import { createHash } from 'node:crypto';
import type { Api } from 'grammy';
import type { CallbackQuery, Message } from 'grammy/types';
import type { BusinessSettings } from '../config/business.js';
import type { Settings } from '../config/settings.js';
import type { Store } from '../storage/database.js';
import { operationKey } from '../storage/database.js';
import type { InputMessage } from '../domain/schema.js';
import { resolveContext } from '../application/context.js';
import { rememberBusinessMessage } from '../services/business-context.js';
import type { OwnerOutbox } from '../services/owner-outbox.js';
import type {
  Task,
  TaskAction,
  TaskCard,
  TaskExtractor,
  TaskFilter,
  TaskJob,
  TaskJobPayload,
  TaskRequest,
} from './model.js';
import { TaskRepository } from './repository.js';
import { taskCard, taskList } from './ui.js';
import { taskIntent } from './intent.js';
import { normalizeDeadline } from './deadline.js';

export type TaskApi = Pick<
  Api,
  'getBusinessConnection' | 'sendMessage' | 'editMessageText' | 'answerCallbackQuery'
>;
type InputRow = {
  kind: 'create' | 'deadline' | 'edit' | 'search';
  task_number: number | null;
  revision: number | null;
  outbox_id: string;
  expires_at: number;
};
export class BusinessTasks {
  readonly repo: TaskRepository;
  private lastReminderScan = 0;
  constructor(
    private readonly c: BusinessSettings,
    private readonly config: Settings,
    private readonly store: Store,
    private readonly api: TaskApi,
    private readonly outbox: OwnerOutbox,
    private readonly extractor: TaskExtractor | null,
  ) {
    this.repo = new TaskRepository(store, c.OWNER_TELEGRAM_ID, config.TIMEZONE);
    store.db.prepare("UPDATE task_jobs SET state='retry' WHERE state='running'").run();
  }
  private mutable(): boolean {
    return (
      this.c.BUSINESS_TASKS_ENABLED &&
      !this.c.BUSINESS_DRY_RUN &&
      this.store.getSetting('business.paused') !== 'true'
    );
  }
  private send(key: string, card: TaskCard): void {
    this.outbox.enqueue('task:' + key, card);
  }
  private notice(key: string, text: string): void {
    this.send(key, { text });
  }
  private direct(m: Message): InputMessage {
    return {
      ref: {
        accountId: this.c.OWNER_TELEGRAM_ID,
        chatId: m.chat.id.toString(),
        messageId: m.message_id.toString(),
      },
      senderId: this.c.OWNER_TELEGRAM_ID,
      direction: 'outgoing',
      text: m.text ?? '',
      sentAt: new Date(m.date * 1000).toISOString(),
      replyTo: m.reply_to_message
        ? {
            accountId: this.c.OWNER_TELEGRAM_ID,
            chatId: m.chat.id.toString(),
            messageId: m.reply_to_message.message_id.toString(),
          }
        : null,
      generatedByAssistant: false,
      attachment: null,
    };
  }
  async receive(m: Message): Promise<void> {
    if (!this.c.BUSINESS_TASKS_ENABLED || this.store.getSetting('business.paused') === 'true')
      return;
    const source = await rememberBusinessMessage(
      this.c,
      this.store,
      this.api,
      m,
      this.config.MAX_CONTEXT_CHARS,
    );
    if (
      !source ||
      source.direction !== 'outgoing' ||
      Date.now() / 1000 - m.date > this.c.BUSINESS_MATH_MAX_AGE_SECONDS
    )
      return;
    const intent = taskIntent(source.text, !!source.replyTo);
    if (!intent) return;
    const key = operationKey(source);
    if (intent === 'complete') {
      if (this.store.db.prepare('SELECT id FROM task_actions WHERE id=?').get('business:' + key))
        return;
      let candidates = this.repo.bound(source.ref.chatId, source.replyTo?.messageId ?? null);
      const number = source.text.match(/#(\d+)/)?.[1];
      if (number) {
        const task = this.repo.get(Number(number));
        candidates =
          task && task.chatId === source.ref.chatId && task.archivedAt === null ? [task] : [];
      }
      this.completeChoice(key, candidates);
      return;
    }
    const context = resolveContext(this.store, this.config, source, null, []).messages;
    this.enqueue('create', source, context, source.text, key);
  }
  private completeChoice(key: string, tasks: Task[]): void {
    if (!this.mutable()) {
      this.notice('blocked:' + key, 'Изменение задач приостановлено или включён dry-run.');
      return;
    }
    if (tasks.length === 1) {
      this.store.db.transaction(() => {
        const updated = this.repo.transition(tasks[0]!.number, 'done', 'business:' + key);
        this.send(
          'complete:' + key,
          taskCard(updated, this.config.TIMEZONE, '✅ Задача выполнена.'),
        );
      })();
      return;
    }
    this.send('choice:' + key, {
      text: tasks.length
        ? 'Какую задачу закрыть? Выберите её ниже.'
        : 'Не нашёл однозначно связанную открытую задачу. Откройте /tasks и выберите нужную.',
      replyMarkup: {
        inline_keyboard: [
          ...tasks.slice(0, 6).map((t) => [
            {
              text: `✅ #${t.number} ${t.title.slice(0, 35)}`,
              callback_data: `task:done:${t.number}:${t.revision}`,
            },
          ]),
          [{ text: 'Открытые задачи', callback_data: 'task:list:open:0' }],
        ],
      },
    });
  }
  async ownerMessage(m: Message): Promise<boolean> {
    if (
      m.business_connection_id ||
      m.chat.type !== 'private' ||
      m.chat.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
      m.from?.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
      !m.text
    )
      return false;
    const [rawCommand = '', ...args] = m.text.trim().split(/\s+/),
      command = rawCommand.split('@')[0]!,
      text = args.join(' '),
      key = 'message:' + m.message_id;
    const commands = [
      '/tasks',
      '/today',
      '/overdue',
      '/done',
      '/archive',
      '/task',
      '/add',
      '/find',
      '/due',
      '/task_done',
      '/task_open',
      '/task_archive',
      '/task_restore',
      '/cancel',
    ];
    if (commands.includes(command)) {
      if (!this.c.BUSINESS_TASKS_ENABLED) {
        this.notice(key, 'Задачник выключен.');
        return true;
      }
      if (
        command === '/tasks' ||
        command === '/today' ||
        command === '/overdue' ||
        command === '/done' ||
        command === '/archive'
      ) {
        const filter: TaskFilter =
          command === '/today'
            ? 'today'
            : command === '/overdue'
              ? 'overdue'
              : command === '/done'
                ? 'done'
                : command === '/archive'
                  ? 'archive'
                  : 'open';
        this.send(key, taskList(this.repo, filter));
        return true;
      }
      if (command === '/find') {
        this.send(
          key,
          text
            ? taskList(this.repo, 'all', 0, text.slice(0, 100))
            : { text: 'Поиск: /find текст из названия или описания' },
        );
        return true;
      }
      if (command === '/task') {
        const task = this.repo.get(Number(args[0]));
        this.send(
          key,
          task
            ? taskCard(task, this.config.TIMEZONE)
            : { text: 'Задача не найдена. Используйте /task номер, например /task 12.' },
        );
        return true;
      }
      if (command === '/cancel') {
        this.store.db
          .prepare('DELETE FROM task_inputs WHERE owner_id=?')
          .run(this.c.OWNER_TELEGRAM_ID);
        this.store.db
          .prepare(
            "UPDATE task_jobs SET state='failed' WHERE owner_id=? AND state='awaiting_input'",
          )
          .run(this.c.OWNER_TELEGRAM_ID);
        this.notice(key, 'Ввод отменён. Задачи не изменены.');
        return true;
      }
      if (!this.mutable()) {
        this.notice(
          key,
          'Изменение задач приостановлено или включён dry-run. Используйте /resume.',
        );
        return true;
      }
      if (command === '/add') {
        if (!text) {
          this.prompt('create', key);
          return true;
        }
        const source = this.direct(m);
        const context = m.reply_to_message?.text
          ? [
              {
                ...source,
                ref: { ...source.ref, messageId: m.reply_to_message.message_id.toString() },
                senderId: m.reply_to_message.from?.id.toString() ?? '0',
                direction: 'incoming' as const,
                text: m.reply_to_message.text,
              },
            ]
          : [];
        this.enqueue('create', source, context, text, operationKey(source));
        return true;
      }
      const number = Number(args[0]),
        task = this.repo.get(number);
      if (!task) {
        this.notice(key, 'Задача не найдена. Номер можно посмотреть через /tasks.');
        return true;
      }
      if (command === '/due') {
        const value = args.slice(1).join(' ');
        if (!value) {
          this.prompt('deadline', key, task);
          return true;
        }
        if (this.clearDeadline(value)) {
          this.changeDeadline(task, key);
          return true;
        }
        this.enqueue('deadline', this.direct(m), [], value, operationKey(this.direct(m)), task);
        return true;
      }
      const action: TaskAction =
        command === '/task_done'
          ? 'done'
          : command === '/task_open'
            ? 'open'
            : command === '/task_archive'
              ? 'archive'
              : 'restore';
      try {
        this.store.db.transaction(() => {
          const updated = this.repo.transition(number, action, key, task.revision);
          this.send(key, taskCard(updated, this.config.TIMEZONE, this.actionLabel(action)));
        })();
      } catch {
        this.notice(key, 'Не удалось изменить задачу. Обновите её карточку через /task ' + number);
      }
      return true;
    }
    if (m.text.startsWith('/')) return false;
    if (m.reply_to_message) {
      const reply = this.store.db
        .prepare('SELECT id FROM outbox WHERE telegram_message_id=?')
        .get(m.reply_to_message.message_id.toString()) as { id: string } | undefined;
      const jobId = reply?.id.match(/^task:job:([a-f0-9]{64}):clarify:/)?.[1];
      if (jobId) {
        const job = this.store.db
          .prepare("SELECT * FROM task_jobs WHERE id=? AND owner_id=? AND state='awaiting_input'")
          .get(jobId, this.c.OWNER_TELEGRAM_ID) as TaskJob | undefined;
        if (!job) {
          this.notice(key, 'Этот запрос уже закрыт или истёк.');
          return true;
        }
        if (!this.mutable()) {
          this.notice(key, 'Обработка на паузе. Используйте /resume.');
          return true;
        }
        const payload = this.store.vault.open<TaskJobPayload>(job.payload);
        payload.request.clarification = [
          payload.request.clarification,
          `[${new Date(m.date * 1000).toISOString()}] ${m.text.slice(0, 3000)}`,
        ]
          .filter(Boolean)
          .join('\n')
          .slice(-6000);
        payload.request.referenceTime = new Date(m.date * 1000).toISOString();
        this.store.db
          .prepare(
            "UPDATE task_jobs SET payload=?,state='pending',attempts=0,available_at=? WHERE id=?",
          )
          .run(this.store.vault.seal(payload), Date.now(), jobId);
        this.notice(key, 'Уточнение принято.');
        return true;
      }
      const input = this.store.db
        .prepare('SELECT * FROM task_inputs WHERE owner_id=?')
        .get(this.c.OWNER_TELEGRAM_ID) as InputRow | undefined;
      if (input && reply?.id === input.outbox_id) {
        if (input.expires_at < Date.now()) {
          this.notice(key, 'Срок ввода истёк. Откройте нужную кнопку заново.');
          return true;
        }
        if (input.kind === 'search') {
          this.send(key, taskList(this.repo, 'all', 0, m.text.trim().slice(0, 100)));
          this.clearInput();
          return true;
        }
        if (!this.mutable()) {
          this.notice(key, 'Изменение задач приостановлено. Используйте /resume.');
          return true;
        }
        const task = input.task_number !== null ? this.repo.get(input.task_number) : null;
        if (input.task_number !== null && (!task || task.revision !== input.revision)) {
          this.notice(key, 'Задача уже изменилась. Откройте свежую карточку.');
          this.clearInput();
          return true;
        }
        if (input.kind === 'deadline' && task && this.clearDeadline(m.text)) {
          this.changeDeadline(task, key);
          this.clearInput();
          return true;
        }
        this.enqueue(
          input.kind,
          this.direct(m),
          [],
          m.text,
          operationKey(this.direct(m)),
          task ?? undefined,
        );
        this.clearInput();
        return true;
      }
    }
    if (m.reply_to_message) {
      const stale = this.store.db
        .prepare('SELECT id FROM outbox WHERE telegram_message_id=?')
        .get(m.reply_to_message.message_id.toString()) as { id: string } | undefined;
      if (stale?.id.startsWith('task:input:')) {
        this.notice(key, 'Этот ввод уже закрыт или истёк. Откройте нужную кнопку заново.');
        return true;
      }
    }
    // Explicit task instructions in the bot's own chat, without slash commands.
    if (taskIntent(m.text) === 'create') {
      this.enqueue('create', this.direct(m), [], m.text, operationKey(this.direct(m)));
      return true;
    }
    return false;
  }
  private clearInput(): void {
    this.store.db.prepare('DELETE FROM task_inputs WHERE owner_id=?').run(this.c.OWNER_TELEGRAM_ID);
  }
  private clearDeadline(text: string): boolean {
    return /^(?:без\s+(?:срока|дедлайна)|убери\s+(?:срок|дедлайн)|очисти\s+(?:срок|дедлайн))\s*[.!]?$/iu.test(
      text.trim(),
    );
  }
  private changeDeadline(task: Task, key: string): void {
    this.store.db.transaction(() => {
      const updated = this.repo.edit(
        task.number,
        { dueAt: null, dueDate: null },
        key,
        task.revision,
      );
      this.send(key, taskCard(updated, this.config.TIMEZONE, 'Дедлайн убран.'));
    })();
  }
  private prompt(kind: InputRow['kind'], key: string, task?: Task): void {
    const outboxId = 'task:input:' + key;
    const text =
      kind === 'create'
        ? 'Ответьте на это сообщение: что нужно сделать и, если есть, к какому сроку.'
        : kind === 'deadline'
          ? `Новый срок для #${task!.number}: например «завтра к 18:00», «до пятницы» или «без срока».`
          : kind === 'edit'
            ? `Ответьте новым названием и описанием задачи #${task!.number}. Срок можно указать явно; иначе прежний сохранится.`
            : 'Ответьте текстом для поиска по названию и описанию задач.';
    this.store.db.transaction(() => {
      this.store.db
        .prepare('INSERT OR REPLACE INTO task_inputs VALUES (?,?,?,?,?,?)')
        .run(
          this.c.OWNER_TELEGRAM_ID,
          kind,
          task?.number ?? null,
          task?.revision ?? null,
          outboxId,
          Date.now() + 15 * 60000,
        );
      this.outbox.enqueue(outboxId, {
        text: text + '\nОтмена: /cancel',
        replyMarkup: {
          force_reply: true,
          input_field_placeholder: kind === 'search' ? 'Текст для поиска' : 'Задача или срок',
        },
      });
    })();
  }
  private enqueue(
    kind: TaskRequest['mode'],
    source: InputMessage,
    context: InputMessage[],
    text: string,
    key: string,
    task?: Task,
  ): void {
    if (!this.c.BUSINESS_TASKS_ENABLED) return;
    if (!this.mutable()) {
      this.notice('blocked:' + key, 'Изменение задач приостановлено или включён dry-run.');
      return;
    }
    if (!this.extractor) {
      this.notice(
        'setup:' + key,
        'Для создания задач и распознавания сроков нужно настроить OpenAI. Просмотр и кнопки статусов доступны без него.',
      );
      return;
    }
    if (text.length > this.config.MAX_CONTEXT_CHARS) {
      this.notice('long:' + key, 'Сообщение слишком длинное. Сократите описание задачи.');
      return;
    }
    const id = createHash('sha256')
      .update('task:' + kind + ':' + this.c.OWNER_TELEGRAM_ID + ':' + key)
      .digest('hex');
    const payload: TaskJobPayload = {
      source,
      request: {
        mode: kind,
        text,
        referenceTime: source.sentAt,
        timezone: this.config.TIMEZONE,
        context,
        replyMessageId: source.replyTo?.messageId ?? null,
        clarification: null,
        current: task
          ? {
              title: task.title,
              description: task.description,
              dueAt: task.dueAt,
              dueDate: task.dueDate,
            }
          : null,
      },
    };
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO task_jobs(id,owner_id,kind,task_number,expected_revision,payload,available_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        this.c.OWNER_TELEGRAM_ID,
        kind,
        task?.number ?? null,
        task?.revision ?? null,
        this.store.vault.seal(payload),
        Date.now(),
        Date.now(),
      );
  }
  async callback(query: CallbackQuery): Promise<boolean> {
    if (!query.data?.startsWith('task:')) return false;
    if (
      query.from.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
      query.message?.chat.type !== 'private' ||
      query.message.chat.id.toString() !== this.c.OWNER_TELEGRAM_ID
    )
      return true;
    const parts = query.data.split(':'),
      kind = parts[1]!,
      key = 'callback:' + query.id;
    const answer = (text = '') =>
      this.api.answerCallbackQuery(query.id, { text: text.slice(0, 180) }).catch(() => {});
    const show = async (card: TaskCard) => {
      try {
        await this.api.editMessageText(
          this.c.OWNER_TELEGRAM_ID,
          query.message!.message_id,
          card.text,
          {
            ...('replyMarkup' in card && card.replyMarkup && 'inline_keyboard' in card.replyMarkup
              ? { reply_markup: card.replyMarkup }
              : {}),
            link_preview_options: { is_disabled: true },
          },
        );
      } catch {
        this.send(key, card);
      }
    };
    if (!this.c.BUSINESS_TASKS_ENABLED) {
      await answer('Задачник выключен.');
      return true;
    }
    if (kind === 'list') {
      const filter = parts[2] as TaskFilter;
      if (!['open', 'done', 'archive', 'today', 'overdue', 'all'].includes(filter)) {
        await answer('Неизвестный список.');
        return true;
      }
      await answer();
      await show(taskList(this.repo, filter, Math.max(0, Math.min(Number(parts[3]) || 0, 100000))));
      return true;
    }
    if (kind === 'new' || kind === 'search') {
      if (kind === 'new' && !this.mutable()) {
        await answer('Изменения на паузе или dry-run.');
        return true;
      }
      await answer();
      this.prompt(kind === 'new' ? 'create' : 'search', key);
      return true;
    }
    const number = Number(parts[2]),
      task = this.repo.get(number);
    if (!task) {
      await answer('Задача не найдена.');
      return true;
    }
    if (kind === 'view') {
      await answer();
      await show(taskCard(task, this.config.TIMEZONE));
      return true;
    }
    if (!this.mutable()) {
      await answer('Изменения на паузе или dry-run.');
      return true;
    }
    const revision = Number(parts[3]);
    if (!Number.isSafeInteger(revision) || revision !== task.revision) {
      await answer('Задача уже изменилась. Карточка обновлена.');
      await show(taskCard(task, this.config.TIMEZONE));
      return true;
    }
    if (kind === 'due' || kind === 'edit') {
      if (task.archivedAt !== null) {
        await answer('Сначала восстановите задачу.');
        return true;
      }
      await answer();
      this.prompt(kind === 'due' ? 'deadline' : 'edit', key, task);
      return true;
    }
    if (!['done', 'open', 'archive', 'restore'].includes(kind)) {
      await answer('Неизвестное действие.');
      return true;
    }
    try {
      const updated = this.repo.transition(number, kind as TaskAction, key, revision);
      await answer(this.actionLabel(kind as TaskAction));
      await show(taskCard(updated, this.config.TIMEZONE));
    } catch {
      await answer('Задача изменилась. Обновите карточку.');
      await show(taskCard(this.repo.get(number)!, this.config.TIMEZONE));
    }
    return true;
  }
  private actionLabel(action: TaskAction): string {
    return {
      done: '✅ Задача выполнена.',
      open: '🔵 Задача открыта.',
      archive: '📦 Задача убрана в архив.',
      restore: '♻️ Задача восстановлена.',
    }[action];
  }
  async tick(): Promise<void> {
    if (!this.mutable()) return;
    if (this.extractor) {
      const job = this.store.db.transaction(() => {
        const row = this.store.db
          .prepare(
            "SELECT * FROM task_jobs WHERE owner_id=? AND state IN ('pending','retry') AND available_at<=? ORDER BY created_at LIMIT 1",
          )
          .get(this.c.OWNER_TELEGRAM_ID, Date.now()) as TaskJob | undefined;
        if (!row) return null;
        this.store.db
          .prepare("UPDATE task_jobs SET state='running',attempts=attempts+1 WHERE id=?")
          .run(row.id);
        return { ...row, attempts: row.attempts + 1 };
      })();
      if (job) await this.execute(job);
    }
    if (this.c.BUSINESS_TASK_REMINDERS_ENABLED && Date.now() - this.lastReminderScan >= 60000) {
      this.lastReminderScan = Date.now();
      for (const task of this.repo.reminderCandidates())
        this.store.db.transaction(() => {
          this.send(
            `reminder:${task.id}:${task.dueSort}`,
            taskCard(task, this.config.TIMEZONE, '⏰ Истёк дедлайн задачи.'),
          );
          this.repo.markReminded(task);
        })();
    }
  }
  private async execute(job: TaskJob): Promise<void> {
    try {
      const payload = this.store.vault.open<TaskJobPayload>(job.payload),
        result = await this.extractor!.extract(payload.request);
      if (!this.mutable()) {
        this.store.db
          .prepare("UPDATE task_jobs SET state='retry',attempts=attempts-1 WHERE id=?")
          .run(job.id);
        return;
      }
      const needs =
        result.requiresClarification ||
        result.confidence < 0.9 ||
        (job.kind !== 'deadline' && !result.title?.trim()) ||
        (result.hasDeadline && !result.dueAt && !result.dueDate) ||
        (job.kind === 'deadline' && !result.hasDeadline && !result.clearDeadline);
      if (needs) {
        this.ask(
          job,
          result.question ??
            (job.kind === 'deadline'
              ? 'Уточните день и, если нужно, время дедлайна.'
              : 'Что именно нужно сделать? Уточните содержание задачи.'),
        );
        return;
      }
      let deadline;
      try {
        deadline = normalizeDeadline(
          result.clearDeadline ? null : result.dueAt,
          result.clearDeadline ? null : result.dueDate,
          this.config.TIMEZONE,
        );
      } catch {
        this.ask(
          job,
          'Не удалось однозначно понять срок. Укажите дату и при необходимости время, либо «без срока».',
        );
        return;
      }
      this.store.db.transaction(() => {
        let task: Task;
        if (job.kind === 'create')
          task = this.repo.create(
            job.id,
            {
              title: result.title!,
              description: result.description,
              dueAt: result.hasDeadline ? deadline.dueAt : null,
              dueDate: result.hasDeadline ? deadline.dueDate : null,
            },
            {
              chatId: payload.source.ref.chatId,
              sourceMessageId: payload.source.replyTo?.messageId ?? payload.source.ref.messageId,
              triggerMessageId: payload.source.ref.messageId,
            },
          );
        else {
          const patch =
            job.kind === 'deadline'
              ? { dueAt: deadline.dueAt, dueDate: deadline.dueDate }
              : {
                  title: result.title!,
                  description: result.description,
                  ...(result.hasDeadline || result.clearDeadline
                    ? { dueAt: deadline.dueAt, dueDate: deadline.dueDate }
                    : {}),
                };
          task = this.repo.edit(job.task_number!, patch, 'job:' + job.id, job.expected_revision!);
        }
        this.send(
          'job:' + job.id + ':result',
          taskCard(
            task,
            this.config.TIMEZONE,
            job.kind === 'create'
              ? '✅ Задача добавлена.'
              : job.kind === 'deadline'
                ? '🕒 Дедлайн изменён.'
                : '✏️ Задача изменена.',
          ),
        );
        this.store.db.prepare("UPDATE task_jobs SET state='done' WHERE id=?").run(job.id);
      })();
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'TASK_STALE' || code === 'TASK_ARCHIVED' || code === 'TASK_NOT_FOUND') {
        this.notice(
          'job:' + job.id + ':error',
          'Задача уже изменилась или ушла в архив. Откройте свежую карточку через /tasks и повторите изменение.',
        );
        this.store.db.prepare("UPDATE task_jobs SET state='failed' WHERE id=?").run(job.id);
        return;
      }
      if (code === 'TASK_INVALID_TEXT') {
        this.ask(job, 'Сократите заголовок до 200 символов и описание до 2500 символов.');
        return;
      }
      const failed =
        job.attempts >= 3 || code === 'API_BUDGET_EXCEEDED' || code === 'AI_CONTEXT_LIMIT_EXCEEDED';
      this.store.db
        .prepare('UPDATE task_jobs SET state=?,available_at=? WHERE id=?')
        .run(failed ? 'failed' : 'retry', Date.now() + 1000 * 2 ** job.attempts, job.id);
      this.store.audit(job.id, 'task.extract', failed ? 'failed' : 'retry');
      if (failed)
        this.notice(
          'job:' + job.id + ':error',
          'Не удалось обработать задачу. Изменения не подтверждены. Проверьте OpenAI/лимит API и повторите запрос.',
        );
    }
  }
  private ask(job: TaskJob, question: string): void {
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE task_jobs SET state='awaiting_input' WHERE id=?").run(job.id);
      const round = createHash('sha256').update(job.payload).digest('hex').slice(0, 12);
      this.send(`job:${job.id}:clarify:${round}:${job.attempts}`, {
        text: question.slice(0, 1000) + '\nОтветьте через Reply на это сообщение.',
        replyMarkup: { force_reply: true },
      });
    })();
  }
  status(): string {
    const open = this.repo.list('open').count,
      overdue = this.repo.list('overdue').count;
    return `Задачи: ${this.c.BUSINESS_TASKS_ENABLED ? 'включены' : 'выключены'}\nОткрытых: ${open}\nПросроченных: ${overdue}${this.extractor ? '' : '\nРаспознавание задач ещё не настроено.'}`;
  }
  prune(): void {
    this.store.db.prepare('DELETE FROM task_inputs WHERE expires_at<?').run(Date.now());
    const cutoff = Date.now() - this.c.BUSINESS_RETENTION_DAYS * 86400000;
    this.store.db
      .prepare(
        "UPDATE task_jobs SET state='failed' WHERE created_at<? AND state IN ('pending','retry','awaiting_input')",
      )
      .run(cutoff);
    this.store.db
      .prepare("UPDATE task_jobs SET payload='' WHERE created_at<? AND state IN ('done','failed')")
      .run(cutoff);
  }
}
