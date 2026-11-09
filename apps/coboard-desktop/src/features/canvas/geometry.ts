import type { Point, SceneNode } from '../../ipc/types';

export type Rect = { x: number; y: number; w: number; h: number };

export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 <= 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Canvas-drawn nodes (strokes and shapes). Text, formula, card and image nodes are DOM and hit-tested by the browser. */
export function isInk(node: SceneNode): node is Extract<SceneNode, ['stroke' | 'shape', ...unknown[]]> {
  return node[0] === 'stroke' || node[0] === 'shape';
}

function shapeOutline(node: Extract<SceneNode, ['shape', ...unknown[]]>): Point[] {
  const { kind, position: p, end } = node[1];
  if (kind === 'line' || kind === 'arrow') return [p, end];
  if (kind === 'rectangle') return [p, { x: p.x + end.x, y: p.y }, { x: p.x + end.x, y: p.y + end.y }, { x: p.x, y: p.y + end.y }, p];
  return Array.from({ length: 33 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return { x: p.x + end.x / 2 + (end.x / 2) * Math.cos(a), y: p.y + end.y / 2 + (end.y / 2) * Math.sin(a) };
  });
}

function inkPolyline(node: SceneNode): { pts: Point[]; width: number } | null {
  if (node[0] === 'stroke') {
    const { position, points, width } = node[1];
    return { pts: points.map((q) => ({ x: q.x + position.x, y: q.y + position.y })), width };
  }
  if (node[0] === 'shape') return { pts: shapeOutline(node), width: node[1].width };
  return null;
}

/** True if p lies within `tolerance` (world units) of the visible ink. */
export function hitInk(node: SceneNode, p: Point, tolerance: number): boolean {
  const line = inkPolyline(node);
  if (!line) return false;
  const r = tolerance + line.width / 2;
  if (line.pts.length === 1) return Math.hypot(p.x - line.pts[0].x, p.y - line.pts[0].y) <= r;
  for (let i = 1; i < line.pts.length; i++) if (segmentDistance(p, line.pts[i - 1], line.pts[i]) <= r) return true;
  return false;
}

/** True if the eraser segment a→b touches the ink. */
export function hitInkSegment(node: SceneNode, a: Point, b: Point, radius: number): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(radius, 1)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (hitInk(node, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, radius)) return true;
  }
  return false;
}

export function inkBounds(node: SceneNode): Rect | null {
  const line = inkPolyline(node);
  if (!line) return null;
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
