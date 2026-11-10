import { describe, expect, it } from 'vitest';
import type { InkPoint, ShapeNode, StrokeNode } from '../../ipc/types';
import {
  adjustSnappedShape,
  makeShape,
  mergeRecentStrokesToShape,
  normalizeStroke,
  recognizeShape,
  shapeCenter,
} from './shapes';

const points = (xy: number[][]): InkPoint[] => xy.map(([x, y], i) => ({ x, y, pressure: 0.5, elapsed_ms: i * 20 }));

function sampleSegment(ax: number, ay: number, bx: number, by: number, n = 10): number[][] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / n;
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
  });
}

describe('shape tools', () => {
  it('normalizes backwards rectangle drags and keeps arrow endpoints absolute', () => {
    expect(makeShape('rectangle', { x: 100, y: 80 }, { x: 20, y: 10 }, '#000000', 4, 'box')[1]).toMatchObject({ position: { x: 20, y: 10 }, end: { x: 80, y: 70 } });
    expect(makeShape('arrow', { x: 100, y: 80 }, { x: 20, y: 10 }, '#000000', 4, 'arrow')[1]).toMatchObject({ position: { x: 100, y: 80 }, end: { x: 20, y: 10 } });
  });

  it('recognizes noisy lines, closed boxes, near-squares, diamonds, circles, and rejects open writing', () => {
    expect(recognizeShape(points([[0, 0], [30, 1], [60, -1], [100, 0]]), '#000000', 4)?.[1].kind).toBe('line');

    const box = points([[0, 0], [50, 1], [100, 0], [99, 40], [100, 80], [50, 79], [0, 80], [1, 40], [0, 0]]);
    expect(recognizeShape(box, '#000000', 4)?.[1].kind).toBe('rectangle');

    const nearSquare = points([
      ...sampleSegment(0, 0, 100, 0),
      ...sampleSegment(100, 0, 100, 94),
      ...sampleSegment(100, 94, 0, 94),
      ...sampleSegment(0, 94, 0, 0),
      [0, 0],
    ]);
    const sq = recognizeShape(nearSquare, '#000000', 4);
    expect(sq?.[1].kind).toBe('rectangle');
    expect(sq?.[1].end.x).toBe(sq?.[1].end.y);

    const ellipse = points(Array.from({ length: 65 }, (_, i) => [80 + 80 * Math.cos(i * Math.PI / 32), 40 + 40 * Math.sin(i * Math.PI / 32)]));
    expect(recognizeShape(ellipse, '#000000', 4)?.[1].kind).toBe('ellipse');

    const nearCircle = points(Array.from({ length: 65 }, (_, i) => [100 + 50 * Math.cos(i * Math.PI / 32), 100 + 47 * Math.sin(i * Math.PI / 32)]));
    const cir = recognizeShape(nearCircle, '#000000', 4);
    expect(cir?.[1].kind).toBe('ellipse');
    expect(cir?.[1].end.x).toBe(cir?.[1].end.y);

    const diamond = points([
      ...sampleSegment(100, 0, 180, 60),
      ...sampleSegment(180, 60, 100, 120),
      ...sampleSegment(100, 120, 20, 60),
      ...sampleSegment(20, 60, 100, 0),
      [100, 0],
    ]);
    expect(recognizeShape(diamond, '#000000', 4)?.[1].kind).toBe('diamond');

    // Open writing / incomplete box / sharp M
    expect(recognizeShape(points([[0, 0], [0, 80], [60, 80], [60, 0]]), '#000000', 4)).toBeNull();
    expect(recognizeShape(points([[0, 0], [20, 40], [40, 0], [60, 40], [80, 0]]), '#000000', 4)).toBeNull();
  });

  it('recognizes slightly-open tilted triangles while preserving fitted vertices, waves, curves, and arrows', () => {
    // Open-apex skewed triangle matching hand-drawn presentation gesture
    const openTiltedTriangle = points([
      ...sampleSegment(100, 25, 220, 140, 14),
      ...sampleSegment(220, 140, 10, 130, 16),
      ...sampleSegment(10, 130, 88, 36, 12),
    ]);
    const tri = recognizeShape(openTiltedTriangle, '#1f2329', 4, 't1', { fill: '#1f2329' });
    expect(tri?.[1].kind).toBe('triangle');
    expect(tri?.[1].points).toHaveLength(3);
    expect(tri?.[1].fill).toBe('#1f2329');

    // Single-stroke arrow
    const arrow = points([
      ...sampleSegment(0, 50, 120, 50, 14),
      ...sampleSegment(120, 50, 104, 38, 5),
      [120, 50],
      ...sampleSegment(120, 50, 104, 62, 5),
    ]);
    expect(recognizeShape(arrow, '#1f2329', 4)?.[1].kind).toBe('arrow');

    // Sine wave
    const wave = points(
      Array.from({ length: 61 }, (_, i) => {
        const t = i / 60;
        return [t * 180, 18 * Math.sin(Math.PI * 2 * 1.5 * t)];
      }),
    );
    const fittedWave = recognizeShape(wave, '#2f6fed', 4);
    expect(fittedWave?.[1].kind).toBe('wave');
    expect(fittedWave?.[1].points?.length).toBe(1);

    // Smooth single arc
    const curve = points(
      Array.from({ length: 25 }, (_, i) => {
        const t = i / 24;
        const mt = 1 - t;
        return [
          mt * mt * 0 + 2 * mt * t * 70 + t * t * 140,
          mt * mt * 80 + 2 * mt * t * 10 + t * t * 80,
        ];
      }),
    );
    const fittedCurve = recognizeShape(curve, '#2f6fed', 4);
    expect(fittedCurve?.[1].kind).toBe('curve');
    expect(fittedCurve?.[1].points?.length).toBe(1);
  });

  it('supports Goodnotes Hold-and-Adjust scaling & rotation before pen-up', () => {
    const base: ShapeNode = [
      'shape',
      {
        id: 'rect1',
        kind: 'rectangle',
        position: { x: 100, y: 100 },
        end: { x: 80, y: 60 },
        color: '#1f2329',
        width: 4,
      },
    ];
    const center = shapeCenter(base);
    const adjusted = adjustSnappedShape(base, center, { x: center.x + 40, y: center.y }, { x: center.x, y: center.y + 80 });
    expect(adjusted[1].end.x).toBeGreaterThan(base[1].end.x);
    expect(Math.abs(adjusted[1].rotation ?? 0)).toBeGreaterThan(1.0);
  });

  it('merges consecutive strokes into arrows, triangles, and rectangles without extra confirmation', () => {
    const sLine: ShapeNode = ['shape', { id: 'l1', kind: 'line', position: { x: 0, y: 50 }, end: { x: 120, y: 50 }, color: '#1f2329', width: 4 }];
    const sBarb: StrokeNode = ['stroke', { id: 'b1', position: { x: 105, y: 38 }, points: points([[0, 0], [15, 12], [0, 24]]), color: '#1f2329', width: 4 }];
    const mergedArrow = mergeRecentStrokesToShape([sLine], sBarb);
    expect(mergedArrow?.shape[1].kind).toBe('arrow');
    expect(mergedArrow?.replacedIds).toEqual(['l1', 'b1']);

    const t1: ShapeNode = ['shape', { id: 'e1', kind: 'line', position: { x: 50, y: 0 }, end: { x: 100, y: 90 }, color: '#1f2329', width: 4 }];
    const t2: ShapeNode = ['shape', { id: 'e2', kind: 'line', position: { x: 100, y: 90 }, end: { x: 0, y: 90 }, color: '#1f2329', width: 4 }];
    const t3: ShapeNode = ['shape', { id: 'e3', kind: 'line', position: { x: 0, y: 90 }, end: { x: 50, y: 0 }, color: '#1f2329', width: 4 }];
    const mergedTri = mergeRecentStrokesToShape([t1, t2], t3, { fill: '#1f2329' });
    expect(mergedTri?.shape[1].kind).toBe('triangle');
    expect(mergedTri?.shape[1].fill).toBe('#1f2329');
    expect(mergedTri?.replacedIds).toEqual(['e1', 'e2', 'e3']);

    const r1: ShapeNode = ['shape', { id: 'r1', kind: 'line', position: { x: 0, y: 0 }, end: { x: 100, y: 0 }, color: '#1f2329', width: 4 }];
    const r2: ShapeNode = ['shape', { id: 'r2', kind: 'line', position: { x: 100, y: 0 }, end: { x: 100, y: 70 }, color: '#1f2329', width: 4 }];
    const r3: ShapeNode = ['shape', { id: 'r3', kind: 'line', position: { x: 100, y: 70 }, end: { x: 0, y: 70 }, color: '#1f2329', width: 4 }];
    const r4: ShapeNode = ['shape', { id: 'r4', kind: 'line', position: { x: 0, y: 70 }, end: { x: 0, y: 0 }, color: '#1f2329', width: 4 }];
    const mergedRect = mergeRecentStrokesToShape([r1, r2, r3], r4);
    expect(mergedRect?.shape[1].kind).toBe('rectangle');
    expect(mergedRect?.replacedIds).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('preserves object identity, offsets, and group_ids when converting existing ink', () => {
    const fitted = normalizeStroke(['stroke', { id: 'ink', position: { x: 200, y: -100 }, points: points([[0, 0], [30, 1], [60, -1], [100, 0]]), color: '#e5484d', width: 8, group_ids: ['g1'] }]);
    expect(fitted?.[1]).toMatchObject({ id: 'ink', position: { x: 200, y: -100 }, end: { x: 300, y: -100 }, width: 8, color: '#e5484d', group_ids: ['g1'] });
  });
});
