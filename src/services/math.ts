// Bounded arithmetic parser. Input is never evaluated as JavaScript or sent to an LLM.
type Fraction = { n: bigint; d: bigint };
const LIMIT = 4096;
class MathError extends Error {}
function fraction(n: bigint, d = 1n): Fraction {
  if (d === 0n) throw new MathError('Делить на ноль нельзя.');
  if (n.toString().length > LIMIT || d.toString().length > LIMIT)
    throw new MathError('Слишком большое число.');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = n < 0n ? -n : n,
    b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
function add(a: Fraction, b: Fraction): Fraction {
  return fraction(a.n * b.d + b.n * a.d, a.d * b.d);
}
function mul(a: Fraction, b: Fraction): Fraction {
  return fraction(a.n * b.n, a.d * b.d);
}
type Linear = { coefficient: Fraction; constant: Fraction };
const constant = (v: Fraction): Linear => ({ coefficient: fraction(0n), constant: v });
function negate(v: Linear): Linear {
  return {
    coefficient: { ...v.coefficient, n: -v.coefficient.n },
    constant: { ...v.constant, n: -v.constant.n },
  };
}
function linearAdd(a: Linear, b: Linear): Linear {
  return { coefficient: add(a.coefficient, b.coefficient), constant: add(a.constant, b.constant) };
}
function linearMultiply(a: Linear, b: Linear): Linear {
  if (a.coefficient.n && b.coefficient.n)
    throw new MathError('Пока решаю только линейные уравнения: без x² и произведений неизвестных.');
  return {
    coefficient: add(mul(a.coefficient, b.constant), mul(b.coefficient, a.constant)),
    constant: mul(a.constant, b.constant),
  };
}
class LinearParser {
  private i = 0;
  private depth = 0;
  constructor(
    private readonly tokens: string[],
    private readonly variable: string,
  ) {}
  parse(): Linear {
    const result = this.sum();
    if (this.i !== this.tokens.length) throw new MathError('Проверьте запись уравнения и скобки.');
    return result;
  }
  private peek(): string | undefined {
    return this.tokens[this.i];
  }
  private take(): string {
    return this.tokens[this.i++] ?? '';
  }
  private sum(): Linear {
    let result = this.product();
    while (this.peek() === '+' || this.peek() === '-') {
      const operator = this.take(),
        next = this.product();
      result = linearAdd(result, operator === '-' ? negate(next) : next);
    }
    return result;
  }
  private product(): Linear {
    let result = this.unary();
    while (
      this.peek() === '*' ||
      this.peek() === '/' ||
      this.peek() === '(' ||
      this.peek() === this.variable ||
      /^\d/.test(this.peek() ?? '')
    ) {
      const operator = this.peek() === '*' || this.peek() === '/' ? this.take() : '*';
      const next = this.unary();
      if (operator === '/') {
        if (next.coefficient.n)
          throw new MathError('Пока не решаю уравнения с неизвестной в знаменателе.');
        result = linearMultiply(result, constant(fraction(next.constant.d, next.constant.n)));
      } else result = linearMultiply(result, next);
    }
    return result;
  }
  private unary(): Linear {
    if (++this.depth > 32) throw new MathError('Слишком сложное уравнение.');
    try {
      if (this.peek() === '+' || this.peek() === '-') {
        const operator = this.take(),
          value = this.unary();
        return operator === '-' ? negate(value) : value;
      }
      return this.atom();
    } finally {
      this.depth--;
    }
  }
  private atom(): Linear {
    const token = this.take();
    if (token === this.variable) return { coefficient: fraction(1n), constant: fraction(0n) };
    if (token === '(') {
      const result = this.sum();
      if (this.take() !== ')') throw new MathError('Проверьте скобки.');
      return result;
    }
    if (!/^\d+(?:\.\d+)?$/.test(token) || token.length > 100)
      throw new MathError('Проверьте запись уравнения.');
    const [whole, decimal = ''] = token.split('.');
    return constant(fraction(BigInt(whole! + decimal), 10n ** BigInt(decimal.length)));
  }
}
function solveEquation(raw: string): MathResult {
  const text = raw
    .replace(/[?？]\s*$/, '')
    .replace(/[−–—]/g, '-')
    .replace(/[×·]/g, '*')
    .replace(/[÷:]/g, '/')
    .replace(/х/g, 'x')
    .replace(/,/g, '.')
    .trim();
  if (!/^[\dxyz\s.+*/^()=-]+$/.test(text)) return { kind: 'ignore' };
  const variables = new Set(text.match(/[xyz]/g));
  if (variables.size !== 1)
    return { kind: 'error', text: 'Пока решаю уравнения с одной неизвестной: x, y или z.' };
  if (text.includes('^'))
    return { kind: 'error', text: 'Пока решаю линейные уравнения без степеней неизвестной.' };
  if (/\d\s+\d/.test(text)) return { kind: 'error', text: 'Проверьте запись чисел.' };
  const sides = text.split('=');
  if (sides.length !== 2 || !sides[0]?.trim() || !sides[1]?.trim())
    return { kind: 'error', text: 'Укажите обе части уравнения, например x+10=2x.' };
  const tokens = sides.map((side) => side.match(/\d+(?:\.\d+)?|[xyz()+*/.-]/g) ?? []);
  if (tokens[0]!.length + tokens[1]!.length > 128) return { kind: 'ignore' };
  try {
    const variable = [...variables][0]!;
    const left = new LinearParser(tokens[0]!, variable).parse(),
      right = new LinearParser(tokens[1]!, variable).parse();
    const delta = linearAdd(left, negate(right));
    if (!delta.coefficient.n)
      return {
        kind: 'answer',
        text: delta.constant.n ? 'Решений нет.' : 'Бесконечно много решений.',
      };
    const solution = mul(
      fraction(-delta.constant.n, delta.constant.d),
      fraction(delta.coefficient.d, delta.coefficient.n),
    );
    const value = format(solution);
    const text = value.startsWith('≈ ')
      ? `${variable} ≈ ${value.slice(2)}`
      : `${variable} = ${value}`;
    return text.length > 1000
      ? { kind: 'error', text: 'Результат слишком длинный.' }
      : { kind: 'answer', text };
  } catch (error) {
    return {
      kind: 'error',
      text: error instanceof MathError ? error.message : 'Не удалось решить уравнение.',
    };
  }
}
class Parser {
  private i = 0;
  private depth = 0;
  operations = 0;
  constructor(private readonly tokens: string[]) {}
  parse(): Fraction {
    const v = this.sum();
    if (this.i !== this.tokens.length) throw new MathError('Проверьте запись примера.');
    return v;
  }
  private peek(): string | undefined {
    return this.tokens[this.i];
  }
  private take(): string {
    return this.tokens[this.i++] ?? '';
  }
  private sum(): Fraction {
    let a = this.product();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.take();
      this.operations++;
      const b = this.product();
      a = add(a, op === '-' ? { n: -b.n, d: b.d } : b);
    }
    return a;
  }
  private product(): Fraction {
    let a = this.unary();
    while (this.peek() === '*' || this.peek() === '/') {
      const op = this.take();
      this.operations++;
      const b = this.unary();
      a = mul(a, op === '/' ? fraction(b.d, b.n) : b);
    }
    return a;
  }
  private unary(): Fraction {
    if (++this.depth > 32) throw new MathError('Слишком сложный пример.');
    try {
      if (this.peek() === '+' || this.peek() === '-') {
        const sign = this.take();
        const v = this.unary();
        return sign === '-' ? { n: -v.n, d: v.d } : v;
      }
      return this.power();
    } finally {
      this.depth--;
    }
  }
  private power(): Fraction {
    let a = this.atom();
    if (this.peek() === '^') {
      this.take();
      this.operations++;
      const b = this.unary();
      if (b.d !== 1n || b.n > 100n || b.n < -100n)
        throw new MathError('Степень должна быть целым числом от −100 до 100.');
      const p = b.n < 0n ? -b.n : b.n;
      if (Math.max(a.n.toString().length, a.d.toString().length) * Number(p) > LIMIT)
        throw new MathError('Слишком большое число.');
      a = b.n < 0n ? fraction(a.d ** p, a.n ** p) : fraction(a.n ** p, a.d ** p);
    }
    return a;
  }
  private atom(): Fraction {
    let a: Fraction;
    if (this.peek() === '(') {
      this.take();
      a = this.sum();
      if (this.take() !== ')') throw new MathError('Проверьте скобки.');
    } else {
      const token = this.take();
      if (!/^\d+(?:\.\d+)?$/.test(token) || token.length > 100)
        throw new MathError('Проверьте запись числа.');
      const [whole, decimal = ''] = token.split('.');
      a = fraction(BigInt(whole! + decimal), 10n ** BigInt(decimal.length));
    }
    if (this.peek() === '%') {
      this.take();
      this.operations++;
      a = mul(a, fraction(1n, 100n));
    }
    return a;
  }
}
function format(v: Fraction): string {
  if (v.d === 1n) return v.n.toString();
  let rest = v.d;
  while (rest % 2n === 0n) rest /= 2n;
  while (rest % 5n === 0n) rest /= 5n;
  // Reduced denominators containing only 2 and 5 give terminating decimals.
  const places = rest === 1n ? 5 : 2;
  const scale = 10n ** BigInt(places);
  const n = v.n < 0n ? -v.n : v.n;
  const scaled = n * scale;
  const remainder = scaled % v.d;
  let rounded = scaled / v.d;
  if (remainder * 2n >= v.d) rounded++;
  const decimal = (rounded % scale).toString().padStart(places, '0').replace(/0+$/, '');
  const sign = v.n < 0n && rounded !== 0n ? '-' : '';
  return `${remainder !== 0n ? '≈ ' : ''}${sign}${rounded / scale}${decimal ? '.' + decimal : ''}`;
}
export type MathResult = { kind: 'ignore' } | { kind: 'answer' | 'error'; text: string };
export function solveMath(raw: string): MathResult {
  if (raw.length > 500) return { kind: 'ignore' };
  let text = raw.trim().toLowerCase();
  const explicit =
    /^(?:сколько(?:\s+будет)?|посчитай(?:те)?|вычисли(?:те)?|реши(?:те)?(?:\s+(?:пример|уравнение))?|calculate)\s*[:=]?\s*/u;
  const prompted = explicit.test(text);
  text = text.replace(explicit, '').trim();
  if (text.includes('=') && /[xyzх]/u.test(text)) return solveEquation(text);
  // Common dates, times and phone numbers must not become unsolicited arithmetic replies.
  if (
    !prompted &&
    (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text) ||
      /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(text) ||
      /^\d{1,2}:\d{2}$/.test(text) ||
      /^(?:\+7|8)[\s(-]*\d{3}[)\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}$/.test(text))
  )
    return { kind: 'ignore' };
  text = text
    .replace(/[?？]\s*$/, '')
    .replace(/=\s*$/, '')
    .replace(/[−–—]/g, '-')
    .replace(/[×хx·]/g, '*')
    .replace(/[÷:]/g, '/')
    .replace(/,/g, '.')
    .replace(/\*\*/g, '^');
  // A small supported word form: "10% от 250".
  text = text.replace(/^(\d+(?:\.\d+)?)\s*%\s*от\s*(\d+(?:\.\d+)?)$/u, '($1/100)*$2');
  if (!/^[\d\s.+*/^%()-]+$/.test(text) || !/[+*/^%-]/.test(text)) return { kind: 'ignore' };
  // Whitespace cannot silently join two separate numbers ("2 3 + 1").
  if (/\d\s+\d/.test(text))
    return prompted ? { kind: 'error', text: 'Проверьте запись чисел.' } : { kind: 'ignore' };
  const tokens = text.match(/\d+(?:\.\d+)?|[()+*/^%.-]/g) ?? [];
  if (tokens.length > 128) return { kind: 'ignore' };
  try {
    const parser = new Parser(tokens);
    const v = parser.parse();
    if (!parser.operations) return { kind: 'ignore' };
    const answer = format(v);
    if (answer.length > 1000) return { kind: 'error', text: 'Результат слишком длинный.' };
    return { kind: 'answer', text: answer };
  } catch (error) {
    return {
      kind: 'error',
      text: error instanceof MathError ? error.message : 'Не удалось вычислить пример.',
    };
  }
}
