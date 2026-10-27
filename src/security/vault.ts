import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('ENCRYPTION_KEY_MUST_BE_32_BYTES_BASE64');
  }
  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  open<T>(value: string): T {
    const b = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8'),
    ) as T;
  }
}
export function localVault(path: string, encodedKey: string, live: boolean): Vault {
  if (encodedKey) return new Vault(Buffer.from(encodedKey, 'base64'));
  if (live) throw new Error('ENCRYPTION_KEY_REQUIRED');
  mkdirSync(dirname(path), { recursive: true });
  const keyPath = join(dirname(path), 'mock.key');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  return new Vault(readFileSync(keyPath));
}
