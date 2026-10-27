/** Preserve the owner's request verbatim apart from the short analysis trigger. */
export function documentFocus(raw: string): string | null {
  let text = raw.trim().replace(/^\/analyze(?:@\w+)?\s*/iu, '');
  text = text
    .replace(
      /^(?:(?:ок|окей|хорошо|ладно|да|я)[,\s]+)*(?:гляну|глянь|изучу|изучи|изучим|посмотрю|посмотри|почитаю|прочитаю|прочитай|разберу|разбери|чекну|чекни|заценю|зацени|ознакомлюсь|погляжу|погляди)(?!\p{L})[\s,:.!—-]*/iu,
      '',
    )
    .replace(/^и\s+/iu, '')
    .trim();
  if (
    !text ||
    /^(?:(?:этот|этого|эту|это|этой)\s+)?(?:документ|договор|файл|презентацию|презу|контракт|текст)[.!\s]*$/iu.test(
      text,
    )
  )
    return null;
  return text.slice(0, 2000);
}
export function wantsVisualReview(focus: string | null): boolean {
  return (
    !!focus &&
    /стил|дизайн|визуал|верстк|шрифт|цвет|контраст|композиц|слайд|презентац|през[уы]|интерфейс|макет|типограф|design|layout|ux|ui/iu.test(
      focus,
    )
  );
}
