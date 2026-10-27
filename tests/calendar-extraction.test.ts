import { afterEach, describe, it, expect, vi } from 'vitest';
import { OpenAICalendarEngine } from '../src/adapters/ai.js';
import { harness, message } from './helpers.js';
import { resolveContext } from '../src/application/context.js';
import { decide } from '../src/application/policy.js';
import type { Store } from '../src/storage/database.js';

const stores: Store[] = [];
function setup() {
  const h = harness();
  stores.push(h.s);
  const ai = new OpenAICalendarEngine(
    { ...h.c, OPENAI_API_KEY: 'test', OPENAI_MODEL: 'test' },
    h.s,
  );
  const client = (ai as unknown as { client: { responses: { parse: () => Promise<unknown> } } })
    .client;
  const parse = vi.spyOn(client.responses, 'parse');
  return { ...h, ai, parse };
}
const extracted = {
  isEvent: true,
  confidence: 0.98,
  attendance: 'accepted',
  requiresClarification: false,
  question: null,
  title: 'Встреча',
  startAt: '2026-10-27T03:00:00+03:00',
  endAt: null,
  location: null,
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
});
describe('Извлечение события после явной команды владельца', () => {
  it('не может потерять ID владельца: источники и разрешение формируются приложением', async () => {
    const { s, c, ai, parse } = setup();
    parse.mockResolvedValue({ status: 'completed', output_parsed: extracted });
    const trigger = message('75074', 'занесу в календарь', true, '75073');
    s.remember(message('75073', 'Встреча 27 октября в 3:00', false, null));
    const ctx = resolveContext(s, c, trigger, null, []),
      result = await ai.classify(ctx);
    expect(result.sourceMessageIds).toEqual(['75074', '75073']);
    expect(result.evidence).toBe(trigger.text);
    expect(decide(c, ctx, result)).toEqual({ kind: 'allow' });
    expect(result.data.startAt).toBe(extracted.startAt);
  });
  it.each(['Да, буду', 'Нет, не смогу, занесу в календарь'])(
    'не обращается к модели без разрешённого намерения: %s',
    async (text) => {
      const { s, c, ai, parse } = setup();
      const result = await ai.classify(resolveContext(s, c, message('102', text), null, []));
      expect(result.intent).toBe('none');
      expect(parse).not.toHaveBeenCalled();
    },
  );
  it('не разрешает моделью инициировать событие от собеседника', async () => {
    const { s, c, ai, parse } = setup();
    const result = await ai.classify(
      resolveContext(s, c, message('102', 'занесу в календарь', false), null, []),
    );
    expect(result.intent).toBe('none');
    expect(parse).not.toHaveBeenCalled();
  });
  it('недостающая дата приводит к вопросу вместо молчаливого none', async () => {
    const { s, c, ai, parse } = setup();
    parse.mockResolvedValue({
      status: 'completed',
      output_parsed: { ...extracted, isEvent: false, startAt: null, title: null },
    });
    const ctx = resolveContext(s, c, message(), null, []),
      result = await ai.classify(ctx);
    expect(result.intent).toBe('calendar.create');
    expect(decide(c, ctx, result).kind).toBe('clarify');
  });
  it('отказ или незавершённый ответ не преобразует в успешное извлечение', async () => {
    const { s, c, ai, parse } = setup();
    parse.mockResolvedValue({ status: 'incomplete', output_parsed: null });
    await expect(ai.classify(resolveContext(s, c, message(), null, []))).rejects.toThrow(
      'AI_REFUSAL_OR_INCOMPLETE',
    );
  });
});
