import type { Document, Point, SceneNode } from '../../ipc/types';
import { connectorPolyline } from './connectors';
import { shapeVerticesWorld } from './shapes';

export type Rect = { x: number; y: number; w: number; h: number };

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

export function expandRect(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function polygonBounds(poly: readonly Point[]): Rect | null {
  if (!poly.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function pointInPolygon(p: Point, poly: readonly Point[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = (yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6
    && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6;
}

export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)
    || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) {
    return false;
  }
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (Math.abs(o1) <= 1e-6 && onSegment(a, b, c)) return true;
  if (Math.abs(o2) <= 1e-6 && onSegment(a, b, d)) return true;
  if (Math.abs(o3) <= 1e-6 && onSegment(c, d, a)) return true;
  if (Math.abs(o4) <= 1e-6 && onSegment(c, d, b)) return true;
  return false;
}

function rectEdges(r: Rect): [Point, Point][] {
  const tl = { x: r.x, y: r.y };
  const tr = { x: r.x + r.w, y: r.y };
  const br = { x: r.x + r.w, y: r.y + r.h };
  const bl = { x: r.x, y: r.y + r.h };
  return [[tl, tr], [tr, br], [br, bl], [bl, tl]];
}

export function rectIntersectsPolygon(r: Rect, poly: readonly Point[]): boolean {
  const pb = polygonBounds(poly);
  if (!pb || poly.length < 3 || !rectIntersects(r, pb)) return false;
  const corners: Point[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  if (corners.some((c) => pointInPolygon(c, poly))) return true;
  if (poly.some((p) => pointInRect(p, r))) return true;
  const edges = rectEdges(r);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (edges.some(([c, d]) => segmentsIntersect(a, b, c, d))) return true;
  }
  return false;
}

export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 <= 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Canvas-drawn nodes (strokes, shapes, connectors). Text, formula, card and image nodes are DOM and hit-tested by the browser. */
export function isInk(node: SceneNode): node is Extract<SceneNode, ['stroke' | 'shape' | 'connector', ...unknown[]]> {
  return node[0] === 'stroke' || node[0] === 'shape' || node[0] === 'connector';
}

function inkPolyline(
  node: SceneNode,
  doc?: Document,
  domRects?: ReadonlyMap<string, Rect>,
): { pts: Point[]; width: number; fillHit?: boolean } | null {
  if (node[0] === 'stroke') {
    const { position, points, width } = node[1];
    return { pts: points.map((q) => ({ x: q.x + position.x, y: q.y + position.y })), width };
  }
  if (node[0] === 'shape') {
    const pts = shapeVerticesWorld(node);
    const fillHit = !!node[1].fill || !!node[1].text;
    return { pts, width: node[1].width, fillHit };
  }
  if (node[0] === 'connector' && doc) {
    const pts = connectorPolyline(doc, node, domRects);
    if (!pts.length) return null;
    return { pts, width: node[1].width ?? 2 };
  }
  return null;
}

/** True if p lies within `tolerance` (world units) of the visible ink / connector / filled interior. */
export function hitInk(
  node: SceneNode,
  p: Point,
  tolerance: number,
  doc?: Document,
  domRects?: ReadonlyMap<string, Rect>,
): boolean {
  const line = inkPolyline(node, doc, domRects);
  if (!line || !line.pts.length) return false;
  const r = tolerance + line.width / 2;
  if (line.pts.length === 1) return Math.hypot(p.x - line.pts[0].x, p.y - line.pts[0].y) <= r;
  for (let i = 1; i < line.pts.length; i++) if (segmentDistance(p, line.pts[i - 1], line.pts[i]) <= r) return true;
  if (line.fillHit && line.pts.length >= 4 && pointInPolygon(p, line.pts)) return true;
  return false;
}

/** True if the eraser segment a->b touches the ink or connector. */
export function hitInkSegment(
  node: SceneNode,
  a: Point,
  b: Point,
  radius: number,
  doc?: Document,
  domRects?: ReadonlyMap<string, Rect>,
): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(radius, 1)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (hitInk(node, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, radius, doc, domRects)) return true;
  }
  return false;
}

export function inkBounds(
  node: SceneNode,
  doc?: Document,
  domRects?: ReadonlyMap<string, Rect>,
): Rect | null {
  const line = inkPolyline(node, doc, domRects);
  if (!line || !line.pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of line.pts) {
    minX = Math.min(minX, q.x);
    minY = Math.min(minY, q.y);
    maxX = Math.max(maxX, q.x);
    maxY = Math.max(maxY, q.y);
  }
  const pad = line.width / 2;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

export function nodeHitsMarquee(
  node: SceneNode,
  marquee: Rect,
  domBounds?: Rect | null,
  doc?: Document,
  domRects?: ReadonlyMap<string, Rect>,
): boolean {
  if (!isInk(node)) return !!domBounds && rectIntersects(domBounds, marquee);
  const bounds = inkBounds(node, doc, domRects);
  if (!bounds || !rectIntersects(bounds, marquee)) return false;
  const line = inkPolyline(node, doc, domRects);
  if (!line) return false;
  if (line.pts.some((p) => pointInRect(p, marquee))) return true;
  const edges = rectEdges(marquee);
  for (let i = 1; i < line.pts.length; i++) {
    const a = line.pts[i - 1], b = line.pts[i];
    if (edges.some(([c, d]) => segmentsIntersect(a, b, c, d))) return true;
  }
  return false;
}

export function nodeHitsLasso(
  node: SceneNode,
  poly: readonly Point[],
  polyBounds: Rect,
  domBounds?: Rect | null,
  doc?: Document,
  domRects?: ReadonlyMap<string, Rect>,
): boolean {
  if (poly.length < 3) return false;
  if (!isInk(node)) return !!domBounds && rectIntersectsPolygon(domBounds, poly);
  const bounds = inkBounds(node, doc, domRects);
  if (!bounds || !rectIntersects(bounds, polyBounds)) return false;
  const line = inkPolyline(node, doc, domRects);
  if (!line) return false;
  if (line.pts.some((p) => pointInPolygon(p, poly))) return true;
  for (let i = 1; i < line.pts.length; i++) {
    const a = line.pts[i - 1], b = line.pts[i];
    for (let j = 0; j < poly.length; j++) {
      if (segmentsIntersect(a, b, poly[j], poly[(j + 1) % poly.length])) return true;
    }
  }
  return false;
}
