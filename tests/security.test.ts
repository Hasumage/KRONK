import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { zodTextFormat } from 'openai/helpers/zod';
import { safeUrl, publicIp, secureProxy } from '../src/security/urls.js';
import { Vault } from '../src/security/vault.js';
import { analysisSchema } from '../src/domain/schema.js';
import { settings } from '../src/config/settings.js';
import { resolveContext } from '../src/application/context.js';
import { OpenAIEngine } from '../src/adapters/ai.js';
import { harness, message } from './helpers.js';
import { connect } from 'node:net';

afterEach(() => vi.restoreAllMocks());
describe('Безопасность', () => {
  it.each([
    'http://example.org',
    'https://127.0.0.1',
    'https://[::1]',
    'https://169.254.169.254',
    'https://10.0.0.1',
    'https://localhost',
    'https://example.org@evil.org',
    'https://example.org:8443',
    'https://example.org.evil.org',
  ])('блокирует URL %s', (url) => {
    expect(() =>
      safeUrl(url, [
        'example.org',
        'localhost',
        '127.0.0.1',
        '[::1]',
        '169.254.169.254',
        '10.0.0.1',
      ]),
    ).toThrow();
  });
  it('разрешает точный HTTPS-домен, запрещает не-public IP диапазоны', () => {
    expect(safeUrl('https://example.org/form', ['example.org']).pathname).toBe('/form');
    for (const ip of [
      '127.0.0.1',
      '10.0.0.2',
      '172.16.0.1',
      '192.168.1.2',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
    ])
      expect(publicIp(ip), ip).toBe(false);
    expect(publicIp('8.8.8.8')).toBe(true);
  });
  it('CONNECT-прокси не открывает туннель к частному IP', async () => {
    const proxy = await secureProxy(['127.0.0.1']);
    try {
      const u = new URL(proxy.url);
      const result = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: u.hostname, port: Number(u.port) });
        let response = '';
        socket.setTimeout(2000, () => {
          socket.destroy();
          reject(new Error('proxy timeout'));
        });
        socket.on('connect', () =>
          socket.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'),
        );
        socket.on('data', (b) => (response += b.toString()));
        socket.on('close', () => resolve(response));
        socket.on('error', reject);
      });
      expect(result).not.toContain('200 Connection Established');
    } finally {
      await proxy.close();
    }
  });
  it('AES-GCM скрывает секрет и обнаруживает изменение шифротекста', () => {
    const v = new Vault(randomBytes(32)),
      encrypted = v.seal({ token: 'secret' });
    expect(encrypted).not.toContain('secret');
    expect(v.open(encrypted)).toEqual({ token: 'secret' });
    const bytes = Buffer.from(encrypted, 'base64');
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(() => v.open(bytes.toString('base64'))).toThrow();
    expect(() => new Vault(randomBytes(31))).toThrow();
  });
  it('строгий контракт отклоняет лишние поля; схема совместима с helper Structured Outputs', () => {
    expect(() => analysisSchema.parse({ intent: 'none', execute: 'send' })).toThrow();
    const format = zodTextFormat(analysisSchema, 'intent');
    expect(format.type).toBe('json_schema');
  });
  it('не тратит API после исчерпания бюджета и не пишет переписку в аудит', () => {
    const { s } = harness();
    try {
      s.reserveBudget(1, 0.8);
      expect(() => s.reserveBudget(1, 0.3)).toThrow();
      s.audit('id', 'calendar.create', 'allow');
      expect(JSON.stringify(s.db.prepare('SELECT * FROM audit_log').all())).not.toContain(
        'встреча',
      );
    } finally {
      s.close();
    }
  });
  it('проверяет конфигурацию и отключает автоответы по умолчанию', () => {
    expect(settings({}).AUTO_REPLY_ENABLED).toBe(false);
    expect(settings({}).DRY_RUN).toBe(true);
    expect(() => settings({ MODE: 'live' })).toThrow();
    expect(() => settings({ TIMEZONE: 'invalid' })).toThrow();
  });
  it('отказ или незавершённый ответ OpenAI не превращается в успех', async () => {
    const { s, c } = harness();
    try {
      const engine = new OpenAIEngine({ ...c, OPENAI_API_KEY: 'test', OPENAI_MODEL: 'test' }, s);
      const client = (
        engine as unknown as { client: { responses: { parse: () => Promise<unknown> } } }
      ).client;
      vi.spyOn(client.responses, 'parse').mockResolvedValue({
        output_parsed: null,
        status: 'incomplete',
      });
      await expect(engine.classify(resolveContext(s, c, message(), null, []))).rejects.toThrow(
        'AI_REFUSAL_OR_INCOMPLETE',
      );
    } finally {
      s.close();
    }
  });
});
