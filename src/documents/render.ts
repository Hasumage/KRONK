import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export interface RenderedDocument {
  pages: { pageNumber: number; dataUrl: string }[];
  total: number;
}
export async function renderPdfPages(
  bytes: Buffer,
  maxPages: number,
  maxVisual = 8,
): Promise<RenderedDocument> {
  return new Promise((resolve, reject) => {
    const worker = fork(fileURLToPath(new URL('./render-worker.js', import.meta.url)), [], {
      execArgv: ['--max-old-space-size=256'],
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
      worker.kill();
      reject(new Error('DOCUMENT_RENDER_TIMEOUT'));
    }, 30000);
    worker.once('message', (value) => {
      clearTimeout(timer);
      worker.kill();
      const result = value as RenderedDocument & { error?: string };
      if (result.error) reject(new Error(result.error));
      else if (!result.pages?.length) reject(new Error('DOCUMENT_RENDER_FAILED'));
      else resolve(result);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      reject(new Error('DOCUMENT_RENDER_FAILED'));
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('DOCUMENT_RENDER_FAILED'));
    });
    worker.send({ bytes, maxPages, maxVisual });
  });
}
