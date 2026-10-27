import { describe, it, expect } from 'vitest';
import { settings } from '../src/config/settings.js';
import type { InputMessage } from '../src/domain/schema.js';
const c = settings({});
const doc = (name: string, bytes: Buffer): InputMessage => ({
  ref: { accountId: '1', chatId: '2', messageId: '3' },
  senderId: '2',
  direction: 'incoming',
  text: '',
  sentAt: new Date().toISOString(),
  replyTo: null,
  generatedByAssistant: false,
  attachment: { name, size: bytes.length, mime: 'application/octet-stream' },
});
function pdf(pages: string[]): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((text, i) => {
    const stream = text ? `BT /F1 12 Tf 72 700 Td (${text}) Tj ET` : '';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const at = Buffer.byteLength(out);
  out +=
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => n.toString().padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  return Buffer.from(out);
}
describe('Реальный изолированный процесс извлечения документов', () => {
  it('отрисовывает настоящие страницы PDF в PNG, ограничивает выборку и число страниц', async () => {
    const { renderPdfPages } = await import('../dist/documents/render.js');
    const bytes = pdf(['First slide', 'Middle slide', 'Last slide']);
    const images = await renderPdfPages(bytes, 50, 2);
    expect(images.pages.map((p) => p.pageNumber)).toEqual([1, 3]);
    expect(images.total).toBe(3);
    const png = Buffer.from(images.pages[0]!.dataUrl.split(',')[1]!, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    await expect(renderPdfPages(bytes, 1, 2)).rejects.toThrow('DOCUMENT_TOO_MANY_PAGES');
  }, 15000);
  it('читает UTF-16 TXT и маркирует абзацы', async () => {
    const { extractDocument } = await import('../dist/services/documents.js');
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Договор\nСумма 15 000 рублей', 'utf16le'),
    ]);
    const text = await extractDocument(c, doc('contract.txt', bytes), async () => bytes);
    expect(text).toContain('[абзац 2] Сумма 15 000 рублей');
  });
  it('не обрезает большой текст молча, соблюдает отдельный лимит документов', async () => {
    const { extractDocument } = await import('../dist/services/documents.js');
    const bytes = Buffer.from('а'.repeat(13000));
    expect(
      (await extractDocument(c, doc('long.txt', bytes), async () => bytes)).length,
    ).toBeGreaterThan(c.MAX_CONTEXT_CHARS);
    await expect(
      extractDocument({ ...c, MAX_DOCUMENT_CHARS: 100 }, doc('long.txt', bytes), async () => bytes),
    ).rejects.toThrow('DOCUMENT_TEXT_TOO_LARGE');
  });
  it('пустой PDF требует OCR, непустые маркеры страниц не считаются текстом', async () => {
    const { extractDocument } = await import('../dist/services/documents.js');
    const bytes = pdf(['']);
    await expect(extractDocument(c, doc('scan.pdf', bytes), async () => bytes)).rejects.toThrow(
      'DOCUMENT_NO_TEXT_OCR_REQUIRED',
    );
    const visualText = await extractDocument(
      c,
      doc('scan.pdf', bytes),
      async () => bytes,
      c.MAX_DOCUMENT_CHARS,
      true,
    );
    expect(visualText).toContain('[страница 1]');
  });
  it('частичный скан явно помечает, сохраняет номера и ограничивает страницы', async () => {
    const { extractDocument } = await import('../dist/services/documents.js');
    const bytes = pdf(['Actual contract text', '']);
    const text = await extractDocument(c, doc('mixed.pdf', bytes), async () => bytes);
    expect(text).toContain('[страница 1]');
    expect(text).toContain('[ограничение извлечения] На страницах 2');
    await expect(
      extractDocument({ ...c, MAX_DOCUMENT_PAGES: 1 }, doc('mixed.pdf', bytes), async () => bytes),
    ).rejects.toThrow('DOCUMENT_TOO_MANY_PAGES');
  });
  it('не принимает бинарный TXT и макросы в переименованном DOCX', async () => {
    const { extractDocument } = await import('../dist/services/documents.js');
    const binary = Buffer.from([65, 0, 66]);
    await expect(extractDocument(c, doc('binary.txt', binary), async () => binary)).rejects.toThrow(
      'DOCUMENT_BAD_TEXT_ENCODING',
    );
    const macro = Buffer.from('PK fake ZIP central directory word/vbaProject.bin');
    await expect(extractDocument(c, doc('renamed.docx', macro), async () => macro)).rejects.toThrow(
      'DOCUMENT_MACROS_UNSUPPORTED',
    );
  });
});
