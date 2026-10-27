// Complete words avoid treating past actions ("добавил") or other people's actions
// ("добавит") as a new instruction from the owner.
const action = [
  'занес(?:у|и|ти|ем)',
  'заношу',
  'заноси(?:ть)?',
  'внес(?:у|и|ти|ем)',
  'вношу',
  'вноси(?:ть)?',
  'добав(?:лю|ь|ить|им)',
  'добавляю',
  'добавляй',
  'запиш(?:у|и|ем)',
  'записать',
  'записываю',
  'впиш(?:у|и|ем)',
  'вписать',
  'вписываю',
  'постав(?:лю|ь|ить|им)',
  'ставлю',
  'отмеч(?:у|ай)',
  'отмет(?:ь|ить|им)',
  'отмечаю',
  'помеч(?:у|ай)',
  'помет(?:ь|ить|им)',
  'помечаю',
  'сохран(?:ю|и|ить|им)',
  'сохраняю',
  'закин(?:у|ь|уть|ем)',
  'закидываю',
  'забь(?:ю|ем)',
  'забей',
  'забить',
  'забиваю',
  'вобь(?:ю|ем)',
  'вбей',
  'вбить',
  'вбиваю',
  'запланир(?:ую|уй|овать|уем)',
  'зафиксир(?:ую|уй|овать|уем)',
  'черкну',
  'черкани',
  'черкнуть',
  'черкану',
].join('|');
const actionWord = `(?<!\\p{L})(?:${action})(?!\\p{L})`;
const actionPattern = new RegExp(actionWord, 'iu');
const negatedAction = new RegExp(`(?<!\\p{L})(?:не|ни)(?:\\s+\\p{L}+){0,3}\\s+${actionWord}`, 'iu');

/** Permission guard: aliases permit extraction, never invent an event or its date. */
export function hasCalendarCommitment(raw: string): boolean {
  const text = raw
    .toLocaleLowerCase()
    .replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, '')
    .replace(/ё/gu, 'е')
    .replace(/не\s+забуду/gu, 'обязательно');
  if (/(?<!\p{L})не\s+(?:смогу|приду|пойду|буду|получится|участв|посещ|присутств)/iu.test(text))
    return false;
  if (negatedAction.test(text) || /(?:забью|забей|забить)\s+на\s/iu.test(text)) return false;
  if (!actionPattern.test(text)) return false;
  if (/календар|расписан|напоминан|напоминал/iu.test(text)) return true;
  // Without a calendar word, keep unrelated notes/tasks out of this feature.
  if (
    /задач|заметк|записк|телефон|номер|адрес|ссылк|фото|картинк|файл|контакт|рецепт|парол|логин|список|покупк|цитат|мысл|идею/iu.test(
      text,
    )
  )
    return false;
  const selfNote = /(?<!\p{L})(?:себе|у\s+себя|к\s+себе)(?!\p{L})/iu.test(text);
  if (
    selfNote &&
    /(?<!\p{L})(?:впишу|вписываю|запишу|записываю|отмечу|помечу|зафиксирую|занесу|внесу|черкну|черкану)(?!\p{L})/iu.test(
      text,
    )
  )
    return true;
  const booking =
    /(?<!\p{L})(?:запланирую|запланируем|забью|забьем|вобью|вобьем|зафиксирую|зафиксируем)(?!\p{L})/iu.test(
      text,
    );
  return booking && /встреч|созвон|событи|слот|дату|время/iu.test(text);
}
