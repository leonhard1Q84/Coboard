import { describe, expect, it } from 'vitest';
import type { ConnectorNode, Document } from '../../ipc/types';
import { EMPTY_DOCUMENT, optimisticDocument } from '../../stores/document';
import {
  connectorMidpoint,
  connectorPolyline,
  findNearestSnapTarget,
  getAnchorPoint,
  getConnectableAnchors,
  resolveConnectorEndpoints,
} from './connectors';

function makeDiagramDoc(): Document {
  return optimisticDocument(EMPTY_DOCUMENT, [
    {
      type: 'edit',
      operations: [
        { type: 'insert', node: ['shape', { id: 'r1', kind: 'rectangle', position: { x: 100, y: 100 }, end: { x: 100, y: 60 }, width: 2, color: '#1f2329' }] },
        { type: 'insert', node: ['shape', { id: 'e1', kind: 'ellipse', position: { x: 340, y: 100 }, end: { x: 80, y: 60 }, width: 2, color: '#1f2329' }] },
        { type: 'insert', node: ['paragraph', { id: 'p1', position: { x: 100, y: 260 } }, ['text', 'Node text']] },
      ],
    },
  ]);
}

describe('connector anchors and routing', () => {
  it('computes cardinal anchors and perimeter intersections including ellipses and rotated shapes', () => {
    const doc = makeDiagramDoc();
    const r1 = doc.nodes.r1;
    const anchors = getConnectableAnchors(r1);
    expect(anchors.find((a) => a.anchor === 'right')?.point.x).toBeCloseTo(201, 2);

    const rotRect: typeof r1 = ['shape', { ...r1[1], rotation: Math.PI / 2 } as Extract<typeof r1, ['shape', ...unknown[]]>[1]];
    const rotTop = getConnectableAnchors(rotRect).find((a) => a.anchor === 'top')!.point;
    // Rotating top cardinal point by +90 deg puts it to the right of center (150, 130)
    expect(rotTop.x).toBeCloseTo(180, 1);
    expect(rotTop.y).toBeCloseTo(130, 1);

    const e1 = doc.nodes.e1;
    const autoRight = getAnchorPoint(e1, 'auto', { x: 500, y: 130 });
    expect(autoRight.x).toBeGreaterThan(415);
    expect(autoRight.y).toBeCloseTo(130, 1);

    const p1 = doc.nodes.p1;
    const domRects = new Map([['p1', { x: 100, y: 260, w: 90, h: 32 }]]);
    expect(getAnchorPoint(p1, 'bottom', { x: 0, y: 0 }, domRects)).toEqual({ x: 145, y: 292 });
  });

  it('snaps near explicit cardinal anchors before falling back to perimeter auto-anchor', () => {
    const doc = makeDiagramDoc();
    const nearRight = findNearestSnapTarget(doc, { x: 204, y: 131 });
    expect(nearRight?.nodeId).toBe('r1');
    expect(nearRight?.anchor).toBe('right');

    const insideBody = findNearestSnapTarget(doc, { x: 130, y: 120 });
    expect(insideBody?.nodeId).toBe('r1');
    expect(insideBody?.anchor).toBe('auto');
  });

  it('routes straight, elbow, and curve connectors and updates endpoints smoothly during node drag', () => {
    let doc = makeDiagramDoc();
    const cElbow: ConnectorNode = [
      'connector',
      {
        id: 'c1',
        position: { x: 200, y: 130 },
        from: 'r1',
        to: 'e1',
        from_anchor: 'right',
        to_anchor: 'left',
        route: 'elbow',
        start_head: 'none',
        end_head: 'arrow',
      },
    ];
    doc = optimisticDocument(doc, [{ type: 'edit', operations: [{ type: 'insert', node: cElbow }] }]);

    const poly = connectorPolyline(doc, cElbow);
    expect(poly.length).toBeGreaterThanOrEqual(4);
    expect(poly[0].x).toBeCloseTo(201, 2);
    expect(poly[poly.length - 1].x).toBeCloseTo(339, 2);

    const shifted = resolveConnectorEndpoints(doc, cElbow, undefined, { ids: new Set(['e1']), dx: 50, dy: 40 });
    expect(shifted?.end.x).toBeCloseTo(389, 2);
    expect(shifted?.end.y).toBeCloseTo(170, 2);

    const cCurve: ConnectorNode = ['connector', { ...cElbow[1], id: 'c2', route: 'curve', waypoints: [{ x: 270, y: 80 }] }];
    const curvePts = connectorPolyline(doc, cCurve);
    expect(curvePts.length).toBe(25);
    const mid = connectorMidpoint(curvePts);
    expect(mid.y).toBeLessThan(120);
  });

  it('supports free canvas endpoints and shifts free points/waypoints when dragged', () => {
    const conn: ConnectorNode = [
      'connector',
      {
        id: 'c_free',
        position: { x: 10, y: 20 },
        from_point: { x: 10, y: 20 },
        to_point: { x: 110, y: 20 },
        waypoints: [{ x: 60, y: 50 }],
        route: 'straight',
      },
    ];
    const resolved = resolveConnectorEndpoints(EMPTY_DOCUMENT, conn, undefined, { ids: new Set(['c_free']), dx: 15, dy: -5 });
    expect(resolved?.start).toEqual({ x: 25, y: 15 });
    expect(resolved?.end).toEqual({ x: 125, y: 15 });
    expect(resolved?.waypoints).toEqual([{ x: 75, y: 45 }]);
  });
});
