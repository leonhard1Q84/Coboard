import type { Brush, InkPoint, Point, ShapeNode, StrokeNode } from '../../ipc/types';
import { curveControlPoint, isClosedShape, sampleWavePoints } from './shapes';

/** 1€ filter: removes slow-motion jitter while keeping fast strokes responsive. */
export class OneEuroFilter {
  private prev: { x: number; y: number; t: number } | null = null;
  private dx = 0;
  private dy = 0;
  constructor(private minCutoff = 1.2, private beta = 0.007, private dCutoff = 1) {}

  filter(x: number, y: number, tMs: number): Point {
    const prev = this.prev;
    if (!prev) {
      this.prev = { x, y, t: tMs };
      return { x, y };
    }
    const dt = Math.max(tMs - prev.t, 1) / 1000;
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const ad = alpha(this.dCutoff);
    this.dx = ad * ((x - prev.x) / dt) + (1 - ad) * this.dx;
    this.dy = ad * ((y - prev.y) / dt) + (1 - ad) * this.dy;
    const a = alpha(this.minCutoff + this.beta * Math.hypot(this.dx, this.dy));
    const next = { x: a * x + (1 - a) * prev.x, y: a * y + (1 - a) * prev.y };
    this.prev = { ...next, t: tMs };
    return next;
  }
}

/** Per-sample radius for the pen: pressure widens, speed thins, ends taper; smoothed to avoid steps. */
function penRadii(points: InkPoint[], width: number): number[] {
  const radii: number[] = [];
  let last = width / 2;
  points.forEach((p, i) => {
    const prev = points[i - 1] ?? p;
    const dt = Math.max(p.elapsed_ms - prev.elapsed_ms, 1) / 1000;
    const speed = Math.hypot(p.x - prev.x, p.y - prev.y) / dt;
    const target = (width / 2) * (0.5 + p.pressure) * (1 - Math.min(speed / 4000, 0.3));
    last = i === 0 ? target : last * 0.6 + target * 0.4;
    radii.push(Math.max(last, 0.4));
  });
  const n = radii.length;
  for (let i = 0; i < Math.min(3, n); i++) {
    const taper = 0.55 + 0.15 * i;
    radii[i] *= taper;
    radii[n - 1 - i] *= taper;
  }
  return radii;
}

export type InkStyle = { color: string; width: number; brush: Brush; opacity: number };

/** Draws world-space samples (already offset by node position) onto a context in world coordinates. */
export function drawInk(ctx: CanvasRenderingContext2D, pts: InkPoint[], style: InkStyle) {
  if (!pts.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = style.color;
  ctx.fillStyle = style.color;
  ctx.globalAlpha = style.opacity;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, (style.width / 2) * (style.brush === 'pen' ? 0.5 + pts[0].pressure : 1), 0, Math.PI * 2);
    ctx.fill();
  } else if (style.brush === 'pencil') {
    // Fixed offsets and dash pattern keep grain stable across redraws and recovery.
    ctx.lineWidth = Math.max(0.6, style.width * 0.45);
    ctx.globalAlpha = style.opacity * 0.65;
    ctx.beginPath();
    tracePath(ctx, pts);
    ctx.stroke();
    ctx.globalAlpha = style.opacity * 0.3;
    ctx.setLineDash([1.5, 2.5]);
    for (const offset of [-0.7, 0.7]) {
      ctx.beginPath();
      tracePath(ctx, pts.map((p) => ({ x: p.x + offset, y: p.y - offset })));
      ctx.stroke();
    }
  } else if (style.brush === 'fountain') {
    // A fixed slanted nib produces directional width; pressure controls its size.
    const nib = (p: InkPoint) => style.width * (0.35 + p.pressure * 0.65);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], ar = nib(a), br = nib(b);
      ctx.beginPath();
      ctx.moveTo(a.x - ar, a.y + ar * 0.5);
      ctx.lineTo(a.x + ar, a.y - ar * 0.5);
      ctx.lineTo(b.x + br, b.y - br * 0.5);
      ctx.lineTo(b.x - br, b.y + br * 0.5);
      ctx.closePath();
      ctx.fill();
    }
  } else if (style.brush === 'highlighter' || style.brush === 'marker') {
    // One path so overlapping segments do not darken the translucent ink.
    ctx.lineWidth = style.width;
    ctx.beginPath();
    tracePath(ctx, pts);
    ctx.stroke();
  } else {
    const radii = penRadii(pts, style.width);
    let from: Point = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const last = i === pts.length - 1;
      const to = last ? pts[i] : mid(pts[i], pts[i + 1]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      if (last) ctx.lineTo(to.x, to.y);
      else ctx.quadraticCurveTo(pts[i].x, pts[i].y, to.x, to.y);
      ctx.lineWidth = radii[i] * 2;
      ctx.stroke();
      from = to;
    }
  }
  ctx.restore();
}

function tracePath(ctx: CanvasRenderingContext2D, pts: Point[]) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const m = mid(pts[i], pts[i + 1]);
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
  }
  const end = pts[pts.length - 1];
  ctx.lineTo(end.x, end.y);
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function strokeWorldPoints(node: StrokeNode, dx = 0, dy = 0): InkPoint[] {
  const { position, points } = node[1];
  return points.map((p) => ({ ...p, x: p.x + position.x + dx, y: p.y + position.y + dy }));
}

export function drawStroke(ctx: CanvasRenderingContext2D, node: StrokeNode, color: string, dx = 0, dy = 0) {
  const a = node[1];
  drawInk(ctx, strokeWorldPoints(node, dx, dy), { color, width: a.width, brush: a.brush ?? 'pen', opacity: a.opacity ?? 1 });
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const ch of para) {
      const candidate = line + ch;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        out.push(line);
        line = ch;
      } else {
        line = candidate;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function drawShape(
  ctx: CanvasRenderingContext2D,
  node: ShapeNode,
  color: string,
  dx = 0,
  dy = 0,
  opts?: { fillColor?: string; textColor?: string; hideText?: boolean },
) {
  const { kind, position, end, width, corner_radius, fill, text, rotation = 0, points } = node[1];
  const x = position.x + dx;
  const y = position.y + dy;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (isClosedShape(kind)) {
    const cx = x + end.x / 2;
    const cy = y + end.y / 2;
    if (rotation) {
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.translate(-cx, -cy);
    }

    ctx.beginPath();
    if (kind === 'rectangle') {
      const r = corner_radius ? Math.min(corner_radius, end.x / 2, end.y / 2) : 0;
      if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, end.x, end.y, r);
      else if (r > 0) {
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + end.x, y, x + end.x, y + end.y, r);
        ctx.arcTo(x + end.x, y + end.y, x, y + end.y, r);
        ctx.arcTo(x, y + end.y, x, y, r);
        ctx.arcTo(x, y, x + end.x, y, r);
        ctx.closePath();
      } else {
        ctx.rect(x, y, end.x, end.y);
      }
    } else if (kind === 'ellipse') {
      ctx.ellipse(cx, cy, end.x / 2, end.y / 2, 0, 0, Math.PI * 2);
    } else if (kind === 'diamond') {
      ctx.moveTo(cx, y);
      ctx.lineTo(x + end.x, cy);
      ctx.lineTo(cx, y + end.y);
      ctx.lineTo(x, cy);
      ctx.closePath();
    } else {
      // Triangle (preserve custom fitted vertices when present)
      const verts =
        points && points.length === 3
          ? points.map((p) => ({ x: x + p.x, y: y + p.y }))
          : [
              { x: cx, y },
              { x: x + end.x, y: y + end.y },
              { x, y: y + end.y },
            ];
      ctx.moveTo(verts[0].x, verts[0].y);
      ctx.lineTo(verts[1].x, verts[1].y);
      ctx.lineTo(verts[2].x, verts[2].y);
      ctx.closePath();
    }

    if (fill) {
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = opts?.fillColor ?? color;
      ctx.fill();
      ctx.restore();
    }
    ctx.stroke();

    if (!opts?.hideText && text?.trim()) {
      ctx.font = '500 14px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      const maxW = Math.max(36, end.x * (kind === 'triangle' || kind === 'diamond' ? 0.65 : 0.86) - 12);
      const lines = wrapLines(ctx, text.trim(), maxW);
      const lineH = 20;
      let textX = cx;
      let textY = cy;
      if (kind === 'triangle') {
        if (points && points.length === 3) {
          textX = x + (points[0].x + points[1].x + points[2].x) / 3;
          textY = y + (points[0].y + points[1].y + points[2].y) / 3;
        } else {
          textY = y + end.y * 0.62;
        }
      }
      ctx.fillStyle = opts?.textColor ?? color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const startY = textY - ((lines.length - 1) * lineH) / 2;
      lines.forEach((line, i) => ctx.fillText(line, textX, startY + i * lineH));
    }
  } else if (kind === 'wave') {
    const pts = sampleWavePoints(node, dx, dy);
    if (pts.length >= 2) {
      ctx.beginPath();
      tracePath(ctx, pts);
      ctx.stroke();
    }
  } else if (kind === 'curve') {
    const ex = end.x + dx;
    const ey = end.y + dy;
    const ctrl = curveControlPoint(node, dx, dy);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(ctrl.x, ctrl.y, ex, ey);
    ctx.stroke();
  } else {
    const ex = end.x + dx;
    const ey = end.y + dy;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    if (kind === 'arrow') {
      const angle = Math.atan2(ey - y, ex - x);
      const head = Math.max(10, width * 3);
      for (const side of [-1, 1]) {
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - head * Math.cos(angle + side * 0.45), ey - head * Math.sin(angle + side * 0.45));
      }
    }
    ctx.stroke();
  }

  ctx.restore();
}

export type LaserSample = { x: number; y: number; t: number };
export const LASER_HOLD_MS = 1000;
export const LASER_FADE_MS = 500;

/** Draws laser trails; returns true while any sample is still visible. */
export function drawLaser(ctx: CanvasRenderingContext2D, trails: LaserSample[][], now: number, color: string, zoom: number): boolean {
  let alive = false;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  for (const trail of trails) {
    for (let i = 1; i < trail.length; i++) {
      const age = now - trail[i].t;
      const alpha = age < LASER_HOLD_MS ? 1 : 1 - (age - LASER_HOLD_MS) / LASER_FADE_MS;
      if (alpha <= 0) continue;
      alive = true;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 5 / zoom;
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke();
    }
  }
  ctx.restore();
  return alive;
}
