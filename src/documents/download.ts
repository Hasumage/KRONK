import type { Api } from 'grammy';
/** Downloads only Telegram-owned file paths; bounded streaming, no redirects or disk writes. */
export async function downloadTelegramDocument(
  api: Pick<Api, 'getFile'>,
  token: string,
  fileId: string,
  maxBytes: number,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  let path: string;
  try {
    const file = await api.getFile(fileId);
    if (file.file_size && file.file_size > maxBytes) throw new Error('DOCUMENT_TOO_LARGE');
    if (
      !file.file_path ||
      !/^[a-zA-Z0-9_/-][a-zA-Z0-9_/.-]*$/.test(file.file_path) ||
      file.file_path.startsWith('/') ||
      file.file_path.split('/').some((p) => p === '..' || p === '.')
    )
      throw new Error('DOCUMENT_BAD_FILE_PATH');
    path = file.file_path;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('DOCUMENT_')) throw error;
    throw new Error('DOCUMENT_DOWNLOAD_FAILED');
  }
  try {
    const response = await fetcher(`https://api.telegram.org/file/bot${token}/${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok || !response.body) throw new Error('DOCUMENT_DOWNLOAD_FAILED');
    const size = Number(response.headers.get('content-length'));
    if (size > maxBytes) {
      await response.body.cancel();
      throw new Error('DOCUMENT_TOO_LARGE');
    }
    const reader = response.body.getReader(),
      chunks: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > maxBytes) throw new Error('DOCUMENT_TOO_LARGE');
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!length) throw new Error('DOCUMENT_DOWNLOAD_FAILED');
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('DOCUMENT_')) throw error;
    throw new Error('DOCUMENT_DOWNLOAD_FAILED');
  }
}
