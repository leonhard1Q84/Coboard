import type { InkPoint, Point, ShapeKind, ShapeNode, StrokeNode } from '../../ipc/types';
import { segmentDistance } from './geometry';

export const SHAPE_NAMES: Record<ShapeKind, string> = { line: '直线', arrow: '箭头', rectangle: '矩形', ellipse: '椭圆' };

export function makeShape(kind: ShapeKind, start: Point, finish: Point, color: string, width: number, id: string = crypto.randomUUID()): ShapeNode {
  const box = kind === 'rectangle' || kind === 'ellipse';
  return ['shape', {
    id, kind, color, width,
    position: box ? { x: Math.min(start.x, finish.x), y: Math.min(start.y, finish.y) } : start,
    end: box ? { x: Math.max(1, Math.abs(finish.x - start.x)), y: Math.max(1, Math.abs(finish.y - start.y)) } : finish,
  }];
}

/** Conservative geometric fit. Only explicit user action / hold-to-shape invokes it. */
export function recognizeShape(points: InkPoint[], color: string, width: number, id: string = crypto.randomUUID()): ShapeNode | null {
  if (points.length < 4) return null;
  const first = points[0], last = points[points.length - 1];
  const pathLength = points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
  if (pathLength < 24) return null;
  const distance = Math.hypot(last.x - first.x, last.y - first.y);
  if (distance / pathLength > 0.94 && points.every((p) => segmentDistance(p, first, last) < Math.max(4, distance * 0.045))) {
    return makeShape('line', first, last, color, width, id);
  }
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
  const w = right - x, h = bottom - y;
  const diagonal = Math.hypot(w, h);
  if (w < 18 || h < 18 || distance > diagonal * 0.2 || pathLength > 3 * (w + h) || pathLength < 1.3 * (w + h)) return null;
  const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const rectangleError = points.reduce((sum, p) => sum + Math.min(p.x - x, x + w - p.x, p.y - y, y + h - p.y), 0) / points.length / diagonal;
  const ellipseError = points.reduce((sum, p) => sum + Math.abs(Math.hypot((p.x - x - w / 2) / (w / 2), (p.y - y - h / 2) / (h / 2)) - 1), 0) / points.length;
  const cornerCoverage = corners.every((c) => points.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < diagonal * 0.13));
  const kind = ellipseError < 0.1 ? 'ellipse' : rectangleError < 0.045 && cornerCoverage ? 'rectangle' : null;
  return kind ? makeShape(kind, { x, y }, { x: x + w, y: y + h }, color, width, id) : null;
}

export function normalizeStroke(node: StrokeNode): ShapeNode | null {
  const a = node[1];
  return recognizeShape(a.points.map((p) => ({ ...p, x: p.x + a.position.x, y: p.y + a.position.y })), a.color, a.width, a.id);
}
