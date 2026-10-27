import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './helpers.js';
import type { Store } from '../src/storage/database.js';

let browser: Browser;
let dir: string;
const stores: Store[] = [];
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  dir = mkdtempSync(join(tmpdir(), 'kronk-forms-'));
  writeFileSync(
    join(dir, 'profile.json'),
    JSON.stringify({ 'events.example.org': { full_name: 'Test User', email: 'test@example.org' } }),
  );
});
afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
  await page?.context().close();
  for (const s of stores.splice(0)) s.close();
  vi.restoreAllMocks();
});
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Бесплатное мероприятие</h1><form action='/submit' method='post'><label>Имя<input name='full_name' required></label><label>Email<input name='email' type='email' required></label><input type='hidden' name='csrf' value='test-csrf'><button type='submit'>Зарегистрироваться</button></form></body></html>`;
type BrowserSeam = {
  browser: <T>(url: string, run: (p: Page) => Promise<T>, action?: string | null) => Promise<T>;
};
async function setup(content = html) {
  const h = harness({
    MODE: 'live',
    DRY_RUN: false,
    REGISTRATIONS_ENABLED: true,
    REGISTRATION_DOMAINS: ['events.example.org'],
    REGISTRATION_PROFILE_PATH: join(dir, 'profile.json'),
  });
  stores.push(h.s);
  const requests: { method: string; url: string; body: string | null }[] = [];
  const context = await browser.newContext({ javaScriptEnabled: false });
  page = await context.newPage();
  await page.route('**/*', async (route) => {
    const r = route.request();
    requests.push({ method: r.method(), url: r.url(), body: r.postData() });
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: r.method() === 'POST' ? '<p>Request received</p>' : content,
    });
  });
  // Browser seam bypasses real websites only; uses actual Chromium DOM and native POST.
  vi.spyOn(h.registration as unknown as BrowserSeam, 'browser').mockImplementation(
    async (_url, run) => {
      await page.goto('https://events.example.org/form');
      return run(page);
    },
  );
  return { ...h, requests };
}
const token = (preview: string) => preview.match(/\/approve ([A-Za-z0-9_-]+)/)![1]!;
describe('Регистрации в изолированном Chromium', () => {
  it('предпросмотр не передаёт профиль; явное подтверждение отправляет один POST', async () => {
    const { registration, requests, s } = await setup();
    const preview = await registration.prepare('operation-a', 'https://events.example.org/form');
    expect(preview).toContain('events.example.org');
    expect(preview).toContain('test@example.org');
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('test@example.org');
    const approval = token(preview);
    expect(await registration.approve(approval)).toContain('Форма отправлена');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(requests.find((r) => r.method === 'POST')!.body).toContain('email=test%40example.org');
    expect(await registration.approve(approval)).toContain('истекло или уже использовано');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(s.db.prepare('SELECT approval_status FROM registrations').get()).toEqual({
      approval_status: 'submitted',
    });
  });
  it('истёкшее подтверждение не отправляет форму', async () => {
    const { registration, requests, s } = await setup();
    const preview = await registration.prepare('expired', 'https://events.example.org/form');
    s.db.prepare('UPDATE registrations SET expires_at=0').run();
    expect(await registration.approve(token(preview))).toContain('истекло');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
  it('dry-run блокирует отправку даже с действующим токеном', async () => {
    const { registration, requests, c } = await setup();
    const preview = await registration.prepare('dry', 'https://events.example.org/form');
    c.DRY_RUN = true;
    expect(await registration.approve(token(preview))).toContain('заблокирована');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
  it.each([
    html.replace('Бесплатное мероприятие', 'Оплата 500 рублей'),
    html.replace("name='email'", "name='unknown_required_field'"),
    html.replace("name='email' type='email'", "name='password' type='password'"),
  ])('отказывается от платных/неизвестных/защищённых форм', async (content) => {
    const { registration, requests } = await setup(content);
    await expect(
      registration.prepare('blocked', 'https://events.example.org/form'),
    ).rejects.toThrow();
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
  it('изменение формы после preview не приводит к передаче профиля', async () => {
    const { registration, requests } = await setup();
    const preview = await registration.prepare('changed', 'https://events.example.org/form');
    vi.mocked((registration as unknown as BrowserSeam).browser).mockImplementation(
      async (_url, run) => {
        await page.goto('https://events.example.org/form');
        await page.locator('form').evaluate((el) => {
          (el as HTMLFormElement).action = '/other-endpoint';
        });
        return run(page);
      },
    );
    expect(await registration.approve(token(preview))).toContain('Не удалось подтвердить');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});
