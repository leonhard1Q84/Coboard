import { describe, expect, it } from 'vitest';
import { looksLikeMath, segmentInlineMath, type InlineSegment } from './math';

describe('looksLikeMath', () => {
  it('detects formulas', () => {
    for (const s of ['y=x\\times2', 'E = mc^2', '\\frac{a}{b}', 'x_1 + x_2', '123*23', 'a > b', 'y=3.14']) {
      expect(looksLikeMath(s), s).toBe(true);
    }
  });
  it('keeps prose as text', () => {
    for (const s of ['你好，世界', '面积等于长乘宽', 'todo: fix it', 'hello world', '时间=10点', '公式 y=x', 'http://a.b']) {
      expect(looksLikeMath(s), s).toBe(false);
    }
  });
});

const kinds = (text: string): InlineSegment[] => segmentInlineMath(text).map((s) => ({ kind: s.kind, value: s.value }));

describe('segmentInlineMath', () => {
  it('finds formulas inside CJK prose', () => {
    expect(kinds('请问 y=2x 这种函数')).toEqual([
      { kind: 'text', value: '请问 ' },
      { kind: 'math', value: 'y=2x' },
      { kind: 'text', value: ' 这种函数' },
    ]);
    expect(kinds('请问y=2x这种')).toEqual([
      { kind: 'text', value: '请问' },
      { kind: 'math', value: 'y=2x' },
      { kind: 'text', value: '这种' },
    ]);
  });
  it('finds formulas inside English prose', () => {
    expect(kinds('the formula y=2x works')).toEqual([
      { kind: 'text', value: 'the formula ' },
      { kind: 'math', value: 'y=2x' },
      { kind: 'text', value: ' works' },
    ]);
    expect(kinds('a=1 and b=2')).toEqual([
      { kind: 'math', value: 'a=1' },
      { kind: 'text', value: ' and ' },
      { kind: 'math', value: 'b=2' },
    ]);
    expect(kinds('see \\alpha here')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'math', value: '\\alpha' },
      { kind: 'text', value: ' here' },
    ]);
  });
  it('keeps ambiguous ASCII as text', () => {
    for (const s of ['score = 100', 'todo: fix it', 'call 911 now', 'version 2.0']) {
      expect(segmentInlineMath(s).every((seg) => seg.kind === 'text'), s).toBe(true);
    }
  });
});
