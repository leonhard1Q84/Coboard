import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../../ipc/types';
import { EMPTY_DOCUMENT, optimisticDocument } from '../../stores/document';
import { hitInk, inkBounds, nodeHitsLasso, nodeHitsMarquee, pointInPolygon, rectIntersectsPolygon } from './geometry';

const stroke = (id: string, pts: [number, number][]): SceneNode => [
  'stroke',
  {
    id,
    position: { x: 0, y: 0 },
    points: pts.map(([x, y], i) => ({ x, y, pressure: 0.5, elapsed_ms: i * 10 })),
    width: 4,
    color: '#1f2329',
  },
];

describe('lasso and marquee geometry', () => {
  it('detects point-in-polygon and rect intersection with lasso polygon', () => {
    const triangle = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }];
    expect(pointInPolygon({ x: 50, y: 40 }, triangle)).toBe(true);
    expect(pointInPolygon({ x: 10, y: 90 }, triangle)).toBe(false);
    expect(rectIntersectsPolygon({ x: 40, y: 20, w: 20, h: 20 }, triangle)).toBe(true);
    expect(rectIntersectsPolygon({ x: 110, y: 10, w: 20, h: 20 }, triangle)).toBe(false);
  });

  it('hits strokes whose segments cross the lasso even when endpoints are outside', () => {
    const lasso = [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }];
    const bounds = { x: 20, y: 20, w: 60, h: 60 };
    const crossing = stroke('s1', [[0, 50], [100, 50]]);
    const outside = stroke('s2', [[0, 10], [100, 10]]);
    expect(nodeHitsLasso(crossing, lasso, bounds)).toBe(true);
    expect(nodeHitsLasso(outside, lasso, bounds)).toBe(false);
  });

  it('hits shapes and DOM rects in marquee and lasso', () => {
    const line: SceneNode = ['shape', { id: 'l1', kind: 'line', position: { x: 0, y: 0 }, end: { x: 100, y: 100 }, width: 2, color: '#1f2329' }];
    expect(nodeHitsMarquee(line, { x: 40, y: 40, w: 20, h: 20 })).toBe(true);
    expect(nodeHitsMarquee(line, { x: 80, y: 0, w: 15, h: 15 })).toBe(false);
    const para: SceneNode = ['paragraph', { id: 'p1', position: { x: 30, y: 30 } }, ['text', 'hello']];
    expect(nodeHitsLasso(para, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }], { x: 0, y: 0, w: 50, h: 50 }, { x: 30, y: 30, w: 40, h: 20 })).toBe(true);
    const diamond: SceneNode = ['shape', { id: 'd1', kind: 'diamond', position: { x: 10, y: 10 }, end: { x: 80, y: 80 }, width: 2, color: '#1f2329' }];
    expect(nodeHitsMarquee(diamond, { x: 45, y: 5, w: 10, h: 15 })).toBe(true);
    expect(nodeHitsMarquee(diamond, { x: 11, y: 11, w: 8, h: 8 })).toBe(false);
  });

  it('hits filled shapes inside body, custom triangle vertices, waves, and connectors in doc context', () => {
    const filledBox: SceneNode = ['shape', { id: 'fb', kind: 'rectangle', position: { x: 0, y: 0 }, end: { x: 100, y: 60 }, width: 2, color: '#1f2329', fill: '#1f2329' }];
    expect(hitInk(filledBox, { x: 50, y: 30 }, 4)).toBe(true);

    const tri: SceneNode = [
      'shape',
      {
        id: 'tri',
        kind: 'triangle',
        position: { x: 10, y: 10 },
        end: { x: 80, y: 80 },
        width: 2,
        color: '#1f2329',
        points: [{ x: 40, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }],
      },
    ];
    expect(hitInk(tri, { x: 30, y: 50 }, 5)).toBe(true);

    const wave: SceneNode = [
      'shape',
      { id: 'w1', kind: 'wave', position: { x: 0, y: 100 }, end: { x: 160, y: 100 }, points: [{ x: 1.5, y: 20 }], width: 3, color: '#1f2329' },
    ];
    expect(hitInk(wave, { x: 80, y: 80 }, 6)).toBe(true);
    expect(inkBounds(wave)?.h).toBeGreaterThan(35);

    const doc = optimisticDocument(EMPTY_DOCUMENT, [
      {
        type: 'edit',
        operations: [
          { type: 'insert', node: ['shape', { id: 's1', kind: 'rectangle', position: { x: 0, y: 0 }, end: { x: 40, y: 40 }, width: 2, color: '#1f2329' }] },
          { type: 'insert', node: ['shape', { id: 's2', kind: 'rectangle', position: { x: 200, y: 0 }, end: { x: 40, y: 40 }, width: 2, color: '#1f2329' }] },
          { type: 'insert', node: ['connector', { id: 'c1', position: { x: 40, y: 20 }, from: 's1', to: 's2', from_anchor: 'right', to_anchor: 'left', route: 'straight' }] },
        ],
      },
    ]);
    const conn = doc.nodes.c1;
    expect(hitInk(conn, { x: 120, y: 20 }, 5, doc)).toBe(true);
    expect(nodeHitsMarquee(conn, { x: 100, y: 10, w: 40, h: 20 }, null, doc)).toBe(true);
    expect(nodeHitsLasso(conn, [{ x: 110, y: 0 }, { x: 130, y: 0 }, { x: 130, y: 40 }, { x: 110, y: 40 }], { x: 110, y: 0, w: 20, h: 40 }, null, doc)).toBe(true);
  });
});
