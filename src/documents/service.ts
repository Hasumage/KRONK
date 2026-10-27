import { createHash } from 'node:crypto';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import type { BusinessSettings } from '../config/business.js';
import type { Settings } from '../config/settings.js';
import type { InputMessage } from '../domain/schema.js';
import type { Store } from '../storage/database.js';
import { operationKey } from '../storage/database.js';
import { rememberBusinessMessage } from '../services/business-context.js';
import type { OwnerOutbox } from '../services/owner-outbox.js';
import { extractDocument, type Download } from '../services/documents.js';
import { documentIntent } from './intent.js';
import { documentFocus, wantsVisualReview } from './focus.js';
import {
  renderReport,
  splitReport,
  validateReport,
  type DocumentAnalyzer,
  type DocumentReport,
} from './report.js';

type DocumentsApi = Pick<Api, 'getBusinessConnection' | 'sendMessage'>;
interface FileRequest {
  name: string;
  fileId: string;
  size: number;
  mime: string;
  source: InputMessage;
}
interface Job {
  id: string;
  payload: string;
  result: string | null;
  attempts: number;
}
interface Saved {
  name: string;
  report: DocumentReport;
}
type Extract = (
  config: Settings,
  message: InputMessage,
  download: Download,
  maxChars?: number,
  allowVisualOnly?: boolean,
) => Promise<string>;
export class BusinessDocuments {
  constructor(
    private readonly c: BusinessSettings,
    private readonly config: Settings,
    private readonly store: Store,
    private readonly api: DocumentsApi,
    private readonly outbox: OwnerOutbox,
    private readonly analyzer: DocumentAnalyzer | null,
    private readonly download: (fileId: string, maxBytes: number) => Promise<Buffer>,
    private readonly extract: Extract = extractDocument,
  ) {
    store.db.prepare("UPDATE document_jobs SET state='retry' WHERE state='running'").run();
  }
  private mutable() {
    return (
      this.c.BUSINESS_DOCUMENTS_ENABLED &&
      !this.c.BUSINESS_DRY_RUN &&
      this.store.getSetting('business.paused') !== 'true'
    );
  }
  private notice(key: string, text: string) {
    this.outbox.enqueue('document:' + key, { text });
  }
  async receive(m: Message): Promise<void> {
    if (!this.c.BUSINESS_DOCUMENTS_ENABLED || this.store.getSetting('business.paused') === 'true')
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
    if (documentIntent(source.text, !!m.reply_to_message?.document || !!m.document))
      this.enqueue(m, source);
  }
  ownerMessage(m: Message): boolean {
    if (
      m.business_connection_id ||
      m.chat.type !== 'private' ||
      m.chat.id.toString() !== this.c.OWNER_TELEGRAM_ID ||
      m.from?.id.toString() !== this.c.OWNER_TELEGRAM_ID
    )
      return false;
    const text = m.text || m.caption || '',
      [raw = '', arg] = text.trim().split(/\s+/),
      command = raw.split('@')[0];
    const key = 'command:' + m.message_id;
    if (['/docs', '/doc', '/forget_doc', '/analyze'].includes(command ?? '')) {
      if (!this.c.BUSINESS_DOCUMENTS_ENABLED) {
        this.notice(key, 'Анализ документов выключен.');
        return true;
      }
      this.prune();
      if (command === '/docs') {
        const rows = this.store.db
          .prepare(
            'SELECT m.number,a.payload,a.created_at FROM document_meta m JOIN document_analyses a ON a.id=m.analysis_id WHERE m.owner_id=? ORDER BY a.created_at DESC,m.number DESC LIMIT 10',
          )
          .all(this.c.OWNER_TELEGRAM_ID) as {
          number: number;
          payload: string;
          created_at: number;
        }[];
        this.notice(
          key,
          '📚 Последние разборы документов\n\n' +
            (rows
              .map((r) => {
                const saved = this.store.vault.open<Saved>(r.payload);
                return `#${r.number} · ${saved.name}\n${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeZone: this.config.TIMEZONE }).format(r.created_at)} · /doc ${r.number}`;
              })
              .join('\n\n') || 'Пока нет сохранённых разборов.') +
            `\n\nХранение: ${this.config.DOCUMENT_RETENTION_DAYS} дн.\n/forget_doc номер — удалить локальную выжимку.`,
        );
        return true;
      }
      if (command === '/doc' || command === '/forget_doc') {
        const number = Number(arg);
        const row =
          Number.isSafeInteger(number) && number > 0
            ? (this.store.db
                .prepare(
                  'SELECT a.id,a.payload FROM document_meta m JOIN document_analyses a ON a.id=m.analysis_id WHERE m.number=? AND m.owner_id=?',
                )
                .get(number, this.c.OWNER_TELEGRAM_ID) as
                { id: string; payload: string } | undefined)
            : undefined;
        if (!row) {
          this.notice(key, 'Разбор не найден или срок хранения истёк. Список: /docs');
          return true;
        }
        if (command === '/forget_doc') {
          this.store.db.transaction(() => {
            this.erase(row.id);
            this.notice(
              key,
              'Локальная выжимка удалена. Уже отправленные сообщения остаются в Telegram — их можно удалить в чате.',
            );
          })();
        } else
          this.show(
            row.id,
            number,
            this.store.vault.open<Saved>(row.payload),
            'show:' + m.message_id,
          );
        return true;
      }
      this.enqueue(m, this.direct(m));
      return true;
    }
    if (
      (!m.reply_to_message || m.reply_to_message.document || m.document) &&
      documentIntent(text, !!m.reply_to_message?.document || !!m.document)
    ) {
      if (!this.c.BUSINESS_DOCUMENTS_ENABLED) return false;
      this.enqueue(m, this.direct(m));
      return true;
    }
    // A bare upload is not permission to analyze it.
    return false;
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
      text: m.text || m.caption || '',
      sentAt: new Date(m.date * 1000).toISOString(),
      replyTo: null,
      generatedByAssistant: false,
      attachment: null,
    };
  }
  private enqueue(m: Message, source: InputMessage): void {
    const id = createHash('sha256')
      .update('document:' + operationKey(source))
      .digest('hex');
    if (this.store.db.prepare('SELECT id FROM document_jobs WHERE id=?').get(id)) return;
    if (!this.mutable()) {
      this.notice(id + ':blocked', 'Анализ приостановлен или включён dry-run.');
      return;
    }
    if (source.text.length > 2000) {
      this.notice(
        id + ':focus',
        'Комментарий слишком длинный. Сократите запрос до 2000 символов, чтобы учесть его целиком.',
      );
      return;
    }
    const target = m.document ? m : m.reply_to_message;
    if (!target?.document || target.chat.id !== m.chat.id || target.sender_business_bot) {
      this.notice(
        id + ':reply',
        'Ответьте через Reply именно на PDF, DOCX или TXT фразой «изучу документ». Можно также прислать файл боту с подписью «разбери» или ответить на него /analyze.',
      );
      return;
    }
    const file = target.document;
    const ext = file.file_name?.split('.').pop()?.toLowerCase();
    const fallback: Record<string, string> = {
      'application/pdf': 'document.pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document.docx',
      'text/plain': 'document.txt',
    };
    const fullName = (file.file_name ?? fallback[file.mime_type ?? ''] ?? 'document').replace(
      /[\r\n\x00-\x1f]/g,
      ' ',
    );
    const name = fullName.length > 180 ? fullName.slice(0, 165) + '….' + (ext ?? 'txt') : fullName;
    if (!['pdf', 'docx', 'txt'].includes(ext ?? name.split('.').pop() ?? '')) {
      this.notice(
        id + ':type',
        ext === 'pptx' || ext === 'ppt'
          ? 'Презентацию PowerPoint пришлите в PDF. Тогда смогу разобрать содержание и оценить визуальный стиль страниц.'
          : 'Поддерживаются PDF, DOCX и TXT. Другие форматы, архивы и файлы с макросами не анализируются.',
      );
      return;
    }
    if ((file.file_size ?? 0) > this.config.MAX_DOCUMENT_BYTES) {
      this.notice(
        id + ':size',
        `Файл слишком большой. Лимит: ${Math.floor(this.config.MAX_DOCUMENT_BYTES / 1000000)} МБ.`,
      );
      return;
    }
    if (!this.analyzer) {
      this.notice(
        id + ':setup',
        'Для анализа документов нужно настроить OpenAI API. Файл не отправлен на анализ.',
      );
      return;
    }
    const payload: FileRequest = {
      name,
      fileId: file.file_id,
      size: file.file_size ?? 0,
      mime: file.mime_type ?? 'application/octet-stream',
      source: { ...source, ref: { ...source.ref, messageId: target.message_id.toString() } },
    };
    this.store.db.transaction(() => {
      const inserted = this.store.db
        .prepare(
          'INSERT OR IGNORE INTO document_jobs(id,owner_id,payload,available_at,created_at) VALUES (?,?,?,?,?)',
        )
        .run(
          id,
          this.c.OWNER_TELEGRAM_ID,
          this.store.vault.seal(payload),
          Date.now(),
          Date.now(),
        ).changes;
      if (inserted)
        this.notice(id + ':queued', `📄 Принял «${name}» на разбор. Выжимку пришлю сюда, в личку.`);
    })();
  }
  async tick(): Promise<void> {
    if (!this.mutable() || !this.analyzer) return;
    const job = this.store.db.transaction(() => {
      const row = this.store.db
        .prepare(
          "SELECT id,payload,result,attempts FROM document_jobs WHERE owner_id=? AND state IN ('pending','retry') AND available_at<=? ORDER BY created_at LIMIT 1",
        )
        .get(this.c.OWNER_TELEGRAM_ID, Date.now()) as Job | undefined;
      if (!row) return null;
      this.store.db
        .prepare("UPDATE document_jobs SET state='running',attempts=attempts+1 WHERE id=?")
        .run(row.id);
      return { ...row, attempts: row.attempts + 1 };
    })();
    if (!job) return;
    try {
      let saved: Saved;
      if (job.result) saved = this.store.vault.open<Saved>(job.result);
      else {
        const request = this.store.vault.open<FileRequest>(job.payload);
        const focus = documentFocus(request.source.text);
        const visual = wantsVisualReview(focus) && request.name.toLowerCase().endsWith('.pdf');
        let bytes: Buffer | undefined;
        const download = async (_message: InputMessage, maxBytes: number) =>
          (bytes ??= await this.download(request.fileId, maxBytes));
        const text = await this.extract(
          this.config,
          {
            ...request.source,
            attachment: { name: request.name, mime: request.mime, size: request.size || 1 },
          },
          download,
          this.config.MAX_DOCUMENT_CHARS,
          visual,
        );
        const result = await this.analyzer.analyze(text, {
          focus,
          persona: this.config.DOCUMENT_REVIEW_PERSONA,
          ...(visual
            ? {
                pdf: {
                  name: request.name,
                  bytes: bytes ?? (await download(request.source, this.config.MAX_DOCUMENT_BYTES)),
                },
              }
            : {}),
        });
        const report = validateReport(text, result, visual ? (result.visualPages ?? true) : false);
        if (focus && !report.review) throw new Error('DOCUMENT_REVIEW_MISSING');
        report.limitations = [
          ...(text.startsWith('[ограничение извлечения]')
            ? [text.split('\n')[0]!.replace('[ограничение извлечения] ', '')]
            : []),
          visual
            ? `Для визуальных комментариев просмотрены страницы PDF${report.visualPages ? ' ' + report.visualPages.join(', ') + ' из ' + report.visualTotalPages : ''}; это оценка макета, а не тестирование продукта.`
            : 'Проанализирован извлечённый текст; изображения и визуальное оформление не оценивались.',
          ...report.limitations,
        ].slice(0, 4);
        saved = { name: request.name, report };
        this.store.db
          .prepare('UPDATE document_jobs SET result=? WHERE id=?')
          .run(this.store.vault.seal(saved), job.id);
      }
      if (!this.mutable()) {
        this.store.db
          .prepare("UPDATE document_jobs SET state='retry',attempts=attempts-1 WHERE id=?")
          .run(job.id);
        return;
      }
      this.store.db.transaction(() => {
        const now = Date.now();
        this.store.db
          .prepare('INSERT OR IGNORE INTO document_analyses VALUES (?,?,?,?)')
          .run(
            job.id,
            this.store.vault.seal(saved),
            now,
            now + this.config.DOCUMENT_RETENTION_DAYS * 86400000,
          );
        this.store.db
          .prepare('INSERT OR IGNORE INTO document_meta(analysis_id,owner_id) VALUES (?,?)')
          .run(job.id, this.c.OWNER_TELEGRAM_ID);
        const row = this.store.db
          .prepare('SELECT number FROM document_meta WHERE analysis_id=?')
          .get(job.id) as { number: number };
        this.show(job.id, row.number, saved, 'result');
        this.store.db
          .prepare("UPDATE document_jobs SET state='done',payload='',result=NULL WHERE id=?")
          .run(job.id);
        this.store.audit(job.id, 'document.analyze', 'succeeded');
      })();
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const terminal =
        (code.startsWith('DOCUMENT_') && code !== 'DOCUMENT_DOWNLOAD_FAILED') ||
        code === 'API_BUDGET_EXCEEDED' ||
        job.attempts >= 3;
      this.store.db.transaction(() => {
        this.store.db
          .prepare(
            'UPDATE document_jobs SET state=?,available_at=?,payload=CASE WHEN ? THEN ? ELSE payload END,result=CASE WHEN ? THEN NULL ELSE result END WHERE id=?',
          )
          .run(
            terminal ? 'failed' : 'retry',
            Date.now() + 2000 * 2 ** job.attempts,
            terminal ? 1 : 0,
            '',
            terminal ? 1 : 0,
            job.id,
          );
        this.store.audit(job.id, 'document.analyze', terminal ? 'failed' : 'retry');
        if (terminal) this.notice(job.id + ':error', this.failure(code));
      })();
    }
  }
  private failure(code: string): string {
    if (code === 'API_BUDGET_EXCEEDED')
      return 'Разбор остановлен: достигнут установленный лимит расходов API. Готовой выжимки нет.';
    if (code === 'DOCUMENT_TEXT_TOO_LARGE' || code === 'DOCUMENT_TOO_MANY_PAGES')
      return `Документ превышает лимит: ${this.config.MAX_DOCUMENT_PAGES} страниц PDF или ${this.config.MAX_DOCUMENT_CHARS.toLocaleString('ru-RU')} символов извлечённого текста. Пришлите нужный раздел отдельным файлом. Текст не обрезался и не отправлялся в модель.`;
    if (code === 'DOCUMENT_NO_TEXT_OCR_REQUIRED')
      return 'В документе не найден текст. Для скана или фотографии нужен OCR; распознавание сканов пока не подключено.';
    if (code === 'DOCUMENT_UNGROUNDED_REPORT')
      return 'Не удалось подтвердить цитаты и источники в выжимке. Такой разбор не сохраняю; попробуйте прислать нужный раздел отдельно.';
    if (code === 'DOCUMENT_UNGROUNDED_REVIEW' || code === 'DOCUMENT_REVIEW_MISSING')
      return 'Не удалось подготовить подтверждённые комментарии по вашему запросу. Неполный результат не сохраняю; попробуйте уточнить фокус или прислать нужный раздел.';
    if (code === 'DOCUMENT_AI_INCOMPLETE')
      return 'Модель не завершила разбор. Неполную выжимку не сохраняю. Попробуйте меньший документ.';
    if (code.startsWith('DOCUMENT_RENDER_') || code === 'DOCUMENT_VISUAL_LIMIT')
      return 'Не удалось подготовить изображения страниц для оценки стиля. Пришлите нужные слайды отдельным PDF обычного размера.';
    if (code === 'DOCUMENT_TOO_LARGE' || code === 'DOCUMENT_SIZE_UNSUPPORTED')
      return 'Файл превышает установленный лимит размера и не проанализирован.';
    if (code === 'DOCUMENT_DOWNLOAD_FAILED')
      return 'Не удалось скачать документ из Telegram после нескольких попыток. Пришлите файл заново.';
    return 'Документ не обработан: проверьте формат PDF/DOCX/TXT, целостность файла и наличие текста. Файлы с макросами, защищённые паролем и неподдерживаемые кодировки не обрабатываются. При сбое API проверьте доступ и баланс.';
  }
  private show(id: string, number: number, saved: Saved, key: string) {
    const parts = splitReport(renderReport(saved.name, number, saved.report));
    parts.forEach((text, index) =>
      this.notice(
        `${id}:${key}:${index.toString().padStart(3, '0')}`,
        text + (parts.length > 1 ? `\n\nЧасть ${index + 1}/${parts.length}` : ''),
      ),
    );
  }
  private erase(id: string) {
    this.store.db.prepare('DELETE FROM document_analyses WHERE id=?').run(id);
    this.store.db.prepare("UPDATE document_jobs SET payload='',result=NULL WHERE id=?").run(id);
    this.store.db
      .prepare(
        "UPDATE outbox SET payload='',status=CASE WHEN status='pending' THEN 'expired' ELSE status END WHERE id LIKE ?",
      )
      .run('document:' + id + ':%');
  }
  prune() {
    const expired = this.store.db
      .prepare(
        'SELECT a.id FROM document_analyses a JOIN document_meta m ON m.analysis_id=a.id WHERE a.retention_until<?',
      )
      .all(Date.now()) as { id: string }[];
    this.store.db.transaction(() => {
      for (const row of expired) this.erase(row.id);
      const cutoff = Date.now() - this.c.BUSINESS_RETENTION_DAYS * 86400000;
      const old = this.store.db
        .prepare("SELECT id FROM document_jobs WHERE created_at<? AND state!='done'")
        .all(cutoff) as { id: string }[];
      for (const row of old) {
        this.erase(row.id);
        this.store.db.prepare("UPDATE document_jobs SET state='failed' WHERE id=?").run(row.id);
      }
    })();
  }
  status(): string {
    return `Документы: ${this.c.BUSINESS_DOCUMENTS_ENABLED ? 'включены' : 'выключены'}${this.analyzer ? '' : ' · OpenAI не настроен'}`;
  }
}
