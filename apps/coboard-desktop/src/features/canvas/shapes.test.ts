import { describe, expect, it } from 'vitest';
import type { InkPoint } from '../../ipc/types';
import { makeShape, normalizeStroke, recognizeShape } from './shapes';
const points = (xy: number[][]): InkPoint[] => xy.map(([x, y], i) => ({ x, y, pressure: 0.5, elapsed_ms: i * 20 }));

describe('shape tools', () => {
  it('normalizes backwards rectangle drags and keeps arrow endpoints absolute', () => {
    expect(makeShape('rectangle', { x: 100, y: 80 }, { x: 20, y: 10 }, '#000000', 4, 'box')[1]).toMatchObject({ position: { x: 20, y: 10 }, end: { x: 80, y: 70 } });
    expect(makeShape('arrow', { x: 100, y: 80 }, { x: 20, y: 10 }, '#000000', 4, 'arrow')[1]).toMatchObject({ position: { x: 100, y: 80 }, end: { x: 20, y: 10 } });
  });
  it('recognizes noisy lines, closed boxes and ellipses without interpreting open writing as a box', () => {
    expect(recognizeShape(points([[0, 0], [30, 1], [60, -1], [100, 0]]), '#000000', 4)?.[1].kind).toBe('line');
    const box = points([[0, 0], [50, 1], [100, 0], [99, 40], [100, 80], [50, 79], [0, 80], [1, 40], [0, 0]]);
    expect(recognizeShape(box, '#000000', 4)?.[1].kind).toBe('rectangle');
    const ellipse = points(Array.from({ length: 65 }, (_, i) => [80 + 80 * Math.cos(i * Math.PI / 32), 40 + 40 * Math.sin(i * Math.PI / 32)]));
    expect(recognizeShape(ellipse, '#000000', 4)?.[1].kind).toBe('ellipse');
    expect(recognizeShape(points([[0, 0], [0, 80], [60, 80], [60, 0]]), '#000000', 4)).toBeNull();
    expect(recognizeShape(points([[0, 0], [20, 40], [40, 0], [60, 40], [80, 0]]), '#000000', 4)).toBeNull();
  });
  it('preserves object identity and offsets when converting existing ink', () => {
    const fitted = normalizeStroke(['stroke', { id: 'ink', position: { x: 200, y: -100 }, points: points([[0, 0], [30, 1], [60, -1], [100, 0]]), color: '#e5484d', width: 8 }]);
    expect(fitted?.[1]).toMatchObject({ id: 'ink', position: { x: 200, y: -100 }, end: { x: 300, y: -100 }, width: 8, color: '#e5484d' });
  });
});
