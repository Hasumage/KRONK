process.once('message', (input) => {
  void extract(
    input as {
      bytes: Uint8Array;
      ext: string;
      maxPages: number;
      maxChars: number;
      allowVisualOnly?: boolean;
    },
  );
});
async function extract({
  bytes,
  ext,
  maxPages,
  maxChars,
  allowVisualOnly = false,
}: {
  bytes: Uint8Array;
  ext: string;
  maxPages: number;
  maxChars: number;
  allowVisualOnly?: boolean;
}): Promise<void> {
  try {
    const buffer = Buffer.from(bytes);
    let text = '';
    if (ext === 'txt') {
      const encoding =
        buffer[0] === 0xff && buffer[1] === 0xfe
          ? 'utf-16le'
          : buffer[0] === 0xfe && buffer[1] === 0xff
            ? 'utf-16be'
            : 'utf-8';
      const decoded = new TextDecoder(encoding, { fatal: true }).decode(buffer);
      if (decoded.includes('\0')) throw new Error('DOCUMENT_BAD_TEXT_ENCODING');
      text = decoded
        .split('\n')
        .filter((s) => s.trim())
        .map((s, i) => `[абзац ${i + 1}] ${s}`)
        .join('\n');
    }
    if (ext === 'docx') {
      const { default: mammoth } = await import('mammoth');
      if (buffer.subarray(0, 2).toString() !== 'PK') throw new Error('DOCUMENT_BAD_SIGNATURE');
      if (/vbaproject\.bin/iu.test(buffer.toString('latin1')))
        throw new Error('DOCUMENT_MACROS_UNSUPPORTED');
      const r = await mammoth.extractRawText({ buffer });
      text = r.value
        .split('\n\n')
        .filter((s) => s.trim())
        .map((s, i) => `[абзац ${i + 1}] ${s}`)
        .join('\n');
    }
    if (ext === 'pdf') {
      const { PDFParse } = await import('pdf-parse');
      if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('DOCUMENT_BAD_SIGNATURE');
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const info = await parser.getInfo();
        if (info.total > maxPages) throw new Error('DOCUMENT_TOO_MANY_PAGES');
        const r = await parser.getText();
        const blank = r.pages.filter((p) => !p.text.trim()).map((p) => p.num);
        if (blank.length !== r.pages.length || allowVisualOnly) {
          text = r.pages.map((p) => `[страница ${p.num}] ${p.text}`).join('\n');
          if (blank.length)
            text =
              `[ограничение извлечения] На страницах ${blank.join(', ')} не найден текст: они могут быть пустыми или сканами. Для них нужен ручной просмотр или OCR.\n` +
              text;
        }
      } finally {
        await parser.destroy();
      }
    }
    if (text.length > maxChars) throw new Error('DOCUMENT_TEXT_TOO_LARGE');
    process.send?.({ text });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    process.send?.({
      error: /^DOCUMENT_[A-Z_]+$/.test(message)
        ? message
        : 'DOCUMENT_EXTRACTION_FAILED_OR_LIMIT_EXCEEDED',
    });
  }
}
