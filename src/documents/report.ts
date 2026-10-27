import { z } from 'zod';
const point = z
  .object({
    text: z.string().min(1).max(600),
    source: z.string().min(1).max(60),
    quote: z.string().min(1).max(400),
  })
  .strict();
export const documentReportSchema = z
  .object({
    title: z.string().min(1).max(160),
    facts: z
      .array(
        point.extend({
          category: z.enum(['subject', 'obligations', 'money', 'dates', 'conditions']),
        }),
      )
      .max(15),
    risks: z.array(point).max(5),
    questions: z.array(z.string().min(1).max(400)).max(5),
    limitations: z.array(z.string().min(1).max(400)).max(4),
  })
  .strict();
export const documentReviewSchema = z
  .object({
    focus: z.string().min(1).max(2000),
    comments: z
      .array(
        z
          .object({
            area: z.enum(['idea', 'development', 'design', 'other']),
            basis: z.enum(['text', 'visual', 'proposal']),
            observation: z.string().min(1).max(600),
            suggestion: z.string().min(1).max(600),
            source: z.string().max(60).nullable(),
            quote: z.string().max(400).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    draftReply: z.string().min(1).max(3000),
  })
  .strict();
export const documentResponseSchema = documentReportSchema.extend({
  review: documentReviewSchema.nullable(),
});
export type DocumentReview = z.infer<typeof documentReviewSchema>;
export interface DocumentAnalysisOptions {
  focus: string | null;
  persona: string;
  pdf?: { name: string; bytes: Buffer };
}
export type DocumentReport = z.infer<typeof documentReportSchema> & {
  review?: DocumentReview | null;
  visualPages?: number[];
  visualTotalPages?: number;
};
export interface DocumentAnalyzer {
  analyze(text: string, options?: DocumentAnalysisOptions): Promise<DocumentReport>;
}
const normalize = (s: string) => s.replace(/\s+/gu, ' ').trim();
/** Every claimed source and quotation must exist in the actual extracted section. */
export function validateReport(
  text: string,
  value: DocumentReport,
  visual: boolean | readonly number[] = false,
): DocumentReport {
  const { review, visualPages, visualTotalPages, ...base } = value;
  const report: DocumentReport = documentReportSchema.parse(base);
  if (visualPages)
    report.visualPages = z.array(z.number().int().positive()).max(12).parse(visualPages);
  if (visualTotalPages) report.visualTotalPages = visualTotalPages;
  if (review !== undefined)
    report.review = review === null ? null : documentReviewSchema.parse(review);
  const sections = new Map<string, string>();
  for (const m of text.matchAll(
    /\[(страница \d+|абзац \d+)\]([\s\S]*?)(?=\[(?:страница \d+|абзац \d+)\]|$)/gu,
  ))
    sections.set(m[1]!, normalize(m[2]!));
  for (const p of [...report.facts, ...report.risks]) {
    const section = sections.get(p.source.replace(/^\[|\]$/g, '').trim());
    if (!section || !section.includes(normalize(p.quote)))
      throw new Error('DOCUMENT_UNGROUNDED_REPORT');
  }
  for (const comment of report.review?.comments ?? []) {
    const source = comment.source?.replace(/^\[|\]$/g, '').trim();
    if (
      comment.basis === 'text' &&
      (!source || !comment.quote || !sections.get(source)?.includes(normalize(comment.quote)))
    )
      throw new Error('DOCUMENT_UNGROUNDED_REVIEW');
    if (
      comment.basis === 'visual' &&
      (!visual ||
        !source ||
        !/^страница \d+$/.test(source) ||
        !sections.has(source) ||
        (Array.isArray(visual) && !visual.includes(Number(source.split(' ')[1]))))
    )
      throw new Error('DOCUMENT_UNGROUNDED_REVIEW');
    if (comment.basis === 'proposal' && (comment.quote !== null || comment.source !== null))
      throw new Error('DOCUMENT_UNGROUNDED_REVIEW');
  }
  if (
    !report.facts.length &&
    !(visual && report.review?.comments.some((c) => c.basis === 'visual'))
  )
    throw new Error('DOCUMENT_UNGROUNDED_REPORT');
  return report;
}
export function renderReport(name: string, number: number, report: DocumentReport): string {
  const labels = {
    subject: 'Предмет',
    obligations: 'Обязательства',
    money: 'Суммы и оплата',
    dates: 'Сроки',
    conditions: 'Условия',
  };
  const parts = [`📄 Разбор #${number}: ${name}`, report.title];
  for (const category of Object.keys(labels) as (keyof typeof labels)[]) {
    const rows = report.facts.filter((p) => p.category === category);
    if (rows.length)
      parts.push(
        labels[category] +
          ':\n' +
          rows.map((p) => `• ${p.text}\n  ${p.source}: «${p.quote}»`).join('\n'),
      );
  }
  if (report.risks.length)
    parts.push(
      'На что обратить внимание (выводы помощника):\n' +
        report.risks.map((p) => `• ${p.text}\n  Основание — ${p.source}: «${p.quote}»`).join('\n'),
    );
  if (report.questions.length)
    parts.push('Что уточнить:\n' + report.questions.map((p) => '• ' + p).join('\n'));
  if (report.review) {
    const areas = {
      idea: 'Идея и подача',
      development: 'Как разработчик',
      design: 'Как дизайнер',
      other: 'По запросу',
    };
    parts.push('💬 Комментарии по твоему запросу\n' + report.review.focus);
    parts.push(
      report.review.comments
        .map(
          (p) =>
            `${areas[p.area]}${p.basis === 'proposal' ? ' · предложение' : ''}${p.source ? ' · ' + p.source : ''}\n${p.observation}\nЧто улучшить: ${p.suggestion}${p.quote ? '\nОснование: «' + p.quote + '»' : ''}`,
        )
        .join('\n\n'),
    );
    parts.push('✍️ Черновик ответа собеседнику\n' + report.review.draftReply);
  }
  if (report.limitations.length)
    parts.push('Ограничения анализа:\n' + report.limitations.map((p) => '• ' + p).join('\n'));
  if (/договор|контракт|оферт|соглашени|юридическ/iu.test(report.title))
    parts.push(
      'Выжимка помогает проверить документ и не подтверждает его юридическую безопасность.',
    );
  return parts.join('\n\n');
}
export function splitReport(text: string, max = 3500): string[] {
  const result: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let at = rest.lastIndexOf('\n', max);
    if (at < max / 2) at = max;
    if (/[\uD800-\uDBFF]/u.test(rest[at - 1] ?? '')) at--;
    result.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) result.push(rest);
  return result;
}
