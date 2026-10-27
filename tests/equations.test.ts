import { describe, it, expect } from 'vitest';
import { solveMath } from '../src/services/math.js';

describe('Линейные уравнения', () => {
  it.each([
    ['x+10=2x', 'x = 10'],
    ['2x+3=7', 'x = 2'],
    ['3(x-2)=12', 'x = 6'],
    ['(x+1)/2=3', 'x = 5'],
    ['5-x=9', 'x = -4'],
    ['-x=3', 'x = -3'],
    ['x/3=2', 'x = 6'],
    ['3x=1', 'x ≈ 0.33'],
    ['8x=1', 'x = 0.125'],
    ['128x=1', 'x ≈ 0.00781'],
    ['0,5x+1=3', 'x = 4'],
    ['2*x+3=x-7', 'x = -10'],
    ['Реши уравнение: x+10=2x?', 'x = 10'],
    ['Х + 10 = 2Х', 'x = 10'],
    ['y+10=2y', 'y = 10'],
    ['2z=0', 'z = 0'],
    ['x=x', 'Бесконечно много решений.'],
    ['2(x+1)=2x+2', 'Бесконечно много решений.'],
    ['x+1=x+2', 'Решений нет.'],
  ])('%s → %s', (input, answer) =>
    expect(solveMath(input)).toEqual({ kind: 'answer', text: answer }),
  );
  it.each([
    'x*x=4',
    'x^2=4',
    '1/x=2',
    'x+y=2',
    'x+=2',
    'x=',
    '(x+1=3',
    'x/0=1',
    'x=2=3',
    '1..2x=3',
  ])('не выдаёт неверное решение для %s', (input) => expect(solveMath(input).kind).toBe('error'));
  it.each(['Привет, x=10 это ответ?', '<script>x=1</script>', 'process.exit()=x', '2+2=4'])(
    'игнорирует текст: %s',
    (input) => expect(solveMath(input).kind).toBe('ignore'),
  );
});
