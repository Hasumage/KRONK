import { writeFileSync } from 'node:fs';
const ref = (id) => ({ accountId: '1', chatId: '10', messageId: id });
const msg = (id, text, out, reply = null) => ({
  ref: ref(id),
  senderId: out ? '1' : '2',
  direction: out ? 'outgoing' : 'incoming',
  text,
  sentAt: '2026-10-25T20:00:00+03:00',
  replyTo: reply ? ref(reply) : null,
  generatedByAssistant: false,
  attachment: null,
});
const data = {
  title: null,
  description: null,
  startAt: null,
  endAt: null,
  location: null,
  dueAt: null,
  targetId: null,
  url: null,
  documentMessageId: null,
  topic: null,
  knowledgeId: null,
};
const analysis = (intent, fields, evidence, sources) => ({
  intent,
  confidence: 0.99,
  explicitUserIntent: !!evidence,
  evidence,
  attendance: 'accepted',
  requiresClarification: false,
  question: null,
  sourceMessageIds: sources,
  data: { ...data, ...fields },
});
writeFileSync(
  'fixtures/demo.json',
  JSON.stringify(
    {
      messages: [
        msg('101', '29 октября, 18:30, встречаемся в центре, адрес пришлю позже', false),
        msg('102', 'Да, буду', true, '101'),
        msg('103', 'Да, буду, занесу в календарь', true, '101'),
        msg('104', 'Подготовь список вопросов для встречи', false),
        msg('105', 'Добавлю себе в задачник', true, '104'),
      ],
      analyses: {
        102: analysis('none', {}, null, ['102']),
        103: analysis(
          'calendar.create',
          { title: 'Встреча', startAt: '2026-10-29T18:30:00+03:00' },
          'занесу в календарь',
          ['101', '103'],
        ),
        105: analysis(
          'task.create',
          { title: 'Подготовить список вопросов для встречи' },
          'Добавлю себе в задачник',
          ['104', '105'],
        ),
      },
    },
    null,
    2,
  ) + '\n',
);
