export function taskIntent(raw: string, hasReply = false): 'create' | 'complete' | null {
  const text = raw
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, '');
  if (
    /(?<!\p{L})не\s+(?:добав|запис|запиш|закин|постав|созда|закр|внес|сдела|готов)/iu.test(text) ||
    /не\s+хочу|не\s+буду|не\s+надо/iu.test(text)
  )
    return null;
  const topic = /задач|таск|туду|todo/iu.test(text);
  if (
    topic &&
    /добавлю|добавь|добавить|закину|закинь|занесу|занеси|внесу|внеси|запишу|запиши|поставлю|поставь|поставить|создай|создам|сделаю|сделай|оформлю|оформи|заведу|заведи/iu.test(
      text,
    )
  )
    return 'create';
  if (
    topic &&
    /закрой|закрывай|закрыть|закрою|заверши|завершил|выполнена|сделана|готова/iu.test(text)
  )
    return 'complete';
  if (/сделал[аи]?[\s,]+(?:можно\s+)?закрыва|можно\s+закрывать/iu.test(text)) return 'complete';
  if (
    hasReply &&
    /^(?:все[,\s]+)?(?:сделал|сделала|готово|выполнил|выполнила)[.!\s]*$/iu.test(text)
  )
    return 'complete';
  return null;
}
