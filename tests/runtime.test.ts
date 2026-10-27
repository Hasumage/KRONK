import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/main.js', ...args], { env, windowsHide: true });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI_TIMEOUT'));
    }, 10000);
    child.stdout.on('data', (b) => (output += b.toString()));
    child.stderr.on('data', (b) => (output += b.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}
describe('Автономная проверка собранного приложения', () => {
  it('CLI demo → inspect → replay не дублирует операции, сохраняет русский текст', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kronk-cli-'));
    try {
      const env = {
        ...process.env,
        MODE: 'mock',
        DRY_RUN: 'true',
        ENCRYPTION_KEY: '',
        OWNER_TELEGRAM_ID: '1',
        DATABASE_PATH: join(dir, 'db.sqlite'),
      };
      const first = await run(['demo'], env);
      expect(first.code).toBe(0);
      expect(first.output).toContain('calendar.create');
      const inspect = await run(['inspect'], env);
      expect(inspect.code).toBe(0);
      expect(inspect.output).toContain('Встреча');
      expect(inspect.output).not.toContain('????');
      expect((await run(['demo'], env)).code).toBe(0);
      const again = await run(['inspect'], env);
      expect(again.output).toBe(inspect.output);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
  it('сервис стартует без аккаунтов, health отвечает, после остановки БД открывается', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kronk-service-')),
      port = await freePort();
    const env = {
      ...process.env,
      MODE: 'mock',
      DRY_RUN: 'true',
      ENCRYPTION_KEY: '',
      OWNER_TELEGRAM_ID: '1',
      DATABASE_PATH: join(dir, 'db.sqlite'),
      HEALTH_PORT: port.toString(),
    };
    const child = spawn(process.execPath, ['dist/main.js', 'serve'], {
      env,
      windowsHide: true,
      stdio: 'ignore',
    });
    try {
      let result: Response | undefined;
      for (let i = 0; i < 50; i++) {
        try {
          result = await fetch(`http://127.0.0.1:${port}/health`);
          if (result.ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(result?.status).toBe(200);
      expect(await result!.json()).toMatchObject({ ok: true, mode: 'mock', dryRun: true });
      await stop(child);
      expect((await run(['inspect'], env)).code).toBe(0);
    } finally {
      await stop(child);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
