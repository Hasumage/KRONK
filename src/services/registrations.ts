import { chromium, type Page } from 'playwright';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Settings } from '../config/settings.js';
import type { Store } from '../storage/database.js';
import { safeUrl, secureProxy } from '../security/urls.js';

const profileSchema = z.record(z.string(), z.record(z.string(), z.string().max(1000)));
interface Form {
  url: string;
  action: string;
  method: string;
  fields: { name: string; type: string; required: boolean; value: string }[];
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export class Registrations {
  constructor(
    private readonly c: Settings,
    private readonly store: Store,
  ) {}
  private async browser<T>(
    url: string,
    run: (page: Page) => Promise<T>,
    submitAction: string | null = null,
  ): Promise<T> {
    safeUrl(url, this.c.REGISTRATION_DOMAINS);
    const proxy = await secureProxy([new URL(url).hostname]);
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    try {
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        proxy: { server: proxy.url },
        args: ['--proxy-bypass-list=<-loopback>', '--disable-quic'],
      });
    } catch (error) {
      await proxy.close();
      throw error;
    }
    try {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      let count = 0;
      await context.route('**/*', async (route) => {
        const request = route.request();
        try {
          const u = safeUrl(request.url(), this.c.REGISTRATION_DOMAINS);
          if (
            u.origin !== new URL(url).origin ||
            ++count > 40 ||
            (request.redirectedFrom() && redirectDepth(request) > 3) ||
            !['document', 'stylesheet', 'image', 'font'].includes(request.resourceType())
          )
            return await route.abort();
          if (
            request.method() !== 'GET' &&
            !(submitAction && u.href === submitAction && request.method() === 'POST')
          )
            return await route.abort();
          // Reject redirects rather than allowing the browser to follow an unreviewed destination.
          const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
          if (response.status() >= 300 && response.status() < 400) return await route.abort();
          await route.fulfill({ response });
        } catch {
          await route.abort();
        }
      });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return await run(page);
    } finally {
      await browser.close();
      await proxy.close();
    }
  }
  private async inspect(page: Page): Promise<Form> {
    const text = (await page.locator('body').innerText()).slice(0, 100000);
    if (
      !/бесплатн|\bfree\b/i.test(text) ||
      /captcha|капч|оплат|стоимость|платн|payment|password|одноразов|войти|логин|\bOTP\b/i.test(
        text.replace(/бесплатн\S*/gi, ''),
      ) ||
      (await page.locator('input[type=password],iframe,input[type=file]').count())
    )
      throw new Error('REGISTRATION_REQUIRES_MANUAL_ACTION');
    if ((await page.locator('form').count()) !== 1)
      throw new Error('REGISTRATION_UNSUPPORTED_FORM');
    const form = await page.locator('form').evaluate((el) => {
      const f = el as HTMLFormElement;
      return {
        url: location.href,
        action: f.action,
        method: f.method.toUpperCase(),
        fields: Array.from(f.elements)
          .filter((e) => e instanceof HTMLInputElement && !['submit', 'button'].includes(e.type))
          .map((e) => {
            const i = e as HTMLInputElement;
            return { name: i.name, type: i.type, required: i.required, value: i.value };
          }),
      };
    });
    if (form.method !== 'POST' || new URL(form.action).origin !== new URL(form.url).origin)
      throw new Error('REGISTRATION_UNSUPPORTED_METHOD_OR_DOMAIN');
    safeUrl(form.action, this.c.REGISTRATION_DOMAINS);
    if (
      (await page.locator('select,textarea,button[formaction],input[formaction]').count()) ||
      form.fields.some((f) => !f.name || !['text', 'email', 'tel', 'hidden'].includes(f.type))
    )
      throw new Error('REGISTRATION_UNKNOWN_FIELDS');
    return form;
  }
  async prepare(id: string, url: string): Promise<string> {
    const existing = this.store.db
      .prepare('SELECT payload,approval_status FROM registrations WHERE id=?')
      .get(id) as { payload: string; approval_status: string } | undefined;
    if (existing)
      return (
        this.store.vault.open<{ preview?: string }>(existing.payload).preview ??
        'Предпросмотр уже подготовлен. Используйте ранее выданное подтверждение или отмените операцию.'
      );
    const form = await this.browser(url, (p) => this.inspect(p));
    const profiles = profileSchema.parse(
      JSON.parse(readFileSync(this.c.REGISTRATION_PROFILE_PATH, 'utf8')),
    );
    const values = profiles[new URL(form.url).hostname] ?? {};
    const visible = form.fields.filter((f) => f.type !== 'hidden');
    if (!visible.length || visible.some((f) => !values[f.name]))
      throw new Error('REGISTRATION_PROFILE_FIELDS_MISSING');
    const token = randomBytes(24).toString('base64url');
    const payload = {
      form,
      values: Object.fromEntries(visible.map((f) => [f.name, values[f.name]!])),
      fingerprint: hash(
        JSON.stringify({
          ...form,
          fields: form.fields.filter((f) => f.type !== 'hidden').map((f) => ({ ...f, value: '' })),
        }),
      ),
    };
    const preview = `Предпросмотр регистрации\nДомен: ${new URL(form.url).hostname}\n${Object.entries(
      payload.values,
    )
      .map(([k, v]) => `${k}: ${v}`)
      .join(
        '\n',
      )}\nДанные ещё не переданы сайту. Подтвердить передачу и отправку (срок ${this.c.APPROVAL_TTL_MINUTES} мин):\n/approve ${token}\nОтмена: /reject ${id}`;
    if (preview.length > 3400) throw new Error('REGISTRATION_PREVIEW_TOO_LARGE');
    this.store.db
      .prepare(
        'INSERT INTO registrations(id,domain,payload,token_hash,expires_at) VALUES (?,?,?,?,?)',
      )
      .run(
        id,
        new URL(form.url).hostname,
        this.store.vault.seal({ ...payload, preview }),
        hash(token),
        Date.now() + this.c.APPROVAL_TTL_MINUTES * 60000,
      );
    return preview;
  }
  async approve(token: string): Promise<string> {
    if (
      this.c.DRY_RUN ||
      this.c.MODE !== 'live' ||
      !this.c.REGISTRATIONS_ENABLED ||
      this.store.getSetting('paused') === 'true'
    )
      return 'Отправка заблокирована настройками режима.';
    const row = this.store.db
      .prepare(
        "SELECT id,payload FROM registrations WHERE token_hash=? AND approval_status='pending' AND expires_at>?",
      )
      .get(hash(token), Date.now()) as { id: string; payload: string } | undefined;
    if (!row) return 'Подтверждение истекло или уже использовано.';
    const p = this.store.vault.open<{
      form: Form;
      values: Record<string, string>;
      fingerprint: string;
    }>(row.payload);
    if (
      !this.store.db
        .prepare(
          "UPDATE registrations SET approval_status='submitting' WHERE id=? AND approval_status='pending'",
        )
        .run(row.id).changes
    )
      return 'Операция уже обрабатывается.';
    try {
      await this.browser(
        p.form.url,
        async (page) => {
          const form = await this.inspect(page);
          const fingerprint = hash(
            JSON.stringify({
              ...form,
              fields: form.fields
                .filter((f) => f.type !== 'hidden')
                .map((f) => ({ ...f, value: '' })),
            }),
          );
          if (fingerprint !== p.fingerprint) throw new Error('REGISTRATION_FORM_CHANGED');
          for (const [name, value] of Object.entries(p.values)) {
            const inputs = page.locator('input');
            let found = false;
            for (let i = 0; i < (await inputs.count()); i++)
              if ((await inputs.nth(i).getAttribute('name')) === name) {
                await inputs.nth(i).fill(value);
                found = true;
                break;
              }
            if (!found) throw new Error('REGISTRATION_FIELD_CHANGED');
          }
          const buttons = page.locator(
            'form button[type=submit], form input[type=submit],form button:not([type])',
          );
          if ((await buttons.count()) !== 1) throw new Error('REGISTRATION_SUBMIT_AMBIGUOUS');
          const response = page.waitForResponse(
            (r) => r.url() === form.action && r.request().method() === 'POST',
          );
          await buttons.click();
          const r = await response;
          if (r.status() >= 400) throw new Error('REGISTRATION_SUBMIT_HTTP_ERROR');
        },
        p.form.action,
      );
      this.store.db
        .prepare("UPDATE registrations SET approval_status='submitted',submitted_at=? WHERE id=?")
        .run(Date.now(), row.id);
      return 'Форма отправлена. Факт регистрации проверьте в письме организатора; HTTP-ответ не гарантирует регистрацию.';
    } catch {
      this.store.db
        .prepare("UPDATE registrations SET approval_status='uncertain' WHERE id=?")
        .run(row.id);
      return 'Не удалось подтвердить отправку. Автоматического повтора не будет; проверьте сайт вручную.';
    }
  }
}
function redirectDepth(r: import('playwright').Request): number {
  let n = 0;
  let prev = r.redirectedFrom();
  while (prev) {
    n++;
    prev = prev.redirectedFrom();
  }
  return n;
}
