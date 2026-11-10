import type { InkPoint, Point, ShapeKind, ShapeNode, StrokeNode } from '../../ipc/types';

export const SHAPE_NAMES: Record<ShapeKind, string> = {
  rectangle: '矩形',
  ellipse: '椭圆',
  triangle: '三角形',
  diamond: '菱形',
  line: '直线',
  arrow: '箭头',
  curve: '弧线',
  wave: '波浪线',
};

export const SHAPE_PRESETS: readonly ShapeKind[] = ['rectangle', 'ellipse', 'triangle', 'diamond', 'line', 'arrow'];

export type ShapeOptions = {
  fill?: string;
  corner_radius?: number;
  text?: string;
  rotation?: number;
  points?: Point[];
  group_ids?: string[];
};

const round2 = (v: number) => Math.round(v * 100) / 100;

export const isClosedShape = (kind: ShapeKind): boolean =>
  kind === 'rectangle' || kind === 'ellipse' || kind === 'triangle' || kind === 'diamond';

export const isOpenShape = (kind: ShapeKind): boolean => !isClosedShape(kind);

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 <= 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function pointLineDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len <= 1e-9 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

function snapLineEndpoint(first: Point, last: Point): Point {
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  if (Math.abs(dy) <= Math.abs(dx) * 0.06) return { x: last.x, y: first.y };
  if (Math.abs(dx) <= Math.abs(dy) * 0.06) return { x: first.x, y: last.y };
  return last;
}

export function rotatePoint(p: Point, center: Point, angle: number): Point {
  if (!angle) return p;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c };
}

export function shapeCenter(node: ShapeNode): Point {
  const { kind, position, end } = node[1];
  if (isClosedShape(kind)) return { x: position.x + end.x / 2, y: position.y + end.y / 2 };
  return { x: (position.x + end.x) / 2, y: (position.y + end.y) / 2 };
}

export function sampleWavePoints(node: ShapeNode, dx = 0, dy = 0, steps = 48): Point[] {
  const { position, end, points } = node[1];
  const sx = position.x + dx;
  const sy = position.y + dy;
  const ex = end.x + dx;
  const ey = end.y + dy;
  const len = Math.hypot(ex - sx, ey - sy);
  if (len <= 1e-6) return [{ x: sx, y: sy }, { x: ex, y: ey }];
  const cyclesSigned = points?.[0]?.x ?? 2;
  const amp = points?.[0]?.y ?? Math.max(8, Math.min(24, len * 0.1));
  const ux = (ex - sx) / len;
  const uy = (ey - sy) / len;
  const nx = -uy;
  const ny = ux;
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const offset = amp * Math.sin(Math.PI * 2 * cyclesSigned * t);
    out.push({ x: sx + ux * (t * len) + nx * offset, y: sy + uy * (t * len) + ny * offset });
  }
  return out;
}

export function curveControlPoint(node: ShapeNode, dx = 0, dy = 0): Point {
  const { position, end, points } = node[1];
  if (points?.[0]) {
    return { x: position.x + dx + points[0].x, y: position.y + dy + points[0].y };
  }
  const sx = position.x + dx;
  const sy = position.y + dy;
  const ex = end.x + dx;
  const ey = end.y + dy;
  const len = Math.hypot(ex - sx, ey - sy) || 1;
  const nx = -(ey - sy) / len;
  const ny = (ex - sx) / len;
  return { x: (sx + ex) / 2 + nx * (len * 0.25), y: (sy + ey) / 2 + ny * (len * 0.25) };
}

export function sampleCurvePoints(node: ShapeNode, dx = 0, dy = 0, steps = 24): Point[] {
  const p0 = { x: node[1].position.x + dx, y: node[1].position.y + dy };
  const p2 = { x: node[1].end.x + dx, y: node[1].end.y + dy };
  const ctrl = curveControlPoint(node, dx, dy);
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    out.push({
      x: mt * mt * p0.x + 2 * mt * t * ctrl.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * ctrl.y + t * t * p2.y,
    });
  }
  return out;
}

/** Returns polygon / polyline samples in world space (rotation applied for closed shapes). */
export function shapeVerticesWorld(node: ShapeNode, dx = 0, dy = 0): Point[] {
  const { kind, position, end, rotation = 0, points } = node[1];
  const px = position.x + dx;
  const py = position.y + dy;
  if (kind === 'line' || kind === 'arrow') return [{ x: px, y: py }, { x: end.x + dx, y: end.y + dy }];
  if (kind === 'wave') return sampleWavePoints(node, dx, dy);
  if (kind === 'curve') return sampleCurvePoints(node, dx, dy);

  const center = { x: px + end.x / 2, y: py + end.y / 2 };
  if (kind === 'rectangle') {
    const raw = [
      { x: px, y: py },
      { x: px + end.x, y: py },
      { x: px + end.x, y: py + end.y },
      { x: px, y: py + end.y },
      { x: px, y: py },
    ];
    return rotation ? raw.map((q) => rotatePoint(q, center, rotation)) : raw;
  }
  if (kind === 'diamond') {
    const raw = [
      { x: px + end.x / 2, y: py },
      { x: px + end.x, y: py + end.y / 2 },
      { x: px + end.x / 2, y: py + end.y },
      { x: px, y: py + end.y / 2 },
      { x: px + end.x / 2, y: py },
    ];
    return rotation ? raw.map((q) => rotatePoint(q, center, rotation)) : raw;
  }
  if (kind === 'triangle') {
    const baseVerts =
      points && points.length === 3
        ? points.map((v) => ({ x: px + v.x, y: py + v.y }))
        : [
            { x: px + end.x / 2, y: py },
            { x: px + end.x, y: py + end.y },
            { x: px, y: py + end.y },
          ];
    const closed = [...baseVerts, baseVerts[0]];
    return rotation ? closed.map((q) => rotatePoint(q, center, rotation)) : closed;
  }
  // Ellipse
  const steps = 32;
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const q = { x: center.x + (end.x / 2) * Math.cos(a), y: center.y + (end.y / 2) * Math.sin(a) };
    pts.push(rotation ? rotatePoint(q, center, rotation) : q);
  }
  return pts;
}

export function makeShape(
  kind: ShapeKind,
  start: Point,
  finish: Point,
  color: string,
  width: number,
  id: string = crypto.randomUUID(),
  opts: ShapeOptions = {},
): ShapeNode {
  const closed = isClosedShape(kind);
  const position = closed ? { x: Math.min(start.x, finish.x), y: Math.min(start.y, finish.y) } : start;
  const end = closed
    ? { x: Math.max(1, Math.abs(finish.x - start.x)), y: Math.max(1, Math.abs(finish.y - start.y)) }
    : finish;
  const cornerRadius = kind === 'rectangle' && opts.corner_radius && opts.corner_radius > 0 ? round2(opts.corner_radius) : undefined;
  return [
    'shape',
    {
      id,
      kind,
      color,
      width,
      position,
      end,
      ...(closed && opts.fill ? { fill: opts.fill } : {}),
      ...(cornerRadius !== undefined ? { corner_radius: cornerRadius } : {}),
      ...(closed && opts.text ? { text: opts.text } : {}),
      ...(closed && opts.rotation ? { rotation: round2(opts.rotation) } : {}),
      ...(opts.points?.length ? { points: opts.points.map((p) => ({ x: round2(p.x), y: round2(p.y) })) } : {}),
      ...(opts.group_ids?.length ? { group_ids: opts.group_ids } : {}),
    },
  ];
}

function tryRecognizeWave(
  points: readonly Point[],
  first: Point,
  last: Point,
  pathLength: number,
  color: string,
  width: number,
  id: string,
  opts: ShapeOptions = {},
): ShapeNode | null {
  const direct = Math.hypot(last.x - first.x, last.y - first.y);
  if (direct < 36 || pathLength < 44 || direct / pathLength < 0.35) return null;
  const ux = (last.x - first.x) / direct;
  const uy = (last.y - first.y) / direct;
  const nx = -uy;
  const ny = ux;
  const along: number[] = [];
  const perp: number[] = [];
  let backtrack = 0;
  let prevAlong = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const vx = p.x - first.x;
    const vy = p.y - first.y;
    const a = vx * ux + vy * uy;
    const q = vx * nx + vy * ny;
    if (a < -direct * 0.12 || a > direct * 1.12) return null;
    if (i > 0 && a < prevAlong) backtrack += prevAlong - a;
    prevAlong = a;
    along.push(a);
    perp.push(q);
  }
  if (backtrack > direct * 0.22) return null;

  const minProminence = Math.max(5, direct * 0.025);
  const extrema: number[] = [];
  let curSign = 0;
  let curExt = 0;
  for (const q of perp) {
    if (curSign === 0) {
      if (Math.abs(q) >= minProminence) {
        curSign = q > 0 ? 1 : -1;
        curExt = q;
      }
    } else if ((curSign > 0 && q > curExt) || (curSign < 0 && q < curExt)) {
      curExt = q;
    } else if ((curSign > 0 && q <= -minProminence) || (curSign < 0 && q >= minProminence)) {
      extrema.push(curExt);
      curSign = q > 0 ? 1 : -1;
      curExt = q;
    }
  }
  if (curSign !== 0 && Math.abs(curExt) >= minProminence) extrema.push(curExt);
  if (extrema.length < 3) return null;

  const mags = extrema.map((v) => Math.abs(v)).sort((a, b) => a - b);
  const minMag = mags[0];
  const maxMag = mags[mags.length - 1];
  if (maxMag > direct * 0.45 || minMag < maxMag * 0.35) return null;
  const amp = mags[Math.floor(mags.length / 2)];
  if (amp < 5) return null;

  const sign = extrema[0] >= 0 ? 1 : -1;
  const cycles = extrema.length * 0.5;
  let errSq = 0;
  for (let i = 0; i < along.length; i++) {
    const t = Math.max(0, Math.min(1, along[i] / direct));
    const pred = sign * amp * Math.sin(Math.PI * 2 * cycles * t);
    errSq += (perp[i] - pred) ** 2;
  }
  const rmse = Math.sqrt(errSq / points.length);
  if (rmse / amp > 0.45) return null;

  const snappedEnd = snapLineEndpoint(first, last);
  return makeShape('wave', first, snappedEnd, color, width, id, {
    ...opts,
    points: [{ x: cycles * sign, y: amp }],
  });
}

function tryRecognizeCurve(
  points: readonly Point[],
  first: Point,
  last: Point,
  pathLength: number,
  diag: number,
  color: string,
  width: number,
  id: string,
  opts: ShapeOptions = {},
): ShapeNode | null {
  const direct = Math.hypot(last.x - first.x, last.y - first.y);
  if (direct < 24 || direct < diag * 0.35 || pathLength > direct * 2.4) return null;
  const ux = (last.x - first.x) / direct;
  const uy = (last.y - first.y) / direct;
  const nx = -uy;
  const ny = ux;
  let posSum = 0;
  let negSum = 0;
  let maxAbs = 0;
  let peakIdx = 0;
  let peakT = 0.5;
  for (let i = 0; i < points.length; i++) {
    const vx = points[i].x - first.x;
    const vy = points[i].y - first.y;
    const a = vx * ux + vy * uy;
    const q = vx * nx + vy * ny;
    if (q >= 0) posSum += q;
    else negSum += -q;
    if (Math.abs(q) > maxAbs) {
      maxAbs = Math.abs(q);
      peakIdx = i;
      peakT = a / direct;
    }
  }
  const totalSum = posSum + negSum;
  if (totalSum <= 1e-6 || Math.max(posSum, negSum) / totalSum < 0.88) return null;
  if (maxAbs < Math.max(10, direct * 0.1) || maxAbs > direct * 1.1 || peakT < 0.15 || peakT > 0.85) return null;

  const denom = 2 * peakT * (1 - peakT);
  const peak = points[peakIdx];
  const ctrl: Point = {
    x: (peak.x - (1 - peakT) ** 2 * first.x - peakT ** 2 * last.x) / denom,
    y: (peak.y - (1 - peakT) ** 2 * first.y - peakT ** 2 * last.y) / denom,
  };
  const samples: Point[] = [];
  for (let s = 0; s <= 24; s++) {
    const t = s / 24;
    const mt = 1 - t;
    samples.push({
      x: mt * mt * first.x + 2 * mt * t * ctrl.x + t * t * last.x,
      y: mt * mt * first.y + 2 * mt * t * ctrl.y + t * t * last.y,
    });
  }
  let mse = 0;
  for (const p of points) {
    let best = Infinity;
    for (let i = 1; i < samples.length; i++) best = Math.min(best, pointSegmentDistance(p, samples[i - 1], samples[i]));
    mse += best * best;
  }
  const rmse = Math.sqrt(mse / points.length);
  if (rmse > Math.max(8, Math.max(direct, maxAbs) * 0.085)) return null;

  return makeShape('curve', first, last, color, width, id, {
    ...opts,
    points: [{ x: ctrl.x - first.x, y: ctrl.y - first.y }],
  });
}

function snapTriangleVertices(raw: [Point, Point, Point]): [Point, Point, Point] {
  const tcx = (raw[0].x + raw[1].x + raw[2].x) / 3;
  const tcy = (raw[0].y + raw[1].y + raw[2].y) / 3;
  const verts = [...raw].sort((a, b) => Math.atan2(a.y - tcy, a.x - tcx) - Math.atan2(b.y - tcy, b.x - tcx)) as [Point, Point, Point];
  const out = verts.map((p) => ({ ...p })) as [Point, Point, Point];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const dx = Math.abs(out[j].x - out[i].x);
    const dy = Math.abs(out[j].y - out[i].y);
    if (dy > 0 && dy <= dx * 0.1) {
      const avgY = (out[i].y + out[j].y) / 2;
      out[i].y = avgY;
      out[j].y = avgY;
    } else if (dx > 0 && dx <= dy * 0.1) {
      const avgX = (out[i].x + out[j].x) / 2;
      out[i].x = avgX;
      out[j].x = avgX;
    }
  }
  return out;
}

/** Geometric fit for freehand strokes (INK-10): line, arrow, wave, curve, rectangle, diamond, triangle, ellipse. */
export function recognizeShape(
  points: InkPoint[],
  color: string,
  width: number,
  id: string = crypto.randomUUID(),
  opts: ShapeOptions = {},
): ShapeNode | null {
  if (points.length < 4) return null;
  const first = points[0];
  const last = points[points.length - 1];
  let pathLength = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
    if (i > 0) pathLength += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y);
  }
  if (pathLength < 24) return null;
  const direct = Math.hypot(last.x - first.x, last.y - first.y);
  const maxDev = points.reduce((m, p) => Math.max(m, pointSegmentDistance(p, first, last)), 0);
  if (direct / pathLength >= 0.91 && maxDev <= Math.max(8, direct * 0.08)) {
    return makeShape('line', first, snapLineEndpoint(first, last), color, width, id, opts);
  }

  // Single-stroke arrow
  let apexIdx = 0;
  let shaftLen = 0;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i].x - first.x, points[i].y - first.y);
    if (d > shaftLen) {
      shaftLen = d;
      apexIdx = i;
    }
  }
  if (shaftLen >= 24 && apexIdx >= 2 && apexIdx + 1 < points.length) {
    const apex = points[apexIdx];
    let prefixLen = 0;
    for (let i = 1; i <= apexIdx; i++) {
      prefixLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    let prefixDev = 0;
    for (let i = 0; i <= apexIdx; i++) prefixDev = Math.max(prefixDev, pointSegmentDistance(points[i], first, apex));
    const barbLen = pathLength - prefixLen;
    if (
      prefixLen / shaftLen <= 1.15
      && prefixDev <= Math.max(6, shaftLen * 0.07)
      && barbLen >= Math.max(6, shaftLen * 0.06)
      && barbLen <= shaftLen * 0.65
    ) {
      const ux = (apex.x - first.x) / shaftLen;
      const uy = (apex.y - first.y) / shaftLen;
      let maxPerp = 0;
      let validBarbs = true;
      for (let i = apexIdx + 1; i < points.length; i++) {
        const vx = points[i].x - apex.x;
        const vy = points[i].y - apex.y;
        if (Math.hypot(vx, vy) > shaftLen * 0.45) { validBarbs = false; break; }
        const along = vx * ux + vy * uy;
        if (along > Math.max(3, shaftLen * 0.04)) { validBarbs = false; break; }
        maxPerp = Math.max(maxPerp, Math.abs(vx * -uy + vy * ux));
      }
      if (validBarbs && maxPerp >= 4) {
        return makeShape('arrow', first, snapLineEndpoint(first, apex), color, width, id, opts);
      }
    }
  }

  const wave = tryRecognizeWave(points, first, last, pathLength, color, width, id, opts);
  if (wave) return wave;

  const w = maxX - minX;
  const h = maxY - minY;
  const diag = Math.hypot(w, h);
  if (w >= 18 && h >= 18 && direct <= diag * 0.42 && pathLength <= 3 * (w + h) && pathLength >= 1.15 * (w + h)) {
    const rectErr =
      points.reduce((sum, p) => {
        const dx = Math.min(Math.abs(p.x - minX), Math.abs(maxX - p.x));
        const dy = Math.min(Math.abs(p.y - minY), Math.abs(maxY - p.y));
        return sum + Math.min(dx, dy);
      }, 0)
      / (points.length * diag);
    const rectCorners = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
    const rectCornerOk = rectCorners.every((c) => points.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < diag * 0.2));
    const rectMidsOk = rectCorners.every((c, i) => {
      const next = rectCorners[(i + 1) % 4];
      const mid = { x: (c.x + next.x) / 2, y: (c.y + next.y) / 2 };
      return points.some((p) => Math.hypot(p.x - mid.x, p.y - mid.y) < diag * 0.2);
    });

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rx = w / 2;
    const ry = h / 2;
    const ellipseErr =
      points.reduce((sum, p) => sum + Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1) * Math.min(rx, ry), 0)
      / (points.length * diag);
    let qMask = 0;
    for (const p of points) {
      qMask |= p.x >= cx ? (p.y >= cy ? 1 : 8) : (p.y >= cy ? 2 : 4);
    }
    const ellipseClosed = qMask === 0b1111;

    const diamondPts = [{ x: cx, y: minY }, { x: maxX, y: cy }, { x: cx, y: maxY }, { x: minX, y: cy }];
    const diamondErr =
      points.reduce((sum, p) => {
        let best = Infinity;
        for (let i = 0; i < 4; i++) best = Math.min(best, pointSegmentDistance(p, diamondPts[i], diamondPts[(i + 1) % 4]));
        return sum + best;
      }, 0)
      / (points.length * diag);
    const diamondCoverage = diamondPts.every((c) => points.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < diag * 0.18));

    // Triangle (3-pass farthest vertices + cyclic area refinement)
    const farthestFrom = (ref: Point) => {
      let best = points[0];
      let bestD = -1;
      for (const p of points) {
        const d = Math.hypot(p.x - ref.x, p.y - ref.y);
        if (d > bestD) { bestD = d; best = p; }
      }
      return best;
    };
    const farthestFromLine = (a: Point, b: Point) => {
      let best = points[0];
      let bestD = -1;
      for (const p of points) {
        const d = pointLineDistance(p, a, b);
        if (d > bestD) { bestD = d; best = p; }
      }
      return best;
    };
    let v0 = farthestFrom({ x: cx, y: cy });
    let v1 = farthestFrom(v0);
    const v2 = farthestFromLine(v0, v1);
    v0 = farthestFromLine(v1, v2);
    v1 = farthestFromLine(v0, v2);
    const triArea = 0.5 * Math.abs((v1.x - v0.x) * (v2.y - v0.y) - (v2.x - v0.x) * (v1.y - v0.y));
    let triErr = Infinity;
    if (triArea > 0.18 * w * h) {
      const verts: [Point, Point, Point] = [v0, v1, v2];
      const triEdgesOk = [0, 1, 2].every((i) => {
        const a = verts[i];
        const b = verts[(i + 1) % 3];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        return points.some((p) => Math.hypot(p.x - mid.x, p.y - mid.y) < diag * 0.22);
      });
      if (triEdgesOk) {
        triErr =
          points.reduce((sum, p) => {
            let best = Infinity;
            for (let i = 0; i < 3; i++) best = Math.min(best, pointSegmentDistance(p, verts[i], verts[(i + 1) % 3]));
            return sum + best;
          }, 0)
          / (points.length * diag);
      }
    }

    if (rectErr <= 0.065 && rectCornerOk && rectMidsOk && rectErr <= ellipseErr * 0.92 && rectErr <= triErr * 0.92) {
      const square = Math.abs(w - h) / Math.max(w, h) <= 0.12;
      const side = square ? (w + h) / 2 : 0;
      const startPt = square ? { x: cx - side / 2, y: cy - side / 2 } : { x: minX, y: minY };
      const endPt = square ? { x: cx + side / 2, y: cy + side / 2 } : { x: maxX, y: maxY };
      return makeShape('rectangle', startPt, endPt, color, width, id, opts);
    }
    if (diamondErr <= 0.065 && diamondCoverage && diamondErr < ellipseErr && diamondErr < triErr) {
      return makeShape('diamond', { x: minX, y: minY }, { x: maxX, y: maxY }, color, width, id, opts);
    }
    if (triErr <= 0.075 && triErr < ellipseErr) {
      const snapped = snapTriangleVertices([v0, v1, v2]);
      const tMinX = Math.min(snapped[0].x, snapped[1].x, snapped[2].x);
      const tMinY = Math.min(snapped[0].y, snapped[1].y, snapped[2].y);
      const tMaxX = Math.max(snapped[0].x, snapped[1].x, snapped[2].x);
      const tMaxY = Math.max(snapped[0].y, snapped[1].y, snapped[2].y);
      const relPts = snapped.map((v) => ({ x: v.x - tMinX, y: v.y - tMinY }));
      return makeShape('triangle', { x: tMinX, y: tMinY }, { x: tMaxX, y: tMaxY }, color, width, id, { ...opts, points: relPts });
    }
    if (ellipseErr <= 0.09 && ellipseClosed) {
      const circle = Math.abs(w - h) / Math.max(w, h) <= 0.14;
      const d = circle ? (w + h) / 2 : 0;
      const startPt = circle ? { x: cx - d / 2, y: cy - d / 2 } : { x: minX, y: minY };
      const endPt = circle ? { x: cx + d / 2, y: cy + d / 2 } : { x: maxX, y: maxY };
      return makeShape('ellipse', startPt, endPt, color, width, id, opts);
    }
  }

  return tryRecognizeCurve(points, first, last, pathLength, diag, color, width, id, opts);
}

export function normalizeStroke(node: StrokeNode, opts: ShapeOptions = {}): ShapeNode | null {
  const a = node[1];
  return recognizeShape(
    a.points.map((p) => ({ ...p, x: p.x + a.position.x, y: p.y + a.position.y })),
    a.color,
    a.width,
    a.id,
    { ...opts, ...(a.group_ids?.length ? { group_ids: a.group_ids } : {}) },
  );
}

/**
 * Merges a newly drawn stroke/shape with 1–3 prior straight line/stroke fragments
 * when endpoints touch cleanly (e.g. multi-stroke arrow, triangle, rectangle, or diamond).
 */
export function mergeRecentStrokesToShape(
  candidates: readonly (StrokeNode | ShapeNode)[],
  latestShapeOrStroke: StrokeNode | ShapeNode,
  opts: ShapeOptions = {},
): { replacedIds: string[]; shape: ShapeNode } | null {
  const asSegment = (n: StrokeNode | ShapeNode): [Point, Point] | null => {
    if (n[0] === 'shape' && n[1].kind === 'line') return [n[1].position, n[1].end];
    if (n[0] === 'stroke' && n[1].points.length >= 2) {
      const world = n[1].points.map((p) => ({ x: p.x + n[1].position.x, y: p.y + n[1].position.y }));
      const first = world[0];
      const last = world[world.length - 1];
      const len = Math.hypot(last.x - first.x, last.y - first.y);
      let pathLen = 0;
      let maxDev = 0;
      for (let i = 0; i < world.length; i++) {
        if (i > 0) pathLen += Math.hypot(world[i].x - world[i - 1].x, world[i].y - world[i - 1].y);
        maxDev = Math.max(maxDev, pointSegmentDistance(world[i], first, last));
      }
      if (len >= 18 && len / pathLen >= 0.9 && maxDev <= Math.max(8, len * 0.1)) return [first, last];
    }
    return null;
  };

  // Case A: latest stroke is a small chevron/V-barb added onto the tip of a recent straight line -> Arrow!
  if (candidates.length >= 1 && latestShapeOrStroke[0] === 'stroke' && latestShapeOrStroke[1].points.length >= 3) {
    const prev = candidates[candidates.length - 1];
    const shaft = asSegment(prev);
    if (shaft && prev[1].id !== latestShapeOrStroke[1].id) {
      const [s0, s1] = shaft;
      const sLen = Math.hypot(s1.x - s0.x, s1.y - s0.y);
      const pts = latestShapeOrStroke[1].points.map((p) => ({
        x: p.x + latestShapeOrStroke[1].position.x,
        y: p.y + latestShapeOrStroke[1].position.y,
      }));
      let bLen = 0;
      for (let i = 1; i < pts.length; i++) bLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      const barbNearEnd = pts.some((p) => Math.hypot(p.x - s1.x, p.y - s1.y) <= Math.max(18, sLen * 0.18));
      const barbNearStart = pts.some((p) => Math.hypot(p.x - s0.x, p.y - s0.y) <= Math.max(18, sLen * 0.18));
      if (sLen >= 24 && bLen >= 8 && bLen <= sLen * 0.8 && (barbNearEnd || barbNearStart)) {
        const start = barbNearStart && !barbNearEnd ? s1 : s0;
        const tip = barbNearStart && !barbNearEnd ? s0 : s1;
        const ux = (tip.x - start.x) / sLen;
        const uy = (tip.y - start.y) / sLen;
        const valid = pts.every((p) => {
          const vx = p.x - tip.x;
          const vy = p.y - tip.y;
          return Math.hypot(vx, vy) <= Math.max(28, sLen * 0.45) && vx * ux + vy * uy <= Math.max(8, sLen * 0.08);
        });
        if (valid) {
          return {
            replacedIds: [prev[1].id, latestShapeOrStroke[1].id],
            shape: makeShape('arrow', start, tip, latestShapeOrStroke[1].color, latestShapeOrStroke[1].width, crypto.randomUUID(), opts),
          };
        }
      }
    }
  }

  // Case B: up to 3 consecutive recent segments + latest segment form a closed 3-vertex triangle or 4-vertex rect
  const segList = [...candidates.slice(-3), latestShapeOrStroke];
  const latestSeg = asSegment(latestShapeOrStroke);
  if (!latestSeg) return null;

  for (const count of [4, 3]) {
    if (segList.length < count) continue;
    const slice = segList.slice(-count);
    const segs = slice.map(asSegment);
    if (segs.some((s) => !s)) continue;
    const rawSegs = segs as [Point, Point][];
    const allPts = rawSegs.flat();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of allPts) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const diag = Math.hypot(maxX - minX, maxY - minY);
    if (diag < 28) continue;
    const snapDist = Math.max(24, diag * 0.22);

    // Order chain greedily from segment 0
    const used = new Set<number>([0]);
    const vertices: Point[] = [rawSegs[0][0], rawSegs[0][1]];
    let chainOk = true;
    while (used.size < count) {
      const tail = vertices[vertices.length - 1];
      let bestIdx = -1;
      let bestEnd = 0;
      let bestD = Infinity;
      for (let i = 1; i < rawSegs.length; i++) {
        if (used.has(i)) continue;
        const d0 = Math.hypot(rawSegs[i][0].x - tail.x, rawSegs[i][0].y - tail.y);
        const d1 = Math.hypot(rawSegs[i][1].x - tail.x, rawSegs[i][1].y - tail.y);
        if (d0 < bestD) { bestD = d0; bestIdx = i; bestEnd = 0; }
        if (d1 < bestD) { bestD = d1; bestIdx = i; bestEnd = 1; }
      }
      if (bestIdx === -1 || bestD > snapDist) { chainOk = false; break; }
      used.add(bestIdx);
      const joinPt = {
        x: (tail.x + rawSegs[bestIdx][bestEnd].x) / 2,
        y: (tail.y + rawSegs[bestIdx][bestEnd].y) / 2,
      };
      vertices[vertices.length - 1] = joinPt;
      vertices.push(rawSegs[bestIdx][bestEnd === 0 ? 1 : 0]);
    }
    if (!chainOk) continue;
    const closeDist = Math.hypot(vertices[vertices.length - 1].x - vertices[0].x, vertices[vertices.length - 1].y - vertices[0].y);
    if (closeDist > snapDist) continue;
    const mergedStart = {
      x: (vertices[0].x + vertices[vertices.length - 1].x) / 2,
      y: (vertices[0].y + vertices[vertices.length - 1].y) / 2,
    };
    vertices[0] = mergedStart;
    vertices.pop();

    const styleSrc = latestShapeOrStroke[1];
    if (count === 3 && vertices.length === 3) {
      const area = 0.5 * Math.abs((vertices[1].x - vertices[0].x) * (vertices[2].y - vertices[0].y) - (vertices[2].x - vertices[0].x) * (vertices[1].y - vertices[0].y));
      if (area > 0.16 * (maxX - minX) * (maxY - minY)) {
        const snapped = snapTriangleVertices([vertices[0], vertices[1], vertices[2]]);
        const tMinX = Math.min(snapped[0].x, snapped[1].x, snapped[2].x);
        const tMinY = Math.min(snapped[0].y, snapped[1].y, snapped[2].y);
        const tMaxX = Math.max(snapped[0].x, snapped[1].x, snapped[2].x);
        const tMaxY = Math.max(snapped[0].y, snapped[1].y, snapped[2].y);
        return {
          replacedIds: slice.map((n) => n[1].id),
          shape: makeShape('triangle', { x: tMinX, y: tMinY }, { x: tMaxX, y: tMaxY }, styleSrc.color, styleSrc.width, crypto.randomUUID(), {
            ...opts,
            points: snapped.map((v) => ({ x: v.x - tMinX, y: v.y - tMinY })),
          }),
        };
      }
    }
    if (count === 4 && vertices.length === 4) {
      // Classify 4-gon as diamond vs rectangle
      const synthetic: InkPoint[] = [];
      for (let i = 0; i < 4; i++) {
        const a = vertices[i], b = vertices[(i + 1) % 4];
        for (let s = 0; s < 6; s++) {
          const f = s / 6;
          synthetic.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, pressure: 0.5, elapsed_ms: synthetic.length * 10 });
        }
      }
      synthetic.push({ ...vertices[0], pressure: 0.5, elapsed_ms: synthetic.length * 10 });
      const rec = recognizeShape(synthetic, styleSrc.color, styleSrc.width, crypto.randomUUID(), opts);
      if (rec && (rec[1].kind === 'rectangle' || rec[1].kind === 'diamond')) {
        return { replacedIds: slice.map((n) => n[1].id), shape: rec };
      }
    }
  }
  return null;
}

/** Goodnotes-style Draw & Hold live adjustment before pen-up. */
export function adjustSnappedShape(
  base: ShapeNode,
  anchorCenter: Point,
  holdPoint: Point,
  curPoint: Point,
): ShapeNode {
  const { id, kind, color, width, fill, corner_radius, text, points } = base[1];
  if (kind === 'line' || kind === 'arrow' || kind === 'wave') {
    const end = snapLineEndpoint(base[1].position, curPoint);
    if (Math.hypot(end.x - base[1].position.x, end.y - base[1].position.y) < 4) return base;
    return ['shape', { ...base[1], end }];
  }
  if (kind === 'curve') {
    const start = base[1].position;
    const end = snapLineEndpoint(start, curPoint);
    if (Math.hypot(end.x - start.x, end.y - start.y) < 4) return base;
    const oldVec = { x: base[1].end.x - start.x, y: base[1].end.y - start.y };
    const newVec = { x: end.x - start.x, y: end.y - start.y };
    const oldLen = Math.hypot(oldVec.x, oldVec.y) || 1;
    const newLen = Math.hypot(newVec.x, newVec.y);
    const scale = newLen / oldLen;
    const dAngle = Math.atan2(newVec.y, newVec.x) - Math.atan2(oldVec.y, oldVec.x);
    const ctrl = points?.[0];
    const nextCtrl = ctrl
      ? {
          x: round2((ctrl.x * Math.cos(dAngle) - ctrl.y * Math.sin(dAngle)) * scale),
          y: round2((ctrl.x * Math.sin(dAngle) + ctrl.y * Math.cos(dAngle)) * scale),
        }
      : undefined;
    return ['shape', { ...base[1], end, ...(nextCtrl ? { points: [nextCtrl] } : {}) }];
  }

  const baseR = Math.max(12, Math.hypot(holdPoint.x - anchorCenter.x, holdPoint.y - anchorCenter.y));
  const curR = Math.max(10, Math.hypot(curPoint.x - anchorCenter.x, curPoint.y - anchorCenter.y));
  const scale = Math.max(0.25, Math.min(6, curR / baseR));
  const newW = Math.max(12, round2(base[1].end.x * scale));
  const newH = Math.max(12, round2(base[1].end.y * scale));
  const holdAngle = Math.atan2(holdPoint.y - anchorCenter.y, holdPoint.x - anchorCenter.x);
  const curAngle = Math.atan2(curPoint.y - anchorCenter.y, curPoint.x - anchorCenter.x);
  let delta = curAngle - holdAngle;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const baseRot = base[1].rotation ?? 0;
  let nextRot = Math.abs(delta) > 0.2 ? baseRot + delta : baseRot;
  if (Math.abs(nextRot) < 0.08) nextRot = 0;

  return [
    'shape',
    {
      id,
      kind,
      color,
      width,
      position: { x: round2(anchorCenter.x - newW / 2), y: round2(anchorCenter.y - newH / 2) },
      end: { x: newW, y: newH },
      ...(fill ? { fill } : {}),
      ...(corner_radius !== undefined ? { corner_radius } : {}),
      ...(text ? { text } : {}),
      ...(Math.abs(nextRot) > 1e-4 ? { rotation: round2(nextRot) } : {}),
      ...(points?.length ? { points: points.map((p) => ({ x: round2(p.x * scale), y: round2(p.y * scale) })) } : {}),
    },
  ];
}
