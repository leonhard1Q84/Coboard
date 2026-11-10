import type {
  ConnectorAnchor,
  ConnectorNode,
  ConnectorRoute,
  Document,
  Point,
  SceneNode,
} from '../../ipc/types';
import { isClosedShape, rotatePoint, shapeVerticesWorld } from './shapes';

export type Rect = { x: number; y: number; w: number; h: number };
export type AnchorSide = Exclude<ConnectorAnchor, 'auto' | 'center'>;
export type SnapTarget = { nodeId: string; anchor: ConnectorAnchor; point: Point };
export type DragShift = { ids: ReadonlySet<string>; dx: number; dy: number } | null;

export const CONNECTOR_ROUTE_NAMES: Record<ConnectorRoute, string> = {
  straight: '直线',
  elbow: '折线',
  curve: '曲线',
};

const DEFAULT_CONNECTOR_COLOR = '#1f2329';
const DEFAULT_CONNECTOR_WIDTH = 2;

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function pointsBounds(pts: readonly Point[], pad = 0): Rect | null {
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

export function getNodeBounds(
  node: SceneNode,
  domRects?: ReadonlyMap<string, Rect>,
  shift?: Point,
): Rect | null {
  const dx = shift?.x ?? 0;
  const dy = shift?.y ?? 0;
  switch (node[0]) {
    case 'stroke': {
      const { position, points, width } = node[1];
      const world = points.map((p) => ({ x: position.x + p.x + dx, y: position.y + p.y + dy }));
      return pointsBounds(world, width / 2);
    }
    case 'shape': {
      const verts = shapeVerticesWorld(node, dx, dy);
      return pointsBounds(verts, node[1].width / 2);
    }
    case 'image':
      return { x: node[1].position.x + dx, y: node[1].position.y + dy, w: node[1].width, h: node[1].height };
    case 'paragraph':
    case 'math_block':
    case 'derivation_card': {
      const cached = domRects?.get(node[1].id);
      if (cached) return { x: cached.x + dx, y: cached.y + dy, w: cached.w, h: cached.h };
      return { x: node[1].position.x + dx, y: node[1].position.y + dy, w: 120, h: 36 };
    }
    case 'connector':
      return null;
  }
}

export function getConnectableAnchors(
  node: SceneNode,
  domRects?: ReadonlyMap<string, Rect>,
  shift?: Point,
): { anchor: AnchorSide; point: Point }[] {
  const bounds = getNodeBounds(node, domRects, shift);
  if (!bounds) return [];
  const dx = shift?.x ?? 0;
  const dy = shift?.y ?? 0;
  if (node[0] === 'shape' && isClosedShape(node[1].kind) && node[1].rotation) {
    const cx = node[1].position.x + dx + node[1].end.x / 2;
    const cy = node[1].position.y + dy + node[1].end.y / 2;
    const hw = node[1].end.x / 2;
    const hh = node[1].end.y / 2;
    const c = { x: cx, y: cy };
    const rot = node[1].rotation;
    return [
      { anchor: 'top', point: rotatePoint({ x: cx, y: cy - hh }, c, rot) },
      { anchor: 'right', point: rotatePoint({ x: cx + hw, y: cy }, c, rot) },
      { anchor: 'bottom', point: rotatePoint({ x: cx, y: cy + hh }, c, rot) },
      { anchor: 'left', point: rotatePoint({ x: cx - hw, y: cy }, c, rot) },
    ];
  }
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  return [
    { anchor: 'top', point: { x: cx, y: bounds.y } },
    { anchor: 'right', point: { x: bounds.x + bounds.w, y: cy } },
    { anchor: 'bottom', point: { x: cx, y: bounds.y + bounds.h } },
    { anchor: 'left', point: { x: bounds.x, y: cy } },
  ];
}

function rayPolygonIntersection(origin: Point, target: Point, poly: readonly Point[]): Point {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  let bestT = Infinity;
  let best = target;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) <= 1e-9) continue;
    const qpx = a.x - origin.x;
    const qpy = a.y - origin.y;
    const t = (qpx * ey - qpy * ex) / denom;
    const u = (qpx * dy - qpy * dx) / denom;
    if (t >= 0 && u >= -1e-4 && u <= 1 + 1e-4 && t < bestT) {
      bestT = t;
      best = { x: origin.x + t * dx, y: origin.y + t * dy };
    }
  }
  return Number.isFinite(bestT) ? best : origin;
}

function rayRectIntersection(origin: Point, target: Point, r: Rect): Point {
  const poly: Point[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
    { x: r.x, y: r.y },
  ];
  return rayPolygonIntersection(origin, target, poly);
}

export function getAnchorPoint(
  node: SceneNode,
  anchor: ConnectorAnchor,
  toward: Point,
  domRects?: ReadonlyMap<string, Rect>,
  shift?: Point,
): Point {
  const bounds = getNodeBounds(node, domRects, shift);
  if (!bounds) return toward;
  const center = rectCenter(bounds);
  if (anchor === 'center') return center;
  if (anchor !== 'auto') {
    const found = getConnectableAnchors(node, domRects, shift).find((a) => a.anchor === anchor);
    return found ? found.point : center;
  }
  if (Math.hypot(toward.x - center.x, toward.y - center.y) < 1e-3) return center;
  if (node[0] === 'shape' && isClosedShape(node[1].kind)) {
    const dx = shift?.x ?? 0;
    const dy = shift?.y ?? 0;
    const poly = shapeVerticesWorld(node, dx, dy);
    return rayPolygonIntersection(center, toward, poly);
  }
  return rayRectIntersection(center, toward, bounds);
}

export function findNearestSnapTarget(
  doc: Document,
  p: Point,
  domRects?: ReadonlyMap<string, Rect>,
  excludeIds?: ReadonlySet<string>,
  anchorRadius = 18,
  bodyMargin = 10,
): SnapTarget | null {
  let bestAnchor: SnapTarget | null = null;
  let bestDist = anchorRadius;
  const nodes = Object.values(doc.nodes);
  for (const n of nodes) {
    if (n[0] === 'connector' || excludeIds?.has(n[1].id)) continue;
    for (const a of getConnectableAnchors(n, domRects)) {
      const d = Math.hypot(p.x - a.point.x, p.y - a.point.y);
      if (d <= bestDist) {
        bestDist = d;
        bestAnchor = { nodeId: n[1].id, anchor: a.anchor, point: a.point };
      }
    }
  }
  if (bestAnchor) return bestAnchor;

  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n[0] === 'connector' || excludeIds?.has(n[1].id)) continue;
    const b = getNodeBounds(n, domRects);
    if (!b) continue;
    if (
      p.x >= b.x - bodyMargin
      && p.x <= b.x + b.w + bodyMargin
      && p.y >= b.y - bodyMargin
      && p.y <= b.y + b.h + bodyMargin
    ) {
      return {
        nodeId: n[1].id,
        anchor: 'auto',
        point: getAnchorPoint(n, 'auto', p, domRects),
      };
    }
  }
  return null;
}

function inferDirectionVector(anchor: ConnectorAnchor, bounds: Rect | null, pt: Point, fallbackTo: Point): Point {
  if (anchor === 'top') return { x: 0, y: -1 };
  if (anchor === 'right') return { x: 1, y: 0 };
  if (anchor === 'bottom') return { x: 0, y: 1 };
  if (anchor === 'left') return { x: -1, y: 0 };
  if (bounds) {
    const c = rectCenter(bounds);
    const nx = bounds.w > 0 ? (pt.x - c.x) / (bounds.w / 2) : 0;
    const ny = bounds.h > 0 ? (pt.y - c.y) / (bounds.h / 2) : 0;
    if (Math.abs(nx) >= Math.abs(ny)) return { x: nx >= 0 ? 1 : -1, y: 0 };
    return { x: 0, y: ny >= 0 ? 1 : -1 };
  }
  const dx = fallbackTo.x - pt.x;
  const dy = fallbackTo.y - pt.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? 1 : -1, y: 0 };
  return { x: 0, y: dy >= 0 ? 1 : -1 };
}

export function resolveConnectorEndpoints(
  doc: Document,
  node: ConnectorNode,
  domRects?: ReadonlyMap<string, Rect>,
  dragOverride?: DragShift,
): {
  start: Point;
  end: Point;
  fromBounds: Rect | null;
  toBounds: Rect | null;
  waypoints: Point[];
} | null {
  const a = node[1];
  const shiftFor = (id?: string): Point | undefined =>
    id && dragOverride?.ids.has(id) ? { x: dragOverride.dx, y: dragOverride.dy } : undefined;
  const connShifted = dragOverride?.ids.has(a.id);

  const fromNode = a.from ? doc.nodes[a.from] : undefined;
  const toNode = a.to ? doc.nodes[a.to] : undefined;
  if (a.from && !fromNode) return null;
  if (a.to && !toNode) return null;

  const fromShift = fromNode ? shiftFor(fromNode[1].id) : undefined;
  const toShift = toNode ? shiftFor(toNode[1].id) : undefined;
  const fromBounds = fromNode ? getNodeBounds(fromNode, domRects, fromShift) : null;
  const toBounds = toNode ? getNodeBounds(toNode, domRects, toShift) : null;

  const rawWaypoints = (a.waypoints ?? []).map((wp) =>
    connShifted && dragOverride ? { x: wp.x + dragOverride.dx, y: wp.y + dragOverride.dy } : wp,
  );
  const firstWp = rawWaypoints[0];
  const lastWp = rawWaypoints[rawWaypoints.length - 1];

  const startRef: Point = fromBounds
    ? rectCenter(fromBounds)
    : a.from_point
      ? connShifted && dragOverride
        ? { x: a.from_point.x + dragOverride.dx, y: a.from_point.y + dragOverride.dy }
        : a.from_point
      : a.position;

  const endRef: Point = toBounds
    ? rectCenter(toBounds)
    : a.to_point
      ? connShifted && dragOverride
        ? { x: a.to_point.x + dragOverride.dx, y: a.to_point.y + dragOverride.dy }
        : a.to_point
      : a.position;

  const start = fromNode
    ? getAnchorPoint(fromNode, a.from_anchor ?? 'auto', firstWp ?? endRef, domRects, fromShift)
    : startRef;
  const end = toNode
    ? getAnchorPoint(toNode, a.to_anchor ?? 'auto', lastWp ?? startRef, domRects, toShift)
    : endRef;

  return { start, end, fromBounds, toBounds, waypoints: rawWaypoints };
}

export function connectorPolyline(
  doc: Document,
  node: ConnectorNode,
  domRects?: ReadonlyMap<string, Rect>,
  dragOverride?: DragShift,
  dx = 0,
  dy = 0,
): Point[] {
  const effectiveDrag = dragOverride ?? (dx || dy ? { ids: new Set([node[1].id]), dx, dy } : null);
  const resolved = resolveConnectorEndpoints(doc, node, domRects, effectiveDrag);
  if (!resolved) return [];
  const { start, end, fromBounds, toBounds, waypoints } = resolved;
  const route = node[1].route ?? 'straight';

  if (route === 'straight') return [start, ...waypoints, end];

  if (route === 'elbow') {
    if (waypoints.length > 0) {
      const pts: Point[] = [start];
      const anchors = [...waypoints, end];
      for (const next of anchors) {
        const prev = pts[pts.length - 1];
        if (Math.abs(prev.x - next.x) > 1 && Math.abs(prev.y - next.y) > 1) {
          pts.push({ x: next.x, y: prev.y });
        }
        pts.push(next);
      }
      return pts;
    }
    const stub = 18;
    const d1 = inferDirectionVector(node[1].from_anchor ?? 'auto', fromBounds, start, end);
    const d2 = inferDirectionVector(node[1].to_anchor ?? 'auto', toBounds, end, start);
    const s1 = { x: start.x + d1.x * stub, y: start.y + d1.y * stub };
    const e1 = { x: end.x + d2.x * stub, y: end.y + d2.y * stub };
    if (d1.x !== 0 && d2.x !== 0) {
      const midX = (s1.x + e1.x) / 2;
      return [start, s1, { x: midX, y: s1.y }, { x: midX, y: e1.y }, e1, end];
    }
    if (d1.y !== 0 && d2.y !== 0) {
      const midY = (s1.y + e1.y) / 2;
      return [start, s1, { x: s1.x, y: midY }, { x: e1.x, y: midY }, e1, end];
    }
    const corner = d1.x !== 0 ? { x: e1.x, y: s1.y } : { x: s1.x, y: e1.y };
    return [start, s1, corner, e1, end];
  }

  // Curve
  const steps = 24;
  if (waypoints.length >= 1) {
    // Pass smoothly near the midpoint bend control (quadratic Bezier when 1 waypoint)
    const wp = waypoints[0];
    const ctrl = {
      x: 2 * wp.x - 0.5 * (start.x + end.x),
      y: 2 * wp.y - 0.5 * (start.y + end.y),
    };
    const out: Point[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      out.push({
        x: mt * mt * start.x + 2 * mt * t * ctrl.x + t * t * end.x,
        y: mt * mt * start.y + 2 * mt * t * ctrl.y + t * t * end.y,
      });
    }
    return out;
  }
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const k = Math.max(24, Math.min(140, dist * 0.38));
  const d1 = inferDirectionVector(node[1].from_anchor ?? 'auto', fromBounds, start, end);
  const d2 = inferDirectionVector(node[1].to_anchor ?? 'auto', toBounds, end, start);
  const c1 = { x: start.x + d1.x * k, y: start.y + d1.y * k };
  const c2 = { x: end.x + d2.x * k, y: end.y + d2.y * k };
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    out.push({
      x: mt ** 3 * start.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * end.x,
      y: mt ** 3 * start.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * end.y,
    });
  }
  return out;
}

export function connectorMidpoint(pts: readonly Point[]): Point {
  if (!pts.length) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (total <= 1e-6) return pts[0];
  let acc = 0;
  const target = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + seg >= target && seg > 1e-6) {
      const f = (target - acc) / seg;
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
      };
    }
    acc += seg;
  }
  return pts[Math.floor(pts.length / 2)];
}

function drawArrowHead(ctx: CanvasRenderingContext2D, tip: Point, from: Point, width: number) {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const head = Math.max(9, width * 3.4);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - head * Math.cos(angle - 0.42), tip.y - head * Math.sin(angle - 0.42));
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - head * Math.cos(angle + 0.42), tip.y - head * Math.sin(angle + 0.42));
  ctx.stroke();
}

export function drawConnector(
  ctx: CanvasRenderingContext2D,
  doc: Document,
  node: ConnectorNode,
  resolveColor: (hex: string) => string,
  domRects?: ReadonlyMap<string, Rect>,
  dragOverride?: DragShift,
  cardColor?: string,
  textColor?: string,
  hideLabel = false,
) {
  const pts = connectorPolyline(doc, node, domRects, dragOverride);
  if (pts.length < 2) return;
  const a = node[1];
  const color = resolveColor(a.color ?? DEFAULT_CONNECTOR_COLOR);
  const width = a.width ?? DEFAULT_CONNECTOR_WIDTH;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (a.dashed) ctx.setLineDash([Math.max(5, width * 3), Math.max(4, width * 2)]);

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if ((a.route ?? 'straight') === 'elbow' && pts.length >= 3) {
    const r = 6;
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const next = pts[i + 1];
      const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const d2 = Math.hypot(next.x - cur.x, next.y - cur.y);
      const rad = Math.min(r, d1 / 2, d2 / 2);
      if (rad > 1) {
        const pIn = { x: cur.x - ((cur.x - prev.x) / d1) * rad, y: cur.y - ((cur.y - prev.y) / d1) * rad };
        const pOut = { x: cur.x + ((next.x - cur.x) / d2) * rad, y: cur.y + ((next.y - cur.y) / d2) * rad };
        ctx.lineTo(pIn.x, pIn.y);
        ctx.quadraticCurveTo(cur.x, cur.y, pOut.x, pOut.y);
      } else {
        ctx.lineTo(cur.x, cur.y);
      }
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  } else {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.stroke();

  ctx.setLineDash([]);
  if (a.start_head === 'arrow') {
    const next = pts.find((p, i) => i > 0 && Math.hypot(p.x - pts[0].x, p.y - pts[0].y) > 0.5) ?? pts[1];
    drawArrowHead(ctx, pts[0], next, width);
  }
  if ((a.end_head ?? 'arrow') === 'arrow') {
    const tip = pts[pts.length - 1];
    let prev = pts[pts.length - 2];
    for (let i = pts.length - 2; i >= 0; i--) {
      if (Math.hypot(tip.x - pts[i].x, tip.y - pts[i].y) > 0.5) { prev = pts[i]; break; }
    }
    drawArrowHead(ctx, tip, prev, width);
  }

  if (!hideLabel && a.label?.trim()) {
    const m = connectorMidpoint(pts);
    ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const text = a.label.trim();
    const tw = ctx.measureText(text).width;
    const pw = tw + 14;
    const ph = 22;
    ctx.fillStyle = cardColor ?? '#ffffff';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(m.x - pw / 2, m.y - ph / 2, pw, ph, 6);
    else ctx.rect(m.x - pw / 2, m.y - ph / 2, pw, ph);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.28;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = textColor ?? color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, m.x, m.y + 0.5);
  }

  ctx.restore();
}
