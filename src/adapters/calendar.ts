import { OAuth2Client, type Credentials } from 'google-auth-library';
import type { Settings } from '../config/settings.js';
import type { Store } from '../storage/database.js';
import type { Analysis } from '../domain/schema.js';

export interface CalendarEvent {
  id: string;
  url: string;
  title: string;
  startAt: string;
  endAt: string;
  location: string | null;
  assumedDuration: boolean;
}
export interface Calendar {
  create(id: string, data: Analysis['data']): Promise<CalendarEvent>;
  update(event: CalendarEvent, data: Analysis['data']): Promise<CalendarEvent>;
  cancel(id: string): Promise<void>;
}
export class GoogleCalendar implements Calendar {
  private readonly auth: OAuth2Client;
  constructor(
    private readonly c: Settings,
    store: Store,
  ) {
    this.auth = new OAuth2Client(
      c.GOOGLE_CLIENT_ID,
      c.GOOGLE_CLIENT_SECRET,
      `http://127.0.0.1:${c.OAUTH_PORT}/callback`,
    );
    const tokens = store.secret<Credentials>('google');
    if (tokens) this.auth.setCredentials(tokens);
    this.auth.on('tokens', (t) => {
      const merged = { ...store.secret<Credentials>('google'), ...t };
      store.putSecret('google', merged);
    });
  }
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.auth.request<T>({
      url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.c.GOOGLE_CALENDAR_ID)}/events${path}`,
      method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
      ...(body ? { data: body } : {}),
      timeout: 30_000,
      retry: false,
    });
    return r.data;
  }
  async create(id: string, data: Analysis['data']): Promise<CalendarEvent> {
    // SHA256 hexadecimal is a valid Calendar base32hex ID. Stable across retries/crashes.
    let saved: {
      id: string;
      htmlLink: string;
      summary: string;
      start: { dateTime: string };
      end: { dateTime: string };
      location?: string;
    };
    const endAt =
      data.endAt ??
      new Date(
        Date.parse(data.startAt!) + this.c.DEFAULT_EVENT_DURATION_MINUTES * 60000,
      ).toISOString();
    try {
      saved = await this.call('GET', `/${id}`);
    } catch (err) {
      if ((err as { response?: { status: number } }).response?.status !== 404) throw err;
      try {
        saved = await this.call('POST', '', {
          id,
          summary: data.title,
          start: { dateTime: data.startAt, timeZone: this.c.TIMEZONE },
          end: { dateTime: endAt, timeZone: this.c.TIMEZONE },
          ...(data.location ? { location: data.location } : {}),
          reminders: {
            useDefault: false,
            overrides: [{ method: 'popup', minutes: this.c.CALENDAR_REMINDER_MINUTES }],
          },
        });
      } catch (e) {
        if ((e as { response?: { status: number } }).response?.status !== 409) throw e;
        saved = await this.call('GET', `/${id}`);
      }
    }
    return {
      id: saved.id,
      url: saved.htmlLink,
      title: saved.summary,
      startAt: saved.start.dateTime,
      endAt: saved.end.dateTime,
      location: saved.location ?? null,
      assumedDuration: data.endAt === null,
    };
  }
  async update(event: CalendarEvent, data: Analysis['data']): Promise<CalendarEvent> {
    const endAt =
      data.endAt ??
      new Date(
        Date.parse(data.startAt!) + (Date.parse(event.endAt) - Date.parse(event.startAt)),
      ).toISOString();
    await this.call('PATCH', `/${event.id}`, {
      summary: data.title ?? event.title,
      start: { dateTime: data.startAt, timeZone: this.c.TIMEZONE },
      end: { dateTime: endAt, timeZone: this.c.TIMEZONE },
      ...(data.location !== null ? { location: data.location } : {}),
    });
    return {
      ...event,
      title: data.title ?? event.title,
      startAt: data.startAt!,
      endAt,
      location: data.location ?? event.location,
    };
  }
  async cancel(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/${id}`);
    } catch (e) {
      if (![404, 410].includes((e as { response?: { status: number } }).response?.status ?? 0))
        throw e;
    }
  }
}
export class MockCalendar implements Calendar {
  readonly events = new Map<string, CalendarEvent>();
  constructor(private readonly c: Settings) {}
  async create(id: string, d: Analysis['data']): Promise<CalendarEvent> {
    const existing = this.events.get(id);
    if (existing) return existing;
    const event = {
      id,
      url: `https://calendar.google.com/calendar/ (MOCK ${id.slice(0, 8)})`,
      title: d.title!,
      startAt: d.startAt!,
      endAt:
        d.endAt ??
        new Date(
          Date.parse(d.startAt!) + this.c.DEFAULT_EVENT_DURATION_MINUTES * 60000,
        ).toISOString(),
      location: d.location,
      assumedDuration: !d.endAt,
    };
    this.events.set(id, event);
    return event;
  }
  async update(e: CalendarEvent, d: Analysis['data']): Promise<CalendarEvent> {
    const updated = {
      ...e,
      title: d.title ?? e.title,
      startAt: d.startAt ?? e.startAt,
      endAt: d.endAt ?? e.endAt,
    };
    this.events.set(e.id, updated);
    return updated;
  }
  async cancel(id: string): Promise<void> {
    this.events.delete(id);
  }
}
