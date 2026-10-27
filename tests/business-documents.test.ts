import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Message } from 'grammy/types';
import type { InputMessage } from '../src/domain/schema.js';
import { businessSettings } from '../src/config/business.js';
import { businessCalendarSettings } from '../src/services/business-calendar.js';
import { BusinessMath, type BusinessApi } from '../src/services/business-math.js';
import { BusinessDocuments } from '../src/documents/service.js';
import { documentIntent } from '../src/documents/intent.js';
import {
  validateReport,
  splitReport,
  type DocumentReport,
  type DocumentAnalysisOptions,
} from '../src/documents/report.js';
import { documentFocus, wantsVisualReview } from '../src/documents/focus.js';
import { downloadTelegramDocument } from '../src/documents/download.js';
import { Store } from '../src/storage/database.js';
import { Vault } from '../src/security/vault.js';
import { OwnerOutbox } from '../src/services/owner-outbox.js';
const owner = 123456789,
  stores: Store[] = [];
const text =
  '[абзац 1] Исполнитель отправляет отчёт до 30 октября 2026 года.\n[абзац 2] Стоимость услуг — 15 000 рублей.';
const report = (): DocumentReport => ({
  title: 'Договор услуг',
  facts: [
    {
      category: 'obligations',
      text: 'Исполнитель должен отправить отчёт до 30 октября 2026 года.',
      source: 'абзац 1',
      quote: 'Исполнитель отправляет отчёт до 30 октября 2026 года.',
    },
    {
      category: 'money',
      text: 'Стоимость — 15 000 рублей.',
      source: 'абзац 2',
      quote: 'Стоимость услуг — 15 000 рублей.',
    },
  ],
  risks: [],
  questions: ['Как подтверждается приёмка?'],
  limitations: [],
});
const msg = (body: string, id = 1, business = false, author = owner): Message => ({
  message_id: id,
  date: Math.floor(Date.now() / 1000),
  chat: { id: business ? 555 : owner, type: 'private', first_name: 'Chat' },
  from: { id: author, is_bot: false, first_name: 'Author' },
  ...(business ? { business_connection_id: 'conn' } : {}),
  text: body,
});
const document = (id = 100, business = true): Message => ({
  ...msg('', id, business, business ? 555 : owner),
  document: {
    file_id: 'file-secret-id',
    file_unique_id: 'file-unique',
    file_name: 'contract.txt',
    file_size: 100,
    mime_type: 'text/plain',
  },
});
const reply = (m: Message, parent = document()): Message => ({
  ...m,
  reply_to_message: parent as NonNullable<Message['reply_to_message']>,
});
function setup(extra: NodeJS.ProcessEnv = {}) {
  const b = businessSettings({
    TELEGRAM_BOT_TOKEN: 'test',
    OWNER_TELEGRAM_ID: String(owner),
    BUSINESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BUSINESS_DOCUMENTS_ENABLED: 'true',
    BUSINESS_DRY_RUN: 'false',
    ...extra,
  });
  const c = businessCalendarSettings(b, {}),
    s = new Store(':memory:', new Vault(randomBytes(32)));
  stores.push(s);
  let sent = 1000;
  const api = {
    getBusinessConnection: vi.fn(async () => ({
      id: 'conn',
      user: { id: owner, is_bot: false, first_name: 'Owner' },
      user_chat_id: owner,
      date: 1,
      is_enabled: true,
      rights: { can_reply: true },
    })),
    sendMessage: vi.fn(async (_chat: string | number, body: string, _options?: object) =>
      msg(body, ++sent),
    ),
  };
  const typedApi = api as unknown as BusinessApi,
    outbox = new OwnerOutbox(s, typedApi, String(owner), b.BUSINESS_DRY_RUN);
  const analyzer = {
    analyze: vi.fn(async (_text: string, _options?: DocumentAnalysisOptions) => report()),
  };
  const download = vi.fn(async (_id: string, _max: number) => Buffer.from('actual file'));
  const extract = vi.fn(async (_c: typeof c, _m: InputMessage, _d: unknown) => text);
  const service = new BusinessDocuments(b, c, s, typedApi, outbox, analyzer, download, extract);
  const math = new BusinessMath(b, s, typedApi, undefined, undefined, service);
  return { b, c, s, api, typedApi, outbox, analyzer, download, extract, service, math };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
});
describe('Явные фразы изучения документов', () => {
  it.each([
    'изучу',
    'гляну',
    'посмотрю условия',
    'надо посмотреть условия',
    'изучу договор',
    'разбери',
    'дай выжимку',
    'прочитай файл',
    'ок, почитаю',
  ])('разрешает с файлом: %s', (value) => expect(documentIntent(value, true)).toBe(true));
  it.each([
    'не изучай',
    'не буду изучать договор',
    'не надо смотреть условия',
    'добавлю задачу изучить договор',
    'вот договор',
    'я уже изучил',
    'он сказал «изучу договор»',
    'ты изучишь?',
    'привет',
  ])('не запускает: %s', (value) => expect(documentIntent(value, true)).toBe(false));
  it('короткое намерение без привязки не выбирает случайный файл', () =>
    expect(documentIntent('гляну')).toBe(false));
  it.each(['чекну', 'зацени', 'ознакомлюсь', 'разберусь'])('неформальная фраза: %s', (value) =>
    expect(documentIntent(value, true)).toBe(true),
  );
  it.each([
    'гляну и дам комментарии, почему не надо делать такую систему',
    'гляну и скажу, как организовать задачи разработчиков',
    'гляну и подготовлю ответ по календарю релиза',
  ])('текст после триггера не отменяет его: %s', (value) =>
    expect(documentIntent(value, true)).toBe(true),
  );
  it.each(['не чекни', 'если получится, изучу договор', 'возможно, гляну'])(
    'сомнительное намерение не запускает: %s',
    (value) => expect(documentIntent(value, true)).toBe(false),
  );
});
describe('Проверка фактов и длины сообщений', () => {
  it('фраза владельца задаёт фокус, а короткий триггер сохраняет прежний разбор', () => {
    expect(documentFocus('гляну и дам комментарии по презентации, идеи и стилю')).toBe(
      'дам комментарии по презентации, идеи и стилю',
    );
    expect(documentFocus('Ок, гляну и сравню с конкурентами')).toBe('сравню с конкурентами');
    expect(documentFocus('/analyze проверь техническую реализуемость')).toBe(
      'проверь техническую реализуемость',
    );
    for (const value of ['гляну', 'изучу договор', 'разбери', '/analyze'])
      expect(documentFocus(value)).toBeNull();
    expect(wantsVisualReview('комментарии по идее и стилю презентации')).toBe(true);
    expect(wantsVisualReview('проверь суммы и сроки')).toBe(false);
  });
  it('старые выжимки читаются, визуальные утверждения без PDF и выдуманные цитаты блокируются', () => {
    expect(validateReport(text, report()).review).toBeUndefined();
    const value = report();
    value.review = {
      focus: 'идея и стиль',
      comments: [
        {
          area: 'design',
          basis: 'visual',
          source: 'страница 1',
          quote: null,
          observation: 'Низкий контраст текста.',
          suggestion: 'Увеличить контраст.',
        },
      ],
      draftReply: 'Я бы увеличил контраст.',
    };
    expect(() => validateReport('[страница 1] Текст', value)).toThrow();
    value.facts = [];
    expect(validateReport('[страница 1] Текст', value, true).review?.comments).toHaveLength(1);
    value.review.comments[0]!.source = 'страница 99';
    expect(() => validateReport('[страница 1] Текст', value, true)).toThrow(
      'DOCUMENT_UNGROUNDED_REVIEW',
    );
    value.review.comments[0]!.source = 'страница 2';
    expect(() =>
      validateReport('[страница 1] А\n[страница 2] Б\n[страница 3] В', value, [1, 3]),
    ).toThrow('DOCUMENT_UNGROUNDED_REVIEW');
    value.facts = report().facts;
    value.review.comments = [
      {
        area: 'development',
        basis: 'text',
        source: 'абзац 1',
        quote: 'несуществующая API-интеграция',
        observation: 'Есть интеграция.',
        suggestion: 'Уточнить API.',
      },
    ];
    expect(() => validateReport(text, value)).toThrow('DOCUMENT_UNGROUNDED_REVIEW');
  });
  it('требует настоящую цитату на указанной странице/в абзаце', () => {
    expect(validateReport(text, report()).facts).toHaveLength(2);
    const fabricated = report();
    fabricated.facts[0]!.quote = 'Штраф 100 000 рублей';
    expect(() => validateReport(text, fabricated)).toThrow('DOCUMENT_UNGROUNDED_REPORT');
    const wrongSource = report();
    wrongSource.facts[0]!.source = 'абзац 2';
    expect(() => validateReport(text, wrongSource)).toThrow('DOCUMENT_UNGROUNDED_REPORT');
    const empty = report();
    empty.facts = [];
    expect(() => validateReport(text, empty)).toThrow();
  });
  it('делит длинную выжимку и не режет UTF-16 пару', () => {
    const chunks = splitReport('а'.repeat(3499) + '🙂' + 'б'.repeat(4000));
    expect(chunks.every((part) => part.length <= 3500)).toBe(true);
    expect(chunks.join('')).toBe('а'.repeat(3499) + '🙂' + 'б'.repeat(4000));
  });
});
describe('Бот: загрузка только по команде, очередь, личные выжимки', () => {
  it('сохраняет комментарий в очереди, передаёт роль и возвращает отдельный черновик только владельцу', async () => {
    const { service, analyzer, s, outbox, api } = setup();
    const value = report();
    value.review = {
      focus: 'Прокомментировать идею',
      comments: [
        {
          area: 'development',
          basis: 'proposal',
          source: null,
          quote: null,
          observation: 'Стоит определить минимальный первый этап.',
          suggestion: 'Выделить одну проверяемую гипотезу для MVP.',
        },
      ],
      draftReply: 'Я бы начал с одной проверяемой гипотезы и небольшого MVP.',
    };
    analyzer.analyze.mockResolvedValue(value);
    await service.receive(reply(msg('гляну и дам комментарии по идее', 101, true)));
    await service.tick();
    await outbox.flush();
    expect(analyzer.analyze.mock.calls[0]![1]).toEqual({
      focus: 'дам комментарии по идее',
      persona: 'Нейтральный разбор содержания, структуры и ясности.',
    });
    expect(
      api.sendMessage.mock.calls.some((c) => c[1].includes('Черновик ответа собеседнику')),
    ).toBe(true);
    expect(api.sendMessage.mock.calls.every((c) => c[0] === String(owner))).toBe(true);
    service.ownerMessage(msg('/doc 1', 200));
    await outbox.flush();
    expect(analyzer.analyze).toHaveBeenCalledOnce();
    expect(s.db.prepare('SELECT state,payload FROM document_jobs').get()).toEqual({
      state: 'done',
      payload: '',
    });
  });
  it('PDF для стилевого запроса передаётся в модель; голый гляну остаётся текстовым разбором', async () => {
    const { service, analyzer, download } = setup();
    const parent = document();
    parent.document!.file_name = 'slides.pdf';
    download.mockResolvedValue(Buffer.from('%PDF- synthetic'));
    const value = report();
    value.review = {
      focus: 'Стиль',
      comments: [
        {
          area: 'design',
          basis: 'proposal',
          source: null,
          quote: null,
          observation: 'Нужно проверить читаемость.',
          suggestion: 'Проверить иерархию заголовков.',
        },
      ],
      draftReply: 'Я бы проверил читаемость и иерархию.',
    };
    analyzer.analyze.mockResolvedValueOnce(value);
    await service.receive(
      reply(msg('гляну и дам комментарии по стилю презентации', 101, true), parent),
    );
    await service.tick();
    expect(analyzer.analyze.mock.calls[0]![1]?.pdf?.bytes.toString()).toBe('%PDF- synthetic');
    expect(download).toHaveBeenCalledOnce();
    await service.receive(reply(msg('гляну', 102, true), parent));
    await service.tick();
    expect(analyzer.analyze.mock.calls[1]![1]?.pdf).toBeUndefined();
  });
  it('комментарий не теряется при восстановлении очереди; отсутствие ответа на запрос — ошибка', async () => {
    const { service, b, c, s, typedApi, outbox, analyzer, download, extract } = setup();
    await service.receive(reply(msg('гляну и дам предложения по MVP', 101, true)));
    s.db.prepare("UPDATE document_jobs SET state='running'").run();
    const restarted = new BusinessDocuments(b, c, s, typedApi, outbox, analyzer, download, extract);
    await restarted.tick();
    expect(analyzer.analyze.mock.calls[0]![1]?.focus).toBe('дам предложения по MVP');
    expect(s.db.prepare('SELECT state FROM document_jobs').get()).toEqual({ state: 'failed' });
    expect(s.db.prepare('SELECT count(*) AS n FROM document_analyses').get()).toEqual({ n: 0 });
  });
  it('полный маршрут привязан к Reply; дубль update не запускает анализ дважды', async () => {
    const { math, service, s, outbox, api, analyzer, extract } = setup();
    const parent = document(),
      request = reply(msg('изучу договор', 101, true), parent);
    await math.handle({
      update_id: 1,
      business_message: parent as NonNullable<import('grammy/types').Update['business_message']>,
    });
    await service.tick();
    expect(analyzer.analyze).not.toHaveBeenCalled();
    await math.handle({
      update_id: 2,
      business_message: request as NonNullable<import('grammy/types').Update['business_message']>,
    });
    await service.receive(request);
    const queued = s.db.prepare('SELECT payload FROM document_jobs').get() as { payload: string };
    expect(queued.payload).not.toContain('file-secret-id');
    await service.tick();
    await service.tick();
    await outbox.flush();
    expect(analyzer.analyze).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0]![1].ref.messageId).toBe('100');
    expect(extract.mock.calls[0]![1].attachment?.name).toBe('contract.txt');
    expect(s.db.prepare('SELECT state,payload,result FROM document_jobs').get()).toEqual({
      state: 'done',
      payload: '',
      result: null,
    });
    expect(s.db.prepare('SELECT count(*) AS n FROM document_analyses').get()).toEqual({ n: 1 });
    expect(
      api.sendMessage.mock.calls.every(
        (call) => call[0] === String(owner) && !('business_connection_id' in (call[2] ?? {})),
      ),
    ).toBe(true);
    expect(api.sendMessage.mock.calls.some((call) => call[1].includes('15 000 рублей'))).toBe(true);
  });
  it('чужая фраза и сообщение бота не разрешают анализ', async () => {
    const { service, analyzer, s } = setup();
    await service.receive(reply(msg('изучу', 101, true, 555)));
    await service.receive({
      ...reply(msg('изучу', 102, true)),
      sender_business_bot: { id: 99, is_bot: true, first_name: 'Bot' },
    });
    await service.receive({
      ...reply(msg('изучу', 103, true)),
      date: Math.floor(Date.now() / 1000) - 200,
    });
    await service.tick();
    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(s.db.prepare('SELECT count(*) AS n FROM document_jobs').get()).toEqual({ n: 0 });
  });
  it('проверяет владельца соединения, личный чат и чужие команды', async () => {
    const { service, api, analyzer } = setup();
    api.getBusinessConnection.mockResolvedValueOnce({
      id: 'conn',
      user: { id: 777, is_bot: false, first_name: 'Other' },
      user_chat_id: 777,
      date: 1,
      is_enabled: true,
      rights: { can_reply: true },
    });
    await service.receive(reply(msg('изучу', 101, true)));
    expect(service.ownerMessage(reply(msg('/analyze', 1, false, 777), document(100, false)))).toBe(
      false,
    );
    expect(
      service.ownerMessage({ ...msg('/docs'), chat: { id: -5, type: 'group', title: 'Group' } }),
    ).toBe(false);
    await service.tick();
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });
  it('не угадывает файл без Reply и не следует Reply из другого чата', async () => {
    const { service, analyzer, outbox, api } = setup();
    await service.receive(msg('изучу договор', 101, true));
    const wrong = document();
    wrong.chat.id = 777;
    await service.receive(reply(msg('изучу', 102, true), wrong));
    await service.tick();
    await outbox.flush();
    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(api.sendMessage.mock.calls.every((call) => call[1].includes('Reply'))).toBe(true);
  });
  it('поддерживает /analyze и файл с подписью в личке; голый файл не анализируется', async () => {
    const { service, analyzer } = setup();
    expect(service.ownerMessage(document(100, false))).toBe(false);
    service.ownerMessage(reply(msg('/analyze'), document(100, false)));
    await service.tick();
    service.ownerMessage({ ...document(102, false), caption: 'разбери' });
    await service.tick();
    expect(analyzer.analyze).toHaveBeenCalledTimes(2);
  });
  it('документы выключены, dry-run и пауза не вызывают модель или загрузку', async () => {
    for (const extra of [
      { BUSINESS_DOCUMENTS_ENABLED: 'false' },
      { BUSINESS_DRY_RUN: 'true' },
      {},
    ]) {
      const { service, s, analyzer, extract } = setup(extra);
      if (!Object.keys(extra).length) s.setSetting('business.paused', 'true');
      await service.receive(reply(msg('изучу', 101, true)));
      service.ownerMessage(reply(msg('/analyze'), document(100, false)));
      await service.tick();
      expect(analyzer.analyze).not.toHaveBeenCalled();
      expect(extract).not.toHaveBeenCalled();
    }
  });
  it('сначала проверяет тип и размер, включая настоящий размер при загрузке', async () => {
    const { service, extract, analyzer, outbox, api } = setup();
    for (const [id, name, size] of [
      [101, 'contract.docm', 10],
      [102, 'contract.pdf', 6000000],
    ] as const) {
      const parent = document();
      parent.document!.file_name = name;
      parent.document!.file_size = size;
      await service.receive(reply(msg('изучу', id, true), parent));
    }
    await service.tick();
    await outbox.flush();
    expect(extract).not.toHaveBeenCalled();
    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(api.sendMessage.mock.calls.some((c) => c[1].includes('слишком большой'))).toBe(true);
  });
  it('поддерживает неизвестный размер и отсутствие имени при известном MIME', async () => {
    const { service, extract } = setup();
    const parent = document();
    delete parent.document!.file_name;
    delete parent.document!.file_size;
    await service.receive(reply(msg('изучу', 101, true), parent));
    await service.tick();
    expect(extract.mock.calls[0]![1].attachment).toMatchObject({ name: 'document.txt', size: 1 });
  });
  it('проверяет цитаты и честно сообщает о неудаче без сохранения выдумки', async () => {
    const { service, analyzer, s, outbox, api } = setup();
    const bad = report();
    bad.facts[0]!.quote = 'Выдуманный штраф';
    analyzer.analyze.mockResolvedValue(bad);
    await service.receive(reply(msg('изучу', 101, true)));
    await service.tick();
    await outbox.flush();
    expect(s.db.prepare('SELECT count(*) AS n FROM document_analyses').get()).toEqual({ n: 0 });
    expect(api.sendMessage.mock.calls.some((c) => c[1].includes('Не удалось подтвердить'))).toBe(
      true,
    );
  });
  it('сеть повторяется ограниченно; лимит бюджета останавливает сразу', async () => {
    for (const reason of ['network', 'API_BUDGET_EXCEEDED']) {
      const { service, analyzer, s } = setup();
      analyzer.analyze.mockRejectedValue(new Error(reason));
      await service.receive(reply(msg('изучу', 101, true)));
      for (let i = 0; i < 3; i++) {
        s.db.prepare('UPDATE document_jobs SET available_at=0').run();
        await service.tick();
      }
      expect(analyzer.analyze).toHaveBeenCalledTimes(reason === 'network' ? 3 : 1);
      expect(s.db.prepare('SELECT state,payload FROM document_jobs').get()).toEqual({
        state: 'failed',
        payload: '',
      });
    }
  });
  it('при паузе во время анализа сохраняет результат и не расходует API повторно после рестарта', async () => {
    const { service, analyzer, s, b, c, typedApi, outbox, download, extract } = setup();
    analyzer.analyze.mockImplementationOnce(async () => {
      s.setSetting('business.paused', 'true');
      return report();
    });
    await service.receive(reply(msg('изучу', 101, true)));
    await service.tick();
    expect(s.db.prepare('SELECT state FROM document_jobs').get()).toEqual({ state: 'retry' });
    const restarted = new BusinessDocuments(b, c, s, typedApi, outbox, analyzer, download, extract);
    s.setSetting('business.paused', 'false');
    await restarted.tick();
    expect(analyzer.analyze).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledOnce();
    expect(s.db.prepare('SELECT state FROM document_jobs').get()).toEqual({ state: 'done' });
  });
  it('история и повторное чтение не вызывают модель; удаление очищает БД и ожидающие уведомления', async () => {
    const { service, analyzer, s } = setup();
    await service.receive(reply(msg('изучу', 101, true)));
    await service.tick();
    service.ownerMessage(msg('/docs', 200));
    service.ownerMessage(msg('/doc 1', 201));
    expect(analyzer.analyze).toHaveBeenCalledOnce();
    service.ownerMessage(msg('/forget_doc 1', 202));
    expect(s.db.prepare('SELECT count(*) AS n FROM document_analyses').get()).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT count(*) AS n FROM document_meta').get()).toEqual({ n: 0 });
    expect(
      s.db
        .prepare(
          "SELECT count(*) AS n FROM outbox WHERE id LIKE 'document:%:result:%' AND payload!=''",
        )
        .get(),
    ).toEqual({ n: 0 });
    await service.receive(reply(msg('изучу', 101, true)));
    await service.tick();
    expect(analyzer.analyze).toHaveBeenCalledOnce();
  });
  it('retention убирает выжимки и копии из outbox, оставляя защиту от дублей', async () => {
    const { service, s } = setup();
    await service.receive(reply(msg('изучу', 101, true)));
    await service.tick();
    s.db.prepare('UPDATE document_analyses SET retention_until=0').run();
    service.prune();
    expect(s.db.prepare('SELECT count(*) AS n FROM document_analyses').get()).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT state,payload,result FROM document_jobs').get()).toEqual({
      state: 'done',
      payload: '',
      result: null,
    });
  });
  it('пустая/сканированная страница не маскируется успешным анализом', async () => {
    const { service, extract, analyzer, outbox, api } = setup();
    extract.mockRejectedValueOnce(new Error('DOCUMENT_NO_TEXT_OCR_REQUIRED'));
    await service.receive(reply(msg('изучу', 101, true)));
    await service.tick();
    await outbox.flush();
    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(api.sendMessage.mock.calls.some((c) => c[1].includes('OCR'))).toBe(true);
  });
});
describe('Ограниченная загрузка из Telegram', () => {
  it('использует только Telegram URL, таймаут и запрет перенаправлений', async () => {
    const api = {
      getFile: vi.fn(async () => ({
        file_id: 'id',
        file_unique_id: 'unique',
        file_size: 4,
        file_path: 'documents/file_1.txt',
      })),
    };
    const fetcher = vi.fn(async () => new Response('test'));
    expect(
      (
        await downloadTelegramDocument(
          api as never,
          'secret',
          'id',
          10,
          fetcher as unknown as typeof fetch,
        )
      ).toString(),
    ).toBe('test');
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.telegram.org/file/botsecret/documents/file_1.txt',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
  });
  it.each([
    '../secret',
    'https://evil.test/file',
    '/etc/passwd',
    'documents/../secret',
    'documents/file?token=secret',
  ])('отклоняет путь: %s', async (file_path) => {
    const fetcher = vi.fn();
    const api = {
      getFile: vi.fn(async () => ({ file_id: 'id', file_unique_id: 'unique', file_path })),
    };
    await expect(
      downloadTelegramDocument(api as never, 'secret', 'id', 10, fetcher),
    ).rejects.toThrow('DOCUMENT_BAD_FILE_PATH');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('не доверяет отсутствующему или ложному content-length, ограничивает поток', async () => {
    const api = {
      getFile: vi.fn(async () => ({
        file_id: 'id',
        file_unique_id: 'unique',
        file_path: 'documents/file.txt',
      })),
    };
    for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '100' }]) {
      const fetcher = vi.fn(async () => new Response('x'.repeat(20), { headers }));
      await expect(
        downloadTelegramDocument(
          api as never,
          'secret',
          'id',
          10,
          fetcher as unknown as typeof fetch,
        ),
      ).rejects.toThrow('DOCUMENT_TOO_LARGE');
    }
  });
  it('сетевая ошибка не раскрывает токен в сообщении исключения', async () => {
    const api = {
      getFile: vi.fn(async () => {
        throw new Error('URL token secret');
      }),
    };
    await expect(downloadTelegramDocument(api as never, 'secret', 'id', 10)).rejects.toThrow(
      'DOCUMENT_DOWNLOAD_FAILED',
    );
  });
});
