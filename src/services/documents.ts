import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Settings } from '../config/settings.js';
import type { InputMessage } from '../domain/schema.js';
import type { AI } from '../adapters/ai.js';

export type Download = (message: InputMessage, maxBytes: number) => Promise<Buffer>;
export async function summarizeDocument(
  c: Settings,
  message: InputMessage,
  download: Download,
  ai: AI,
): Promise<string> {
  return ai.summarize(await extractDocument(c, message, download, c.MAX_CONTEXT_CHARS));
}
export async function extractDocument(
  c: Settings,
  message: InputMessage,
  download: Download,
  maxChars = c.MAX_DOCUMENT_CHARS,
  allowVisualOnly = false,
): Promise<string> {
  const file = message.attachment;
  if (!file || file.size > c.MAX_DOCUMENT_BYTES || file.size <= 0)
    throw new Error('DOCUMENT_SIZE_UNSUPPORTED');
  const ext = file.name.toLowerCase().split('.').pop();
  if (!['pdf', 'docx', 'txt'].includes(ext ?? '')) throw new Error('DOCUMENT_TYPE_UNSUPPORTED');
  const bytes = await download(message, c.MAX_DOCUMENT_BYTES);
  if (bytes.length > c.MAX_DOCUMENT_BYTES) throw new Error('DOCUMENT_TOO_LARGE');
  // Separate process contains parser crashes; heap/time limits bound extraction work.
  const text = await new Promise<string>((resolve, reject) => {
    const w = fork(fileURLToPath(new URL('./extract-worker.js', import.meta.url)), [], {
      execArgv: ['--max-old-space-size=128'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
      env: Object.fromEntries(
        ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'].flatMap((key) =>
          process.env[key] ? [[key, process.env[key]!]] : [],
        ),
      ),
    });
    const timer = setTimeout(() => {
      w.kill();
      reject(new Error('DOCUMENT_TIMEOUT'));
    }, 15000);
    w.once('message', (m: { text?: string; error?: string }) => {
      clearTimeout(timer);
      w.kill();
      m.error ? reject(new Error(m.error)) : resolve(m.text ?? '');
    });
    w.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    w.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('DOCUMENT_WORKER_FAILED'));
    });
    w.send({ bytes, ext, maxPages: c.MAX_DOCUMENT_PAGES, maxChars, allowVisualOnly });
  });
  if (!text.trim()) throw new Error('DOCUMENT_NO_TEXT_OCR_REQUIRED');
  return text;
}
