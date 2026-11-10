import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { useOverlayBoard } from '../../stores/overlayBoard';
import { useOverlay, type OverlayCommand } from '../../stores/overlay';
import {
  connectorMidpoint,
  connectorPolyline,
  drawConnector,
  findNearestSnapTarget,
  getConnectableAnchors,
  getNodeBounds,
  type AnchorSide,
  type SnapTarget,
} from './connectors';
import {
  adjustSnappedShape,
  curveControlPoint,
  isClosedShape,
  makeShape,
  mergeRecentStrokesToShape,
  recognizeShape,
  rotatePoint,
  shapeCenter,
  type ShapeOptions,
} from './shapes';
import type {
  ConnectorAnchor,
  ConnectorNode,
  ConnectorRoute,
  InkPoint,
  Operation,
  Point,
  RecognitionCandidate,
  RecognitionInk,
  SceneNode,
  ShapeKind,
  ShapeNode,
  SourceRef,
  StrokeNode,
} from '../../ipc/types';
import { EMPTY_DOCUMENT, optimisticDocument } from '../../stores/document';
import { canRedo, canUndo, useSession } from '../../stores/session';
import {
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_SCALE,
  INK,
  INK_NAMES,
  SIZES,
  SIZE_NAMES,
  TOOL_LABELS,
  useTools,
  type ConnectorHeadsPreset,
  type Tool,
} from '../../stores/tools';
import { toWorld, useViewport } from '../../stores/viewport';
import {
  expandRect,
  hitInk,
  hitInkSegment,
  inkBounds,
  isInk,
  nodeHitsLasso,
  nodeHitsMarquee,
  pointInRect,
  polygonBounds,
  rectFromPoints,
  unionRects,
  type Rect,
} from './geometry';
import {
  buildDeleteOps,
  buildDuplicateOps,
  buildGroupOps,
  buildNormalizeOps,
  buildTranslateOps,
  buildUngroupOps,
  canGroupSelection,
  canUngroupSelection,
  expandSelection,
  visibleGroupId,
} from './grouping';
import { drawInk, drawLaser, drawShape, drawStroke, OneEuroFilter, type InkStyle, type LaserSample } from './ink';
import { InlineText } from './InlineText';
import { looksLikeMath, segmentInlineMath } from './math';
import { MathView } from './MathView';
import { isDomNode, NodeView } from './NodeView';
import { SelectionBar } from './SelectionBar';
import { HandwritingClient, sameRecognitionInk } from './handwritingClient';
import { recognizeIncrementally } from './handwritingTransport';
import { recordCandidatePresentation, type RecognitionTiming } from './handwritingMetrics';

const KEY_TOOLS: Record<string, Tool> = {
  v: 'select',
  q: 'lasso',
  p: 'pen',
  h: 'highlighter',
  l: 'laser',
  e: 'eraser',
  c: 'connector',
  s: 'shape',
  t: 'text',
};
const ERASER_RADIUS = 10;
const HIT_TOLERANCE = 6;
const HOLD_SHAPE_MS = 460;
const MULTI_STROKE_WINDOW_MS = 6000;
const DEFAULT_CORNER_RADIUS = 8;
const NO_IDS: ReadonlySet<string> = new Set();

type Gesture =
  | {
      kind: 'draw';
      pointer: number;
      style: InkStyle;
      t0: number;
      filter: OneEuroFilter;
      points: InkPoint[];
      autoShapeMode: boolean;
      shapeOpts: ShapeOptions;
      preview?: ShapeNode;
      holdBase?: ShapeNode;
      anchorCenter?: Point;
      holdPoint?: Point;
    }
  | {
      kind: 'shape';
      pointer: number;
      start: Point;
      end: Point;
      shape: ShapeKind;
      color: string;
      width: number;
      shapeOpts: ShapeOptions;
    }
  | {
      kind: 'connect';
      pointer: number;
      from?: string;
      fromPoint?: Point;
      fromAnchor: ConnectorAnchor;
      to?: string;
      toPoint: Point;
      toAnchor: ConnectorAnchor;
      startAt: Point;
      moved: boolean;
      quickNub?: AnchorSide;
      sourceNode?: SceneNode;
    }
  | { kind: 'resizeShape'; pointer: number; base: ShapeNode; corner: number; moved: boolean; draft: ShapeNode }
  | { kind: 'rotateShape'; pointer: number; base: ShapeNode; moved: boolean; draft: ShapeNode }
  | { kind: 'editOpenShape'; pointer: number; base: ShapeNode; part: 'start' | 'end' | 'ctrl'; moved: boolean; draft: ShapeNode }
  | { kind: 'editConnector'; pointer: number; base: ConnectorNode; part: 'from' | 'to' | 'bend'; moved: boolean; draft: ConnectorNode }
  | { kind: 'laser'; pointer: number; trail: LaserSample[] }
  | { kind: 'erase'; pointer: number; last: Point; hits: Set<string> }
  | { kind: 'drag'; pointer: number; ids: ReadonlySet<string>; start: Point; moved: boolean }
  | { kind: 'marquee'; pointer: number; start: Point; end: Point; additive: boolean; base: ReadonlySet<string> }
  | { kind: 'lasso'; pointer: number; points: Point[]; additive: boolean; base: ReadonlySet<string> }
  | { kind: 'pan'; pointer: number; lastX: number; lastY: number }
  | { kind: 'place'; pointer: number; at: Point; target: string | null };

type Editing =
  | { kind: 'text_or_math'; id: string | null; at: Point; value: string }
  | { kind: 'shape_text'; id: string; at: Point; value: string }
  | { kind: 'connector_label'; id: string; at: Point; value: string };

type ClosedHandles = {
  corners: Point[];
  rotate: Point;
};

type ConnectorHandles = {
  start: Point;
  end: Point;
  bend: Point;
};

const round = (v: number, d = 100) => Math.round(v * d) / d;
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, [contenteditable="true"]');
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const recognitionInk = ([, s]: StrokeNode): RecognitionInk => ({ id: s.id, points: s.points.map((p) => [s.position.x + p.x, s.position.y + p.y]) });
const sameIdSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id));
const oppositeAnchor = (side: AnchorSide): AnchorSide =>
  side === 'top' ? 'bottom' : side === 'right' ? 'left' : side === 'bottom' ? 'top' : 'right';

function connectorHeadsFromPreset(preset: ConnectorHeadsPreset): { start_head: 'none' | 'arrow'; end_head: 'none' | 'arrow' } {
  if (preset === 'both') return { start_head: 'arrow', end_head: 'arrow' };
  if (preset === 'none') return { start_head: 'none', end_head: 'none' };
  return { start_head: 'none', end_head: 'arrow' };
}

function shapeTextCenter(node: ShapeNode): Point {
  const center = shapeCenter(node);
  const { kind, position, end, rotation = 0, points } = node[1];
  if (kind !== 'triangle') return center;
  const raw =
    points && points.length === 3
      ? {
          x: position.x + (points[0].x + points[1].x + points[2].x) / 3,
          y: position.y + (points[0].y + points[1].y + points[2].y) / 3,
        }
      : { x: center.x, y: position.y + end.y * 0.62 };
  return rotation ? rotatePoint(raw, center, rotation) : raw;
}

function useDarkMode() {
  const query = useMemo(() => window.matchMedia('(prefers-color-scheme: dark)'), []);
  const [dark, setDark] = useState(query.matches);
  useEffect(() => {
    const change = () => setDark(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, [query]);
  return dark;
}

function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0, dpr: window.devicePixelRatio || 1 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio || 1 }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Visual width estimate for the inline editor: CJK glyphs take two `ch`. */
const visualLength = (line: string) => [...line].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);

function closedShapeHandles(node: ShapeNode, zoom: number): ClosedHandles {
  const { position, end, rotation = 0 } = node[1];
  const c = { x: position.x + end.x / 2, y: position.y + end.y / 2 };
  const corners = [
    { x: position.x, y: position.y },
    { x: position.x + end.x, y: position.y },
    { x: position.x + end.x, y: position.y + end.y },
    { x: position.x, y: position.y + end.y },
  ].map((p) => (rotation ? rotatePoint(p, c, rotation) : p));
  const rotRaw = { x: c.x, y: position.y - 22 / zoom };
  const rotate = rotation ? rotatePoint(rotRaw, c, rotation) : rotRaw;
  return { corners, rotate };
}

function resizeClosedShape(base: ShapeNode, corner: number, w: Point): ShapeNode {
  const { position, end, rotation = 0, points } = base[1];
  const oldCenter = { x: position.x + end.x / 2, y: position.y + end.y / 2 };
  const localW = rotation ? rotatePoint(w, oldCenter, -rotation) : w;
  const oppIdx = (corner + 2) % 4;
  const unrotCorners = [
    { x: position.x, y: position.y },
    { x: position.x + end.x, y: position.y },
    { x: position.x + end.x, y: position.y + end.y },
    { x: position.x, y: position.y + end.y },
  ];
  const oppLocal = unrotCorners[oppIdx];
  const oppWorld = rotation ? rotatePoint(oppLocal, oldCenter, rotation) : oppLocal;

  const newX = Math.min(localW.x, oppLocal.x);
  const newY = Math.min(localW.y, oppLocal.y);
  const newW = Math.max(16, Math.abs(localW.x - oppLocal.x));
  const newH = Math.max(16, Math.abs(localW.y - oppLocal.y));
  const newLocalCenter = { x: newX + newW / 2, y: newY + newH / 2 };
  const newPos =
    rotation
      ? (() => {
          // Keep opposite corner pinned in world space
          const rotOppFromNewCenter = rotatePoint(
            {
              x: corner === 1 || corner === 2 ? -newW / 2 : newW / 2,
              y: corner === 2 || corner === 3 ? -newH / 2 : newH / 2,
            },
            { x: 0, y: 0 },
            rotation,
          );
          const worldCenter = { x: oppWorld.x - rotOppFromNewCenter.x, y: oppWorld.y - rotOppFromNewCenter.y };
          return { x: round(worldCenter.x - newW / 2), y: round(worldCenter.y - newH / 2) };
        })()
      : { x: round(newLocalCenter.x - newW / 2), y: round(newLocalCenter.y - newH / 2) };

  const sx = newW / end.x;
  const sy = newH / end.y;
  const scaledPts = points?.map((p) => ({ x: round(p.x * sx), y: round(p.y * sy) }));
  return [
    'shape',
    {
      ...base[1],
      position: newPos,
      end: { x: round(newW), y: round(newH) },
      ...(scaledPts?.length ? { points: scaledPts } : {}),
    },
  ];
}

export function Canvas({ overlay = false }: { overlay?: boolean }) {
  const base = useSession((s) => s.session?.document);
  const queue = useSession((s) => s.queue);
  const sessionEdit = useSession((s) => s.edit);
  const screenBoard = useOverlayBoard();
  const edit = overlay ? screenBoard.edit : sessionEdit;
  const mainDoc = useMemo(() => optimisticDocument(base ?? EMPTY_DOCUMENT, queue.map((q) => q.action)), [base, queue]);
  const doc = overlay ? screenBoard.document : mainDoc;
  const {
    tool,
    brush,
    shape,
    drawAndHold,
    shapeDrawMode,
    shapeFill,
    shapeRounded,
    connectorRoute,
    connectorHeads,
    connectorDashed,
    color,
    size,
    setColor,
    setSize,
    announce,
    back,
  } = useTools();
  const viewport = useViewport();
  const view = overlay ? { ...viewport, x: 0, y: 0, zoom: 1 } : viewport;
  const dark = useDarkMode();
  const palette = useMemo(
    () => ({
      ink1: cssVar('--ink-1-display'),
      selection: cssVar('--color-selection'),
      selectionFill: cssVar('--color-selection-fill'),
      card: cssVar('--color-surface-solid'),
      text: cssVar('--color-text'),
      laser: cssVar('--ink-laser'),
    }),
    [dark],
  );

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(NO_IDS);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<Rect | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_IDS);
  const [drag, setDrag] = useState<{ ids: ReadonlySet<string>; dx: number; dy: number } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [hwrState, setHwrState] = useState<{
    strokeIds: string[];
    ink: RecognitionInk[];
    candidates: RecognitionCandidate[];
    anchor: Point;
    timing: RecognitionTiming;
    computeMs: number;
  } | null>(null);
  const hwrIdsRef = useRef<string[]>([]);
  const hwrClient = useMemo(
    () =>
      new HandwritingClient(
        recognizeIncrementally,
        (result, ink, timing) => {
          let minX = Infinity,
            minY = Infinity;
          for (const s of ink)
            for (const [x, y] of s.points) {
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
            }
          if (result.candidates.length && Number.isFinite(minX) && Number.isFinite(minY)) {
            setHwrState({
              strokeIds: result.stroke_ids,
              ink,
              candidates: result.candidates,
              anchor: { x: round(minX), y: round(minY) },
              timing,
              computeMs: result.elapsed_ms,
            });
          }
        },
        (error) => {
          setHwrState(null);
          hwrIdsRef.current = [];
          const message = typeof error === 'object' && error && 'message' in error ? String(error.message) : '暂未识别出文字，已保留笔迹。';
          useTools.getState().announce(message);
        },
      ),
    [],
  );
  useEffect(() => () => hwrClient.cancel(), [hwrClient]);
  useLayoutEffect(() => {
    if (hwrState && !overlay) return recordCandidatePresentation(hwrState.timing, hwrState.computeMs);
  }, [hwrState, overlay]);

  const container = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const canvasSize = useElementSize(container);
  const domRectsRef = useRef<Map<string, Rect>>(new Map());
  const gesture = useRef<Gesture | null>(null);
  const handoff = useRef<{ pts: InkPoint[]; style: InkStyle } | null>(null);
  const trails = useRef<LaserSample[][]>([]);
  const hover = useRef<Point | null>(null);
  const connectorHover = useRef<SnapTarget | null>(null);
  const recentAutoRef = useRef<{ id: string; at: number }[]>([]);
  const frame = useRef(0);
  const shapeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editingRef = useRef<Editing | null>(null);
  editingRef.current = editing;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const inkColor = (hex: string) => (hex === INK[0] ? palette.ink1 : hex);

  const shapeOptsForTool = (strokeColor: string): ShapeOptions => ({
    ...(shapeFill ? { fill: strokeColor } : {}),
    ...(shapeRounded ? { corner_radius: DEFAULT_CORNER_RADIUS } : {}),
  });

  const shapePaintOpts = (node: ShapeNode, hideText = false) => ({
    ...(node[1].fill ? { fillColor: inkColor(node[1].fill) } : {}),
    textColor: palette.text,
    ...(hideText ? { hideText: true } : {}),
  });

  const measureDomRects = (): Map<string, Rect> => {
    const map = new Map<string, Rect>();
    const cRect = container.current?.getBoundingClientRect();
    if (!cRect || !container.current) return map;
    for (const el of container.current.querySelectorAll('[data-node-id]')) {
      const id = el.getAttribute('data-node-id');
      if (!id) continue;
      const r = el.getBoundingClientRect();
      map.set(id, {
        x: (r.left - cRect.left - view.x) / view.zoom,
        y: (r.top - cRect.top - view.y) / view.zoom,
        w: r.width / view.zoom,
        h: r.height / view.zoom,
      });
    }
    domRectsRef.current = map;
    return map;
  };

  const nodeWorldBounds = (node: SceneNode): Rect | null => {
    if (isInk(node)) return inkBounds(node, doc, domRectsRef.current);
    return domRectsRef.current.get(node[1].id) ?? getNodeBounds(node, domRectsRef.current);
  };

  const measureSelectionWorldBounds = (ids: ReadonlySet<string>): Rect | null => {
    const rects: Rect[] = [];
    for (const id of ids) {
      const node = doc.nodes[id];
      if (!node) continue;
      const b = nodeWorldBounds(node);
      if (b) rects.push(b);
    }
    return unionRects(rects);
  };

  const isMovedConnector = (n: SceneNode) =>
    !!drag
    && n[0] === 'connector'
    && (drag.ids.has(n[1].id) || (!!n[1].from && drag.ids.has(n[1].from)) || (!!n[1].to && drag.ids.has(n[1].to)));

  useLayoutEffect(() => {
    measureDomRects();
    setSelectionBox(selectedIds.size ? measureSelectionWorldBounds(selectedIds) : null);
  }, [doc, selectedIds, view.x, view.y, view.zoom, canvasSize]);

  const prepare = (canvas: HTMLCanvasElement | null) => {
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return null;
    const { w, h, dpr } = canvasSize;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);
    return ctx;
  };

  // Committed + optimistic ink/shapes/connectors. Connectors behind nodes when attached or clean order: highlighter -> shapes/connectors -> strokes.
  useLayoutEffect(() => {
    measureDomRects();
    const ctx = prepare(sceneRef.current);
    if (!ctx) return;
    const nodes = Object.values(doc.nodes).filter((n) => !hidden.has(n[1].id) && !drag?.ids.has(n[1].id) && !isMovedConnector(n));
    const order = (n: SceneNode) => {
      if (n[0] === 'stroke' && n[1].brush === 'highlighter') return 0;
      if (n[0] === 'connector') return 1;
      if (n[0] === 'shape') return 2;
      return 3;
    };
    for (const node of nodes.sort((a, b) => order(a) - order(b))) {
      if (node[0] === 'stroke') drawStroke(ctx, node, inkColor(node[1].color));
      else if (node[0] === 'shape') {
        const hideText = editing?.kind === 'shape_text' && editing.id === node[1].id;
        drawShape(ctx, node, inkColor(node[1].color), 0, 0, shapePaintOpts(node, hideText));
      } else if (node[0] === 'connector') {
        const hideLabel = editing?.kind === 'connector_label' && editing.id === node[1].id;
        drawConnector(ctx, doc, node, inkColor, domRectsRef.current, null, palette.card, palette.text, hideLabel);
      }
    }
    handoff.current = null;
    requestLive();
  }, [doc, view.x, view.y, view.zoom, canvasSize, hidden, drag, palette, editing?.kind, editing?.id]);

  const drawHandleDot = (ctx: CanvasRenderingContext2D, p: Point, radius: number, active = false, square = false) => {
    ctx.save();
    ctx.fillStyle = active ? palette.selection : palette.card;
    ctx.strokeStyle = palette.selection;
    ctx.lineWidth = 1.5 / view.zoom;
    if (square) {
      ctx.fillRect(p.x - radius, p.y - radius, radius * 2, radius * 2);
      ctx.strokeRect(p.x - radius, p.y - radius, radius * 2, radius * 2);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  };

  const drawQuickNub = (ctx: CanvasRenderingContext2D, p: Point) => {
    const r = 6.5 / view.zoom;
    ctx.save();
    ctx.fillStyle = palette.card;
    ctx.strokeStyle = palette.selection;
    ctx.lineWidth = 1.4 / view.zoom;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const s = 2.6 / view.zoom;
    ctx.beginPath();
    ctx.moveTo(p.x - s, p.y);
    ctx.lineTo(p.x + s, p.y);
    ctx.moveTo(p.x, p.y - s);
    ctx.lineTo(p.x, p.y + s);
    ctx.stroke();
    ctx.restore();
  };

  const buildDraftConnector = (g: Extract<Gesture, { kind: 'connect' }>): ConnectorNode => {
    const heads = connectorHeadsFromPreset(connectorHeads);
    return [
      'connector',
      {
        id: 'preview-connector',
        position: { x: round(g.startAt.x), y: round(g.startAt.y) },
        ...(g.from ? { from: g.from } : { from_point: g.fromPoint ?? g.startAt }),
        ...(g.to ? { to: g.to } : { to_point: g.toPoint }),
        from_anchor: g.fromAnchor,
        to_anchor: g.toAnchor,
        route: connectorRoute,
        start_head: heads.start_head,
        end_head: heads.end_head,
        dashed: connectorDashed,
        width: SIZES[size],
        color: INK[color],
      },
    ];
  };

  const getSingleQuickNubs = (node: SceneNode): { anchor: AnchorSide; point: Point; outward: Point }[] => {
    if (node[0] === 'connector' || node[0] === 'stroke' || (node[0] === 'shape' && !isClosedShape(node[1].kind))) return [];
    const anchors = getConnectableAnchors(node, domRectsRef.current);
    const bounds = nodeWorldBounds(node);
    if (!bounds || !anchors.length) return [];
    const c = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    const offset = 18 / view.zoom;
    return anchors.map(({ anchor, point }) => {
      const dx = point.x - c.x;
      const dy = point.y - c.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      return { anchor, point: { x: point.x + ux * offset, y: point.y + uy * offset }, outward: { x: ux, y: uy } };
    });
  };

  const getConnectorHandles = (node: ConnectorNode): ConnectorHandles | null => {
    const pts = connectorPolyline(doc, node, domRectsRef.current);
    if (pts.length < 2) return null;
    return { start: pts[0], end: pts[pts.length - 1], bend: connectorMidpoint(pts) };
  };

  // Ephemeral layer: live stroke, drag preview, connector preview, selection/editing handles, laser, cursors.
  const drawLive = () => {
    frame.current = 0;
    const ctx = prepare(liveRef.current);
    if (!ctx) return;
    if (handoff.current) drawInk(ctx, handoff.current.pts, handoff.current.style);
    const g = gesture.current;

    if (g?.kind === 'draw') {
      if (g.preview) drawShape(ctx, g.preview, inkColor(g.style.color), 0, 0, shapePaintOpts(g.preview));
      else drawInk(ctx, g.points, { ...g.style, color: inkColor(g.style.color) });
    }
    if (g?.kind === 'shape') {
      const previewShape = makeShape(g.shape, g.start, g.end, g.color, g.width, 'preview', g.shapeOpts);
      drawShape(ctx, previewShape, inkColor(g.color), 0, 0, shapePaintOpts(previewShape));
    }
    if (g?.kind === 'resizeShape' || g?.kind === 'rotateShape' || g?.kind === 'editOpenShape') {
      drawShape(ctx, g.draft, inkColor(g.draft[1].color), 0, 0, shapePaintOpts(g.draft));
    }
    if (g?.kind === 'connect') {
      const preview = buildDraftConnector(g);
      drawConnector(ctx, doc, preview, inkColor, domRectsRef.current, drag, palette.card, palette.text);
    }
    if (g?.kind === 'editConnector') {
      drawConnector(ctx, doc, g.draft, inkColor, domRectsRef.current, drag, palette.card, palette.text);
    }

    if (drag) {
      const draggedNodes = [...drag.ids].map((id) => doc.nodes[id]).filter((n): n is SceneNode => !!n);
      for (const dragged of draggedNodes) {
        if (dragged[0] === 'stroke' && dragged[1].brush === 'highlighter') drawStroke(ctx, dragged, inkColor(dragged[1].color), drag.dx, drag.dy);
      }
      for (const n of Object.values(doc.nodes)) {
        if (isMovedConnector(n)) {
          drawConnector(ctx, doc, n as ConnectorNode, inkColor, domRectsRef.current, drag, palette.card, palette.text);
        }
      }
      for (const dragged of draggedNodes) {
        if (dragged[0] === 'shape') drawShape(ctx, dragged, inkColor(dragged[1].color), drag.dx, drag.dy, shapePaintOpts(dragged));
      }
      for (const dragged of draggedNodes) {
        if (dragged[0] === 'stroke' && dragged[1].brush !== 'highlighter') drawStroke(ctx, dragged, inkColor(dragged[1].color), drag.dx, drag.dy);
      }
    }

    // Highlight snap anchors in connector tool or connector endpoint dragging
    const showSnap = tool === 'connector' || g?.kind === 'connect' || (g?.kind === 'editConnector' && (g.part === 'from' || g.part === 'to'));
    if (showSnap && connectorHover.current) {
      const targetNode = doc.nodes[connectorHover.current.nodeId];
      if (targetNode) {
        for (const a of getConnectableAnchors(targetNode, domRectsRef.current)) {
          const isActive = a.anchor === connectorHover.current.anchor;
          drawHandleDot(ctx, a.point, (isActive ? 5.5 : 4) / view.zoom, isActive, false);
        }
        if (connectorHover.current.anchor === 'auto') {
          drawHandleDot(ctx, connectorHover.current.point, 5.5 / view.zoom, true, false);
        }
      }
    }

    // Selection highlights & single-object handles
    if (selectedIds.size) {
      const singleId = selectedIds.size === 1 ? [...selectedIds][0] : null;
      const singleNode = singleId ? doc.nodes[singleId] : undefined;

      if (singleNode?.[0] === 'shape' && isClosedShape(singleNode[1].kind) && !drag && !g) {
        const { corners, rotate } = closedShapeHandles(singleNode, view.zoom);
        ctx.save();
        ctx.strokeStyle = palette.selection;
        ctx.lineWidth = 1.5 / view.zoom;
        ctx.setLineDash([5 / view.zoom, 3 / view.zoom]);
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.stroke();
        const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(topMid.x, topMid.y);
        ctx.lineTo(rotate.x, rotate.y);
        ctx.stroke();
        ctx.restore();
        for (const c of corners) drawHandleDot(ctx, c, 3.8 / view.zoom, false, true);
        drawHandleDot(ctx, rotate, 4.5 / view.zoom, false, false);
        if (tool === 'select') {
          for (const nub of getSingleQuickNubs(singleNode)) drawQuickNub(ctx, nub.point);
        }
      } else if (singleNode?.[0] === 'shape' && !isClosedShape(singleNode[1].kind) && !drag && !g) {
        drawHandleDot(ctx, singleNode[1].position, 4.5 / view.zoom, false, false);
        drawHandleDot(ctx, singleNode[1].end, 4.5 / view.zoom, false, false);
        if (singleNode[1].kind === 'curve') drawHandleDot(ctx, curveControlPoint(singleNode), 4 / view.zoom, true, false);
      } else if (singleNode?.[0] === 'connector' && !drag && !g) {
        const ch = getConnectorHandles(singleNode);
        if (ch) {
          drawHandleDot(ctx, ch.start, 4.5 / view.zoom, false, false);
          drawHandleDot(ctx, ch.end, 4.5 / view.zoom, false, false);
          drawHandleDot(ctx, ch.bend, 4 / view.zoom, true, false);
        }
      } else {
        const pad = 4 / view.zoom;
        const memberRects: Rect[] = [];
        for (const id of selectedIds) {
          const node = doc.nodes[id];
          if (!node) continue;
          const b = nodeWorldBounds(node);
          if (!b) continue;
          const off = drag?.ids.has(id) ? drag : { dx: 0, dy: 0 };
          const shifted = { x: b.x + off.dx, y: b.y + off.dy, w: b.w, h: b.h };
          memberRects.push(shifted);
          if (selectedIds.size > 1 && isInk(node)) {
            ctx.save();
            ctx.strokeStyle = palette.selection;
            ctx.globalAlpha = 0.4;
            ctx.lineWidth = 1 / view.zoom;
            ctx.setLineDash([3 / view.zoom, 3 / view.zoom]);
            ctx.strokeRect(shifted.x - pad * 0.5, shifted.y - pad * 0.5, shifted.w + pad, shifted.h + pad);
            ctx.restore();
          }
        }
        const joint = unionRects(memberRects);
        if (joint) {
          const bx = joint.x - pad;
          const by = joint.y - pad;
          const bw = joint.w + pad * 2;
          const bh = joint.h + pad * 2;
          ctx.save();
          ctx.strokeStyle = palette.selection;
          ctx.lineWidth = 1.5 / view.zoom;
          ctx.setLineDash([5 / view.zoom, 3 / view.zoom]);
          ctx.strokeRect(bx, by, bw, bh);
          ctx.restore();
          for (const [cx, cy] of [[bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh]]) {
            drawHandleDot(ctx, { x: cx, y: cy }, 3.2 / view.zoom, false, true);
          }
          if (singleNode && !drag && !g && tool === 'select') {
            for (const nub of getSingleQuickNubs(singleNode)) drawQuickNub(ctx, nub.point);
          }
        }
      }
    }

    if (g?.kind === 'marquee') {
      const r = rectFromPoints(g.start, g.end);
      ctx.save();
      ctx.fillStyle = palette.selectionFill;
      ctx.strokeStyle = palette.selection;
      ctx.lineWidth = 1.5 / view.zoom;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }

    if (g?.kind === 'lasso' && g.points.length >= 2) {
      ctx.save();
      ctx.fillStyle = palette.selectionFill;
      ctx.strokeStyle = palette.selection;
      ctx.lineWidth = 1.75 / view.zoom;
      ctx.setLineDash([5 / view.zoom, 4 / view.zoom]);
      ctx.beginPath();
      ctx.moveTo(g.points[0].x, g.points[0].y);
      for (let i = 1; i < g.points.length; i++) ctx.lineTo(g.points[i].x, g.points[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    const now = performance.now();
    const alive = drawLaser(ctx, trails.current, now, palette.laser, view.zoom);
    trails.current = trails.current.filter((t) => (g?.kind === 'laser' && g.trail === t) || t.some((s) => now - s.t < 1500));
    const h = hover.current;
    if (h && tool === 'laser' && g?.kind !== 'laser') {
      const w = toWorld(view, h.x, h.y);
      ctx.save();
      ctx.fillStyle = palette.laser;
      ctx.shadowColor = palette.laser;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(w.x, w.y, 4 / view.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (h && tool === 'eraser') {
      const w = toWorld(view, h.x, h.y);
      ctx.save();
      ctx.strokeStyle = palette.ink1;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1 / view.zoom;
      ctx.beginPath();
      ctx.arc(w.x, w.y, ERASER_RADIUS / view.zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (alive) requestLive();
  };
  const drawLiveRef = useRef(drawLive);
  drawLiveRef.current = drawLive;
  function requestLive() {
    if (!frame.current) frame.current = requestAnimationFrame(() => drawLiveRef.current());
  }
  useEffect(requestLive, [selectedIds, drag, tool, view, canvasSize, doc, palette, connectorRoute, connectorHeads, connectorDashed]);
  useEffect(() => () => { cancelAnimationFrame(frame.current); clearTimeout(shapeTimer.current); }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = container.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const worldOf = (e: { clientX: number; clientY: number }) => {
    const p = local(e);
    return toWorld(view, p.x, p.y);
  };

  const domNodeAt = (clientX: number, clientY: number) => {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const id = el.closest('[data-node-id]')?.getAttribute('data-node-id');
      if (id) return id;
    }
    return null;
  };
  const inkNodeAt = (w: Point) =>
    Object.values(doc.nodes)
      .reverse()
      .find((n) => isInk(n) && hitInk(n, w, HIT_TOLERANCE / view.zoom, doc, domRectsRef.current))?.[1].id ?? null;

  const commit = (operations: Operation[]) => {
    if (operations.length) void edit({ type: 'edit', operations });
  };

  const commitEditing = () => {
    const ed = editingRef.current;
    if (!ed) return;
    editingRef.current = null;
    setEditing(null);
    const trimmed = ed.value.trim() ? ed.value.replace(/\s+$/, '') : '';

    if (ed.kind === 'shape_text') {
      const existing = doc.nodes[ed.id];
      if (existing?.[0] === 'shape') {
        const cur = existing[1].text ?? '';
        if (trimmed !== cur) {
          const { text: _oldText, ...rest } = existing[1];
          commit([{ type: 'replace', node: ['shape', { ...rest, ...(trimmed ? { text: trimmed } : {}) }] }]);
        }
      }
      return;
    }

    if (ed.kind === 'connector_label') {
      const existing = doc.nodes[ed.id];
      if (existing?.[0] === 'connector') {
        const cur = existing[1].label ?? '';
        if (trimmed !== cur) {
          const { label: _oldLabel, ...rest } = existing[1];
          commit([{ type: 'replace', node: ['connector', { ...rest, ...(trimmed ? { label: trimmed } : {}) }] }]);
        }
      }
      return;
    }

    const kind = looksLikeMath(trimmed) ? 'math_block' : 'paragraph';
    const existing = ed.id ? doc.nodes[ed.id] : undefined;
    const makeNode = (attrs: { id: string; position: Point; source?: SourceRef; group_ids?: string[] }): SceneNode =>
      kind === 'paragraph' ? ['paragraph', attrs, ['text', trimmed]] : ['math_block', { ...attrs, latex: trimmed }];
    if (existing) {
      const current = existing[0] === 'paragraph' ? existing[2][1] : existing[0] === 'math_block' ? existing[1].latex : null;
      if (!trimmed) commit(buildDeleteOps(doc, new Set([existing[1].id])));
      else if (trimmed !== current || existing[0] !== kind) {
        const attrs = existing[1];
        commit([
          {
            type: 'replace',
            node: makeNode({
              id: attrs.id,
              position: attrs.position,
              ...(attrs.source ? { source: attrs.source } : {}),
              ...(attrs.group_ids?.length ? { group_ids: attrs.group_ids } : {}),
            }),
          },
        ]);
      }
    } else if (trimmed) {
      commit([{ type: 'insert', node: makeNode({ id: crypto.randomUUID(), position: { x: round(ed.at.x), y: round(ed.at.y) } }) }]);
    }
    if (useTools.getState().tool === 'text') back();
  };

  const openEditor = (target: string | null, at: Point) => {
    const node = target ? doc.nodes[target] : undefined;
    if (node?.[0] === 'shape' && isClosedShape(node[1].kind)) {
      setEditing({ kind: 'shape_text', id: node[1].id, at: shapeTextCenter(node), value: node[1].text ?? '' });
      setSelectedIds(new Set([node[1].id]));
      return;
    }
    if (node?.[0] === 'connector') {
      const pts = connectorPolyline(doc, node, domRectsRef.current);
      const m = connectorMidpoint(pts);
      setEditing({ kind: 'connector_label', id: node[1].id, at: m, value: node[1].label ?? '' });
      setSelectedIds(new Set([node[1].id]));
      return;
    }
    if (node?.[0] === 'paragraph') setEditing({ kind: 'text_or_math', id: node[1].id, at: node[1].position, value: node[2][1] });
    else if (node?.[0] === 'math_block') setEditing({ kind: 'text_or_math', id: node[1].id, at: node[1].position, value: node[1].latex });
    else setEditing({ kind: 'text_or_math', id: null, at, value: '' });
    setSelectedIds(NO_IDS);
  };

  const updateRangeSelection = (rawHits: string[], additive: boolean, baseSet: ReadonlySet<string>) => {
    const insideActive = activeGroupId && rawHits.every((id) => doc.nodes[id]?.[1].group_ids?.includes(activeGroupId));
    const effGroup = insideActive ? activeGroupId : null;
    if (!insideActive && activeGroupId) setActiveGroupId(null);
    const expanded = expandSelection(doc, rawHits, effGroup);
    const normBase = additive && activeGroupId && !effGroup ? expandSelection(doc, baseSet, null) : baseSet;
    const next = additive ? new Set([...normBase, ...expanded]) : expanded;
    if (!sameIdSet(selectedIdsRef.current, next)) setSelectedIds(next.size ? next : NO_IDS);
  };

  const spawnQuickConnectedNode = (source: SceneNode, side: AnchorSide, outward: Point) => {
    const dist = 132;
    const baseB = nodeWorldBounds(source);
    const w = source[0] === 'shape' && isClosedShape(source[1].kind) ? source[1].end.x : Math.max(120, Math.min(200, baseB?.w ?? 140));
    const h = source[0] === 'shape' && isClosedShape(source[1].kind) ? source[1].end.y : Math.max(64, Math.min(120, baseB?.h ?? 72));
    const center = baseB ? { x: baseB.x + baseB.w / 2, y: baseB.y + baseB.h / 2 } : source[1].position;
    const shiftX = outward.x * ((baseB?.w ?? w) / 2 + dist + w / 2);
    const shiftY = outward.y * ((baseB?.h ?? h) / 2 + dist + h / 2);
    const newId = crypto.randomUUID();
    const newShapeKind: ShapeKind = source[0] === 'shape' && isClosedShape(source[1].kind) ? source[1].kind : 'rectangle';
    const newColor = source[0] === 'shape' ? source[1].color : INK[color];
    const newWidth = source[0] === 'shape' ? source[1].width : SIZES[size];
    const startPt = { x: round(center.x + shiftX - w / 2), y: round(center.y + shiftY - h / 2) };
    const endPt = { x: round(startPt.x + w), y: round(startPt.y + h) };
    const nextNode = makeShape(newShapeKind, startPt, endPt, newColor, newWidth, newId, {
      ...(source[0] === 'shape' && source[1].fill ? { fill: source[1].fill } : shapeFill ? { fill: newColor } : {}),
      ...(newShapeKind === 'rectangle'
        ? source[0] === 'shape' && source[1].corner_radius !== undefined
          ? { corner_radius: source[1].corner_radius }
          : shapeRounded
            ? { corner_radius: DEFAULT_CORNER_RADIUS }
            : {}
        : {}),
    });
    const heads = connectorHeadsFromPreset(connectorHeads);
    const conn: ConnectorNode = [
      'connector',
      {
        id: crypto.randomUUID(),
        position: startPt,
        from: source[1].id,
        to: newId,
        from_anchor: side,
        to_anchor: oppositeAnchor(side),
        route: connectorRoute,
        start_head: heads.start_head,
        end_head: heads.end_head,
        dashed: connectorDashed,
        width: SIZES[size],
        color: INK[color],
      },
    ];
    commit([{ type: 'insert', node: nextNode }, { type: 'insert', node: conn }]);
    setSelectedIds(new Set([newId]));
  };

  const tryStartSingleHandleGesture = (w: Point, pointer: number): boolean => {
    if (selectedIds.size !== 1) return false;
    const id = [...selectedIds][0];
    const node = doc.nodes[id];
    if (!node) return false;
    const hitR = 11 / view.zoom;

    // Edge quick-connect nubs
    if (tool === 'select') {
      for (const nub of getSingleQuickNubs(node)) {
        if (Math.hypot(w.x - nub.point.x, w.y - nub.point.y) <= hitR) {
          gesture.current = {
            kind: 'connect',
            pointer,
            from: node[1].id,
            fromAnchor: nub.anchor,
            toPoint: w,
            toAnchor: 'auto',
            startAt: w,
            moved: false,
            quickNub: nub.anchor,
            sourceNode: node,
          };
          return true;
        }
      }
    }

    if (node[0] === 'shape' && isClosedShape(node[1].kind)) {
      const { corners, rotate } = closedShapeHandles(node, view.zoom);
      if (Math.hypot(w.x - rotate.x, w.y - rotate.y) <= hitR) {
        setHidden(new Set([node[1].id]));
        gesture.current = { kind: 'rotateShape', pointer, base: node, moved: false, draft: node };
        return true;
      }
      for (let i = 0; i < corners.length; i++) {
        if (Math.hypot(w.x - corners[i].x, w.y - corners[i].y) <= hitR) {
          setHidden(new Set([node[1].id]));
          gesture.current = { kind: 'resizeShape', pointer, base: node, corner: i, moved: false, draft: node };
          return true;
        }
      }
    } else if (node[0] === 'shape') {
      const ctrl = node[1].kind === 'curve' ? curveControlPoint(node) : null;
      if (ctrl && Math.hypot(w.x - ctrl.x, w.y - ctrl.y) <= hitR) {
        setHidden(new Set([node[1].id]));
        gesture.current = { kind: 'editOpenShape', pointer, base: node, part: 'ctrl', moved: false, draft: node };
        return true;
      }
      if (Math.hypot(w.x - node[1].position.x, w.y - node[1].position.y) <= hitR) {
        setHidden(new Set([node[1].id]));
        gesture.current = { kind: 'editOpenShape', pointer, base: node, part: 'start', moved: false, draft: node };
        return true;
      }
      if (Math.hypot(w.x - node[1].end.x, w.y - node[1].end.y) <= hitR) {
        setHidden(new Set([node[1].id]));
        gesture.current = { kind: 'editOpenShape', pointer, base: node, part: 'end', moved: false, draft: node };
        return true;
      }
    } else if (node[0] === 'connector') {
      const ch = getConnectorHandles(node);
      if (ch) {
        if (Math.hypot(w.x - ch.start.x, w.y - ch.start.y) <= hitR) {
          setHidden(new Set([node[1].id]));
          gesture.current = { kind: 'editConnector', pointer, base: node, part: 'from', moved: false, draft: node };
          return true;
        }
        if (Math.hypot(w.x - ch.end.x, w.y - ch.end.y) <= hitR) {
          setHidden(new Set([node[1].id]));
          gesture.current = { kind: 'editConnector', pointer, base: node, part: 'to', moved: false, draft: node };
          return true;
        }
        if (Math.hypot(w.x - ch.bend.x, w.y - ch.bend.y) <= hitR) {
          setHidden(new Set([node[1].id]));
          gesture.current = { kind: 'editConnector', pointer, base: node, part: 'bend', moved: false, draft: node };
          return true;
        }
      }
    }
    return false;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return;
    if (useTools.getState().panel) useTools.getState().setPanel(null);
    if (editingRef.current) {
      commitEditing();
      return;
    }
    const w = worldOf(e);
    const pointer = e.pointerId;
    e.currentTarget.setPointerCapture(pointer);
    if (!overlay && (spaceHeld || e.button === 1)) {
      gesture.current = { kind: 'pan', pointer, lastX: e.clientX, lastY: e.clientY };
      setPanning(true);
      return;
    }
    switch (tool) {
      case 'pen':
      case 'highlighter': {
        const hl = tool === 'highlighter';
        const chosenBrush = hl ? 'highlighter' : brush === 'highlighter' ? 'pen' : brush;
        const style: InkStyle = {
          color: INK[color],
          width: SIZES[size] * (hl ? HIGHLIGHTER_SCALE : chosenBrush === 'marker' ? 2.5 : 1),
          brush: chosenBrush,
          opacity: hl ? HIGHLIGHTER_OPACITY : 1,
        };
        const filter = new OneEuroFilter();
        const f = filter.filter(w.x, w.y, 0);
        const pressure = e.pointerType === 'pen' ? Math.min(1, Math.max(0, e.pressure)) : 0.5;
        gesture.current = {
          kind: 'draw',
          pointer,
          style,
          t0: e.timeStamp,
          filter,
          points: [{ ...f, pressure, elapsed_ms: 0 }],
          autoShapeMode: false,
          shapeOpts: shapeOptsForTool(style.color),
        };
        break;
      }
      case 'shape': {
        if (shapeDrawMode === 'preset') {
          gesture.current = {
            kind: 'shape',
            pointer,
            start: w,
            end: w,
            shape,
            color: INK[color],
            width: SIZES[size],
            shapeOpts: shapeOptsForTool(INK[color]),
          };
        } else {
          const style: InkStyle = { color: INK[color], width: SIZES[size], brush: 'pen', opacity: 1 };
          const filter = new OneEuroFilter();
          const f = filter.filter(w.x, w.y, 0);
          const pressure = e.pointerType === 'pen' ? Math.min(1, Math.max(0, e.pressure)) : 0.5;
          gesture.current = {
            kind: 'draw',
            pointer,
            style,
            t0: e.timeStamp,
            filter,
            points: [{ ...f, pressure, elapsed_ms: 0 }],
            autoShapeMode: true,
            shapeOpts: shapeOptsForTool(style.color),
          };
        }
        break;
      }
      case 'connector': {
        const target = findNearestSnapTarget(doc, w, domRectsRef.current, undefined, 22 / view.zoom, 12 / view.zoom);
        connectorHover.current = target;
        gesture.current = {
          kind: 'connect',
          pointer,
          ...(target ? { from: target.nodeId, fromAnchor: target.anchor, startAt: target.point } : { fromPoint: w, fromAnchor: 'center', startAt: w }),
          toPoint: w,
          toAnchor: 'auto',
          moved: false,
        };
        break;
      }
      case 'laser': {
        const trail = [{ ...w, t: performance.now() }];
        trails.current.push(trail);
        gesture.current = { kind: 'laser', pointer, trail };
        break;
      }
      case 'eraser':
        gesture.current = { kind: 'erase', pointer, last: w, hits: new Set() };
        eraseTo(w);
        break;
      case 'select': {
        if (tryStartSingleHandleGesture(w, pointer)) break;
        const hit = domNodeAt(e.clientX, e.clientY) ?? inkNodeAt(w);
        if (hit) {
          const hitNode = doc.nodes[hit];
          const staysInGroup = !!(activeGroupId && hitNode?.[1].group_ids?.includes(activeGroupId));
          const effGroup = staysInGroup ? activeGroupId : null;
          if (!staysInGroup && activeGroupId) setActiveGroupId(null);
          const unit = expandSelection(doc, [hit], effGroup);
          let nextSel: Set<string>;
          if (e.shiftKey) {
            nextSel = staysInGroup ? new Set(selectedIds) : expandSelection(doc, selectedIds, null);
            const allPresent = [...unit].every((sid) => nextSel.has(sid));
            for (const sid of unit) {
              if (allPresent) nextSel.delete(sid);
              else nextSel.add(sid);
            }
            setSelectedIds(nextSel.size ? nextSel : NO_IDS);
          } else if (selectedIds.has(hit)) {
            nextSel = new Set(selectedIds);
          } else {
            nextSel = unit;
            setSelectedIds(nextSel);
          }
          if (nextSel.size) gesture.current = { kind: 'drag', pointer, ids: nextSel, start: w, moved: false };
        } else {
          setActiveGroupId(null);
          const baseSet = e.shiftKey ? expandSelection(doc, selectedIds, null) : NO_IDS;
          if (!e.shiftKey && selectedIds.size) setSelectedIds(NO_IDS);
          setSelecting(true);
          gesture.current = { kind: 'marquee', pointer, start: w, end: w, additive: e.shiftKey, base: baseSet };
        }
        break;
      }
      case 'lasso': {
        if (!e.shiftKey && selectedIds.size && selectionBox && pointInRect(w, expandRect(selectionBox, 6 / view.zoom))) {
          gesture.current = { kind: 'drag', pointer, ids: new Set(selectedIds), start: w, moved: false };
        } else {
          setActiveGroupId(null);
          const baseSet = e.shiftKey ? expandSelection(doc, selectedIds, null) : NO_IDS;
          if (!e.shiftKey && selectedIds.size) setSelectedIds(NO_IDS);
          setSelecting(true);
          gesture.current = { kind: 'lasso', pointer, points: [w], additive: e.shiftKey, base: baseSet };
        }
        break;
      }
      case 'text':
        gesture.current = { kind: 'place', pointer, at: w, target: domNodeAt(e.clientX, e.clientY) };
        break;
    }
    requestLive();
  };

  const eraseTo = (w: Point) => {
    const g = gesture.current;
    if (g?.kind !== 'erase') return;
    let changed = false;
    for (const node of Object.values(doc.nodes)) {
      if (isInk(node) && !g.hits.has(node[1].id) && hitInkSegment(node, g.last, w, ERASER_RADIUS / view.zoom, doc, domRectsRef.current)) {
        g.hits.add(node[1].id);
        changed = true;
      }
    }
    g.last = w;
    if (changed) setHidden(new Set(g.hits));
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    hover.current = local(e);
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) {
      if (tool === 'connector') {
        connectorHover.current = findNearestSnapTarget(doc, worldOf(e), domRectsRef.current, undefined, 22 / view.zoom, 12 / view.zoom);
        requestLive();
      } else if (tool === 'laser' || tool === 'eraser') {
        requestLive();
      }
      return;
    }
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const events = samples.length ? samples : [e.nativeEvent];
    switch (g.kind) {
      case 'draw': {
        // If Goodnotes Hold-and-Adjust is already snapped, drag adjusts size & rotation cleanly!
        if (g.preview && g.holdBase && g.anchorCenter && g.holdPoint) {
          const w = worldOf(e);
          g.preview = adjustSnappedShape(g.holdBase, g.anchorCenter, g.holdPoint, w);
          break;
        }
        const count = g.points.length;
        for (const ev of events) {
          const w = worldOf(ev);
          const prev = g.points[g.points.length - 1];
          const t = Math.max(prev.elapsed_ms, Math.round(ev.timeStamp - g.t0));
          const f = g.filter.filter(w.x, w.y, t);
          if (Math.hypot(f.x - prev.x, f.y - prev.y) * view.zoom < 0.5) continue;
          const pressure = ev.pointerType === 'pen' ? Math.min(1, Math.max(0, ev.pressure)) : 0.5;
          g.points.push({ ...f, pressure, elapsed_ms: t });
        }
        if (g.points.length === count) break;
        clearTimeout(shapeTimer.current);
        g.preview = undefined;
        const canHold = (g.autoShapeMode || drawAndHold) && g.style.brush !== 'highlighter';
        if (canHold) {
          shapeTimer.current = setTimeout(() => {
            if (gesture.current !== g) return;
            const fitted = recognizeShape(g.points.slice(0, 100_000), g.style.color, g.style.width, undefined, g.shapeOpts);
            if (fitted) {
              g.preview = fitted;
              g.holdBase = fitted;
              g.anchorCenter = shapeCenter(fitted);
              const lastPt = g.points[g.points.length - 1];
              g.holdPoint = { x: lastPt.x, y: lastPt.y };
              requestLive();
            }
          }, HOLD_SHAPE_MS);
        }
        break;
      }
      case 'shape':
        g.end = worldOf(e);
        break;
      case 'connect': {
        const w = worldOf(e);
        if (Math.hypot(w.x - g.startAt.x, w.y - g.startAt.y) * view.zoom > 5) g.moved = true;
        const target = findNearestSnapTarget(doc, w, domRectsRef.current, undefined, 22 / view.zoom, 12 / view.zoom);
        const sameEndpoint = target && target.nodeId === g.from && target.anchor === g.fromAnchor;
        connectorHover.current = sameEndpoint ? null : target;
        if (target && !sameEndpoint) {
          g.to = target.nodeId;
          g.toAnchor = target.anchor;
          g.toPoint = target.point;
        } else {
          g.to = undefined;
          g.toAnchor = 'center';
          g.toPoint = w;
        }
        break;
      }
      case 'resizeShape': {
        g.moved = true;
        g.draft = resizeClosedShape(g.base, g.corner, worldOf(e));
        break;
      }
      case 'rotateShape': {
        g.moved = true;
        const w = worldOf(e);
        const c = shapeCenter(g.base);
        let angle = Math.atan2(w.y - c.y, w.x - c.x) + Math.PI / 2;
        while (angle > Math.PI) angle -= Math.PI * 2;
        while (angle < -Math.PI) angle += Math.PI * 2;
        // Snap gently near multiples of 15 degrees
        const snapStep = Math.PI / 12;
        const nearest = Math.round(angle / snapStep) * snapStep;
        if (Math.abs(angle - nearest) < 0.06) angle = nearest;
        if (Math.abs(angle) < 0.06) angle = 0;
        const { rotation: _r, ...rest } = g.base[1];
        g.draft = ['shape', { ...rest, ...(Math.abs(angle) > 1e-4 ? { rotation: round(angle) } : {}) }];
        break;
      }
      case 'editOpenShape': {
        g.moved = true;
        const w = worldOf(e);
        const a = g.base[1];
        if (g.part === 'start') {
          const shiftCtrl =
            a.kind === 'curve' && a.points?.[0]
              ? [{ x: round(a.points[0].x + a.position.x - w.x), y: round(a.points[0].y + a.position.y - w.y) }]
              : a.points;
          g.draft = ['shape', { ...a, position: { x: round(w.x), y: round(w.y) }, ...(shiftCtrl ? { points: shiftCtrl } : {}) }];
        } else if (g.part === 'end') {
          g.draft = ['shape', { ...a, end: { x: round(w.x), y: round(w.y) } }];
        } else if (g.part === 'ctrl') {
          const midX = (a.position.x + a.end.x) / 2;
          const midY = (a.position.y + a.end.y) / 2;
          const ctrlX = 2 * w.x - midX;
          const ctrlY = 2 * w.y - midY;
          g.draft = ['shape', { ...a, points: [{ x: round(ctrlX - a.position.x), y: round(ctrlY - a.position.y) }] }];
        }
        break;
      }
      case 'editConnector': {
        g.moved = true;
        const w = worldOf(e);
        const a = g.base[1];
        if (g.part === 'from' || g.part === 'to') {
          const target = findNearestSnapTarget(doc, w, domRectsRef.current, new Set([a.id]), 22 / view.zoom, 12 / view.zoom);
          connectorHover.current = target;
          const next = { ...a };
          if (g.part === 'from') {
            delete next.from;
            delete next.from_point;
            if (target) {
              next.from = target.nodeId;
              next.from_anchor = target.anchor;
              next.position = { x: round(target.point.x), y: round(target.point.y) };
            } else {
              next.from_point = { x: round(w.x), y: round(w.y) };
              next.from_anchor = 'center';
              next.position = next.from_point;
            }
          } else {
            delete next.to;
            delete next.to_point;
            if (target) {
              next.to = target.nodeId;
              next.to_anchor = target.anchor;
            } else {
              next.to_point = { x: round(w.x), y: round(w.y) };
              next.to_anchor = 'center';
            }
          }
          g.draft = ['connector', next];
        } else {
          g.draft = ['connector', { ...a, waypoints: [{ x: round(w.x), y: round(w.y) }] }];
        }
        break;
      }
      case 'laser':
        for (const ev of events) g.trail.push({ ...worldOf(ev), t: performance.now() });
        break;
      case 'erase':
        for (const ev of events) eraseTo(worldOf(ev));
        break;
      case 'drag': {
        const w = worldOf(e);
        const dx = w.x - g.start.x;
        const dy = w.y - g.start.y;
        if (Math.hypot(dx, dy) * view.zoom > 2) g.moved = true;
        if (g.moved) setDrag({ ids: g.ids, dx, dy });
        break;
      }
      case 'marquee': {
        g.end = worldOf(e);
        const marquee = rectFromPoints(g.start, g.end);
        const rawHits = Object.values(doc.nodes)
          .filter((n) => nodeHitsMarquee(n, marquee, isInk(n) ? null : domRectsRef.current.get(n[1].id), doc, domRectsRef.current))
          .map((n) => n[1].id);
        updateRangeSelection(rawHits, g.additive, g.base);
        break;
      }
      case 'lasso': {
        for (const ev of events) {
          const w = worldOf(ev);
          const last = g.points[g.points.length - 1];
          if (Math.hypot(w.x - last.x, w.y - last.y) * view.zoom >= 4) g.points.push(w);
        }
        const polyBounds = polygonBounds(g.points);
        if (g.points.length >= 3 && polyBounds) {
          const rawHits = Object.values(doc.nodes)
            .filter((n) => nodeHitsLasso(n, g.points, polyBounds, isInk(n) ? null : domRectsRef.current.get(n[1].id), doc, domRectsRef.current))
            .map((n) => n[1].id);
          updateRangeSelection(rawHits, g.additive, g.base);
        }
        break;
      }
      case 'pan':
        view.panBy(e.clientX - g.lastX, e.clientY - g.lastY);
        g.lastX = e.clientX;
        g.lastY = e.clientY;
        break;
      case 'place':
        break;
    }
    requestLive();
  };

  const endGesture = (e: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    gesture.current = null;
    connectorHover.current = null;
    clearTimeout(shapeTimer.current);
    setPanning(false);
    setSelecting(false);
    if (g.kind === 'draw' && !cancelled) commitStroke(g);
    if (g.kind === 'shape' && !cancelled) {
      const dist = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y);
      const created =
        dist > 5
          ? makeShape(g.shape, g.start, g.end, g.color, g.width, crypto.randomUUID(), g.shapeOpts)
          : makeShape(
              g.shape,
              g.start,
              g.shape === 'line' || g.shape === 'arrow' ? { x: g.start.x + 120, y: g.start.y } : { x: g.start.x + 120, y: g.start.y + 80 },
              g.color,
              g.width,
              crypto.randomUUID(),
              g.shapeOpts,
            );
      commit([{ type: 'insert', node: created }]);
      setSelectedIds(new Set([created[1].id]));
    }
    if (g.kind === 'connect' && !cancelled) {
      if (g.quickNub && !g.moved && g.sourceNode) {
        const nub = getSingleQuickNubs(g.sourceNode).find((n) => n.anchor === g.quickNub);
        if (nub) spawnQuickConnectedNode(g.sourceNode, nub.anchor, nub.outward);
      } else if (g.moved || (g.from && g.to && g.from !== g.to)) {
        const heads = connectorHeadsFromPreset(connectorHeads);
        const conn: ConnectorNode = [
          'connector',
          {
            id: crypto.randomUUID(),
            position: { x: round(g.startAt.x), y: round(g.startAt.y) },
            ...(g.from ? { from: g.from } : { from_point: { x: round(g.startAt.x), y: round(g.startAt.y) } }),
            ...(g.to ? { to: g.to } : { to_point: { x: round(g.toPoint.x), y: round(g.toPoint.y) } }),
            from_anchor: g.fromAnchor,
            to_anchor: g.toAnchor,
            route: connectorRoute,
            start_head: heads.start_head,
            end_head: heads.end_head,
            dashed: connectorDashed,
            width: SIZES[size],
            color: INK[color],
          },
        ];
        commit([{ type: 'insert', node: conn }]);
      }
    }
    if (g.kind === 'resizeShape' || g.kind === 'rotateShape' || g.kind === 'editOpenShape' || g.kind === 'editConnector') {
      if (!cancelled && g.moved) commit([{ type: 'replace', node: g.draft }]);
      setHidden(NO_IDS);
    }
    if (g.kind === 'erase') {
      if (!cancelled && g.hits.size) {
        commit(buildDeleteOps(doc, g.hits));
        if ([...g.hits].some((id) => selectedIds.has(id))) {
          const remaining = new Set([...selectedIds].filter((id) => !g.hits.has(id)));
          setSelectedIds(remaining.size ? remaining : NO_IDS);
        }
      }
      setHidden(NO_IDS);
    }
    if (g.kind === 'drag') {
      if (g.moved && drag && !cancelled) commitTranslate(drag.ids, drag.dx, drag.dy);
      setDrag(null);
    }
    if (g.kind === 'lasso' && !cancelled && g.points.length < 3) {
      const hit = domNodeAt(e.clientX, e.clientY) ?? inkNodeAt(g.points[0]);
      if (hit) updateRangeSelection([hit], g.additive, g.base);
    }
    if (g.kind === 'place' && !cancelled) openEditor(g.target, g.at);
    requestLive();
  };

  const commitStroke = (g: Extract<Gesture, { kind: 'draw' }>) => {
    if (g.preview) {
      commit([{ type: 'insert', node: g.preview }]);
      recentAutoRef.current = [];
      return;
    }

    const now = Date.now();
    recentAutoRef.current = recentAutoRef.current.filter((r) => now - r.at <= MULTI_STROKE_WINDOW_MS && !!doc.nodes[r.id]);

    if (g.autoShapeMode) {
      const recognized = recognizeShape(g.points.slice(0, 100_000), g.style.color, g.style.width, undefined, g.shapeOpts);
      if (recognized && recognized[1].kind !== 'line') {
        commit([{ type: 'insert', node: recognized }]);
        recentAutoRef.current = [];
        return;
      }
      const origin = g.points[0];
      const position = { x: round(origin.x), y: round(origin.y) };
      const points = g.points.slice(0, 100_000).map((p) => ({
        x: round(p.x - position.x),
        y: round(p.y - position.y),
        pressure: round(p.pressure, 1000),
        elapsed_ms: p.elapsed_ms,
      }));
      const rawStroke: StrokeNode = ['stroke', { id: crypto.randomUUID(), position, points, width: g.style.width, color: g.style.color }];
      const candidate: StrokeNode | ShapeNode = recognized ?? rawStroke;
      const recentNodes = recentAutoRef.current
        .map((r) => doc.nodes[r.id])
        .filter((n): n is StrokeNode | ShapeNode => n?.[0] === 'stroke' || (n?.[0] === 'shape' && n[1].kind === 'line'));
      const merged = mergeRecentStrokesToShape(recentNodes, candidate, g.shapeOpts);
      if (merged) {
        const ops: Operation[] = [
          ...buildDeleteOps(doc, new Set(merged.replacedIds)),
          { type: 'insert', node: merged.shape },
        ];
        commit(ops);
        recentAutoRef.current = [];
        return;
      }
      if (!recognized) handoff.current = { pts: g.points, style: { ...g.style, color: inkColor(g.style.color) } };
      commit([{ type: 'insert', node: candidate }]);
      recentAutoRef.current.push({ id: candidate[1].id, at: now });
      return;
    }

    const origin = g.points[0];
    const position = { x: round(origin.x), y: round(origin.y) };
    const points = g.points.slice(0, 100_000).map((p) => ({
      x: round(p.x - position.x),
      y: round(p.y - position.y),
      pressure: round(p.pressure, 1000),
      elapsed_ms: p.elapsed_ms,
    }));
    const { color: hex, width, brush, opacity } = g.style;
    const node: StrokeNode = ['stroke', { id: crypto.randomUUID(), position, points, width, color: hex, ...(brush !== 'pen' ? { brush, opacity } : {}) }];
    handoff.current = { pts: g.points, style: { ...g.style, color: inkColor(hex) } };
    commit([{ type: 'insert', node }]);
  };

  const runIncrementalHwr = (nextIds: string[], latestStroke?: StrokeNode, penUpAt?: number) => {
    const strokeNodes: StrokeNode[] = [];
    for (const id of nextIds) {
      const n = id === latestStroke?.[1].id ? latestStroke : doc.nodes[id];
      if (n?.[0] === 'stroke') strokeNodes.push(n);
    }
    if (!strokeNodes.length) {
      hwrClient.cancel();
      hwrIdsRef.current = [];
      setHwrState(null);
      return;
    }
    const validIds = strokeNodes.map((s) => s[1].id);
    hwrIdsRef.current = validIds;
    if (hwrClient.update(strokeNodes.map(recognitionInk), penUpAt)) setHwrState(null);
  };

  const applyHwrCandidate = (text: string) => {
    if (!hwrState || !text.trim()) return;
    const liveStrokeIds = hwrState.strokeIds.filter((id) => doc.nodes[id]?.[0] === 'stroke');
    if (!liveStrokeIds.length) {
      hwrClient.cancel();
      hwrIdsRef.current = [];
      setHwrState(null);
      return;
    }
    if (
      liveStrokeIds.length !== hwrState.strokeIds.length
      || !liveStrokeIds.every((id, i) => {
        const node = doc.nodes[id];
        return node?.[0] === 'stroke' && sameRecognitionInk(recognitionInk(node), hwrState.ink[i]);
      })
    ) {
      runIncrementalHwr(hwrIdsRef.current);
      return;
    }
    const value = text.trim();
    const kind = looksLikeMath(value) ? 'math_block' : 'paragraph';
    const attrs = { id: crypto.randomUUID(), position: hwrState.anchor };
    const node: SceneNode = kind === 'paragraph' ? ['paragraph', attrs, ['text', value]] : ['math_block', { ...attrs, latex: value }];
    const ops: Operation[] = [...buildDeleteOps(doc, new Set(liveStrokeIds)), { type: 'insert', node }];
    hwrClient.cancel();
    hwrIdsRef.current = [];
    setHwrState(null);
    setSelectedIds(NO_IDS);
    commit(ops);
  };

  const dismissHwr = () => {
    hwrClient.cancel();
    hwrIdsRef.current = [];
    setHwrState(null);
  };

  const commitTranslate = (ids: ReadonlySet<string>, dx: number, dy: number) => {
    commit(buildTranslateOps(doc, ids, round(dx), round(dy)));
  };

  const groupSelected = () => {
    if (!canGroupSelection(doc, selectedIds, activeGroupId)) return;
    const ops = buildGroupOps(doc, selectedIds, activeGroupId);
    if (ops.length) {
      commit(ops);
      announce('已组合');
    }
  };

  const ungroupSelected = () => {
    if (!canUngroupSelection(doc, selectedIds, activeGroupId)) return;
    const ops = buildUngroupOps(doc, selectedIds, activeGroupId);
    if (ops.length) {
      commit(ops);
      announce('已取消组合');
    }
  };

  const duplicateSelected = () => {
    const { ops, newIds } = buildDuplicateOps(doc, selectedIds);
    if (ops.length) {
      commit(ops);
      setActiveGroupId(null);
      setSelectedIds(new Set(newIds));
      announce('已复制');
    }
  };

  const deleteSelected = () => {
    const ops = buildDeleteOps(doc, selectedIds);
    if (ops.length) {
      commit(ops);
      setSelectedIds(NO_IDS);
    }
  };

  const normalizeSelected = () => {
    const res = buildNormalizeOps(doc, selectedIds, shapeOptsForTool);
    if (res.ops.length) {
      commit(res.ops);
      if (res.nextSelected) setSelectedIds(new Set([res.nextSelected]));
      if (res.label) announce(`已规整为${res.label}`);
    } else {
      announce('未识别到可规整的几何形状');
    }
  };

  const recognizeSelected = () => {
    const ids = Object.values(doc.nodes)
      .filter((n): n is StrokeNode => n[0] === 'stroke' && selectedIds.has(n[1].id))
      .map((n) => n[1].id);
    if (ids.length) runIncrementalHwr(ids);
  };

  const toggleSelectedShapeFill = () => {
    const shapes = selectedNodesList.filter((n): n is ShapeNode => n[0] === 'shape' && isClosedShape(n[1].kind));
    if (!shapes.length) return;
    const allFilled = shapes.every((s) => !!s[1].fill);
    commit(
      shapes.map((s) => {
        const { fill: _f, ...rest } = s[1];
        return { type: 'replace', node: ['shape', { ...rest, ...(!allFilled ? { fill: s[1].color } : {}) }] };
      }),
    );
  };

  const toggleSelectedShapeRounded = () => {
    const rects = selectedNodesList.filter((n): n is ShapeNode => n[0] === 'shape' && n[1].kind === 'rectangle');
    if (!rects.length) return;
    const allRounded = rects.every((r) => (r[1].corner_radius ?? 0) > 0);
    commit(
      rects.map((r) => {
        const { corner_radius: _c, ...rest } = r[1];
        return { type: 'replace', node: ['shape', { ...rest, ...(!allRounded ? { corner_radius: DEFAULT_CORNER_RADIUS } : {}) }] };
      }),
    );
  };

  const cycleSelectedConnectorRoute = () => {
    const conns = selectedNodesList.filter((n): n is ConnectorNode => n[0] === 'connector');
    if (!conns.length) return;
    const order: ConnectorRoute[] = ['straight', 'elbow', 'curve'];
    const next = order[(order.indexOf(conns[0][1].route ?? 'straight') + 1) % order.length];
    commit(conns.map((c) => ({ type: 'replace', node: ['connector', { ...c[1], route: next }] })));
  };

  const cycleSelectedConnectorHeads = () => {
    const conns = selectedNodesList.filter((n): n is ConnectorNode => n[0] === 'connector');
    if (!conns.length) return;
    const cur = conns[0][1];
    const nextHeads =
      cur.start_head === 'arrow' && (cur.end_head ?? 'arrow') === 'arrow'
        ? { start_head: 'none' as const, end_head: 'none' as const }
        : (cur.end_head ?? 'arrow') === 'arrow'
          ? { start_head: 'arrow' as const, end_head: 'arrow' as const }
          : { start_head: 'none' as const, end_head: 'arrow' as const };
    commit(conns.map((c) => ({ type: 'replace', node: ['connector', { ...c[1], ...nextHeads }] })));
  };

  const toggleSelectedConnectorDashed = () => {
    const conns = selectedNodesList.filter((n): n is ConnectorNode => n[0] === 'connector');
    if (!conns.length) return;
    const allDashed = conns.every((c) => !!c[1].dashed);
    commit(conns.map((c) => ({ type: 'replace', node: ['connector', { ...c[1], dashed: !allDashed }] })));
  };

  const editSingleInlineLabel = () => {
    if (selectedNodesList.length !== 1) return;
    const node = selectedNodesList[0];
    openEditor(node[1].id, node[1].position);
  };

  // Trackpad: two-finger scroll pans, pinch (ctrl+wheel in WebKit/Chromium) zooms around the pointer.
  useEffect(() => {
    if (overlay) return;
    const el = container.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const v = useViewport.getState();
      if (e.ctrlKey) v.zoomAt(p.x, p.y, v.zoom * Math.exp(-e.deltaY * 0.01));
      else v.panBy(-e.deltaX, -e.deltaY);
    };
    let startZoom = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      startZoom = useViewport.getState().zoom;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const p = local(g);
      useViewport.getState().zoomAt(p.x, p.y, startZoom * g.scale);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
    };
  }, []);

  // Keyboard: single-key tools never fire while typing or composing (IME).
  const keyState = useRef({ selectedIds, activeGroupId, doc, edit });
  keyState.current = { selectedIds, activeGroupId, doc, edit };
  const actionsRef = useRef({ groupSelected, ungroupSelected, duplicateSelected, deleteSelected, editSingleInlineLabel });
  actionsRef.current = { groupSelected, ungroupSelected, duplicateSelected, deleteSelected, editSingleInlineLabel };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      const session = useSession.getState();
      if (e.metaKey) {
        if (k === 'z') {
          e.preventDefault();
          if (overlay || (e.shiftKey ? canRedo(session) : canUndo(session))) void keyState.current.edit({ type: e.shiftKey ? 'redo' : 'undo' });
        } else if (k === 'g') {
          e.preventDefault();
          if (e.shiftKey) actionsRef.current.ungroupSelected();
          else actionsRef.current.groupSelected();
        } else if (k === 'd' && keyState.current.selectedIds.size) {
          e.preventDefault();
          actionsRef.current.duplicateSelected();
        } else if (k === 'a') {
          e.preventDefault();
          const allIds = Object.values(keyState.current.doc.nodes).map((n) => n[1].id);
          setActiveGroupId(null);
          setSelectedIds(allIds.length ? new Set(allIds) : NO_IDS);
        } else if (!overlay && k === '0') {
          e.preventDefault();
          useViewport.getState().reset();
        } else if (!overlay && (k === '=' || k === '+' || k === '-')) {
          e.preventDefault();
          const v = useViewport.getState();
          const r = container.current?.getBoundingClientRect();
          v.zoomAt((r?.width ?? 0) / 2, (r?.height ?? 0) / 2, v.zoom * (k === '-' ? 1 / 1.25 : 1.25));
        }
        return;
      }
      if (e.ctrlKey || e.altKey) return;
      if (overlay && e.key === '\\') { e.preventDefault(); useOverlay.getState().setPeekThrough(true); return; }
      if (!overlay && k === ' ') {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      const tools = useTools.getState();
      if (KEY_TOOLS[k]) {
        tools.setPanel(null);
        tools.setTool(KEY_TOOLS[k]);
        announce(TOOL_LABELS[KEY_TOOLS[k]]);
      } else if (k >= '1' && k <= String(INK.length)) {
        const i = Number(k) - 1;
        setColor(i);
        announce(INK_NAMES[i]);
      } else if (k === '[' || k === ']') {
        const next = Math.max(0, Math.min(SIZES.length - 1, tools.size + (k === '[' ? -1 : 1)));
        setSize(next);
        announce(`粗细 · ${SIZE_NAMES[next]}`);
      } else if (k === 'enter' && keyState.current.selectedIds.size === 1) {
        const single = keyState.current.doc.nodes[[...keyState.current.selectedIds][0]];
        if (single && ((single[0] === 'shape' && isClosedShape(single[1].kind)) || single[0] === 'connector' || single[0] === 'paragraph' || single[0] === 'math_block')) {
          e.preventDefault();
          actionsRef.current.editSingleInlineLabel();
        }
      } else if ((k === 'backspace' || k === 'delete') && keyState.current.selectedIds.size) {
        e.preventDefault();
        actionsRef.current.deleteSelected();
      } else if (k === 'escape') {
        if (gesture.current) { gesture.current = null; clearTimeout(shapeTimer.current); setHidden(NO_IDS); setDrag(null); setSelecting(false); requestLive(); }
        else if (keyState.current.activeGroupId) { setActiveGroupId(null); setSelectedIds(NO_IDS); }
        else if (keyState.current.selectedIds.size) setSelectedIds(NO_IDS);
        else if (overlay) void useOverlay.getState().toggle(false);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceHeld(false);
      if (overlay && e.key === '\\') useOverlay.getState().setPeekThrough(false);
    };
    const onBlur = () => { setSpaceHeld(false); if (overlay) useOverlay.getState().setPeekThrough(false); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [announce, setColor, setSize, overlay]);

  useEffect(() => {
    if (selectedIds.size) {
      const live = new Set([...selectedIds].filter((id) => !!doc.nodes[id]));
      if (live.size !== selectedIds.size) setSelectedIds(live.size ? live : NO_IDS);
    }
    if (activeGroupId && !Object.values(doc.nodes).some((n) => n[1].group_ids?.includes(activeGroupId))) {
      setActiveGroupId(null);
    }
    if (hwrIdsRef.current.length) runIncrementalHwr(hwrIdsRef.current);
  }, [doc]);

  useEffect(() => {
    if (!overlay) return;
    let disposed = false;
    const stops: (() => void)[] = [];
    const add = (p: Promise<() => void>) => { void p.then((stop) => (disposed ? stop() : stops.push(stop))).catch(() => undefined); };
    const report = () => {
      const state = useOverlayBoard.getState();
      void emitTo('overlay-toolbar', 'overlay-ink-status', {
        canUndo: !!state.past.length,
        canRedo: !!state.future.length,
        count: Object.keys(state.document.nodes).length,
        selected: keyState.current.selectedIds.size > 0,
      }).catch(() => undefined);
    };
    add(listen('overlay-status-request', report));
    add(
      listen<OverlayCommand>('overlay-edit', ({ payload }) => {
        const state = useOverlayBoard.getState();
        const ids = keyState.current.selectedIds;
        if (payload === 'clear') { state.clear(); setSelectedIds(NO_IDS); setActiveGroupId(null); }
        else if (payload === 'undo' || payload === 'redo') void state.edit({ type: payload });
        else if (ids.size && payload === 'delete') {
          const ops = buildDeleteOps(state.document, ids);
          if (ops.length) void state.edit({ type: 'edit', operations: ops });
          setSelectedIds(NO_IDS);
        } else if (ids.size && payload === 'normalize') {
          const { shapeFill: fill, shapeRounded: rounded } = useTools.getState();
          const res = buildNormalizeOps(state.document, ids, (strokeColor) => ({
            ...(fill ? { fill: strokeColor } : {}),
            ...(rounded ? { corner_radius: DEFAULT_CORNER_RADIUS } : {}),
          }));
          if (res.ops.length) {
            void state.edit({ type: 'edit', operations: res.ops });
            if (res.nextSelected) setSelectedIds(new Set([res.nextSelected]));
            if (res.label) announce(`已规整为${res.label}`);
          } else {
            announce('未识别到可规整的几何形状');
          }
        }
      }),
    );
    const unsubscribe = useOverlayBoard.subscribe(report);
    report();
    return () => { disposed = true; stops.forEach((stop) => stop()); unsubscribe(); };
  }, [overlay, announce]);

  useEffect(() => {
    if (overlay) {
      void emitTo('overlay-toolbar', 'overlay-ink-status', {
        canUndo: !!screenBoard.past.length,
        canRedo: !!screenBoard.future.length,
        count: Object.keys(doc.nodes).length,
        selected: selectedIds.size > 0,
      }).catch(() => undefined);
    }
  }, [overlay, selectedIds, doc, screenBoard.past.length, screenBoard.future.length]);

  const domNodes = Object.values(doc.nodes).filter(isDomNode);
  const isEmpty = Object.keys(doc.nodes).length === 0 && !editing;
  const cursor =
    spaceHeld || panning
      ? panning
        ? 'grabbing'
        : 'grab'
      : tool === 'select'
        ? 'default'
        : tool === 'text'
          ? 'text'
          : tool === 'pen' || tool === 'highlighter' || tool === 'shape' || tool === 'connector' || tool === 'lasso'
            ? 'crosshair'
            : 'none';
  const worldStyle = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` };
  const grid = 24 * view.zoom;
  const editorLines = editing ? editing.value.split('\n') : [];
  const isMathInput = editing?.kind === 'text_or_math' ? looksLikeMath(editing.value) : false;
  const hasInlineMath = editing?.kind === 'text_or_math' && !isMathInput && segmentInlineMath(editing.value).some((s) => s.kind === 'math');
  const isCenteredLabel = editing?.kind === 'shape_text' || editing?.kind === 'connector_label';
  const editorPlaceholder =
    editing?.kind === 'connector_label'
      ? '输入关系标签…'
      : editing?.kind === 'shape_text'
        ? '输入图形文字…'
        : '文字或公式，例如 x \\times 2';

  const editorField = editing ? (
    <textarea
      className={`editor ${isMathInput ? 'editor-math' : isCenteredLabel ? 'editor-inline-label' : 'node-text'}`}
      style={{
        left: 0,
        top: 0,
        width: `${Math.max(8, ...editorLines.map(visualLength)) + 2}ch`,
      }}
      rows={Math.max(1, editorLines.length)}
      value={editing.value}
      placeholder={editorPlaceholder}
      aria-label={editorPlaceholder}
      autoFocus
      maxLength={16000}
      onChange={(e) => setEditing({ ...editing, value: e.target.value })}
      onBlur={commitEditing}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commitEditing();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          editingRef.current = null;
          setEditing(null);
          if (tool === 'text') back();
        }
      }}
    />
  ) : null;

  const selectionScreenBounds: Rect | null = selectionBox
    ? {
        x: selectionBox.x * view.zoom + view.x,
        y: selectionBox.y * view.zoom + view.y,
        w: selectionBox.w * view.zoom,
        h: selectionBox.h * view.zoom,
      }
    : null;
  const selectedNodesList = [...selectedIds].map((id) => doc.nodes[id]).filter((n): n is SceneNode => !!n);
  const canGroup = canGroupSelection(doc, selectedIds, activeGroupId);
  const canUngroup = canUngroupSelection(doc, selectedIds, activeGroupId);
  const canNormalize = selectedNodesList.some((n) => n[0] === 'stroke');
  const canRecognize = selectedNodesList.length > 0 && selectedNodesList.every((n) => n[0] === 'stroke');

  return (
    <div
      ref={container}
      className={`board${overlay ? ' board-overlay' : ''}`}
      style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x}px ${view.y}px`, ...(view.zoom < 0.35 ? { backgroundImage: 'none' } : {}) }}
    >
      <canvas ref={sceneRef} className="layer" style={{ width: canvasSize.w, height: canvasSize.h }} aria-hidden="true" />
      <div className="world" style={worldStyle} aria-label="画布内容">
        {domNodes.map((n) =>
          editing?.kind === 'text_or_math' && editing.id === n[1].id ? null : (
            <NodeView key={n[1].id} node={n} selected={selectedIds.has(n[1].id)} dx={drag?.ids.has(n[1].id) ? drag.dx : 0} dy={drag?.ids.has(n[1].id) ? drag.dy : 0} />
          ),
        )}
      </div>
      <canvas
        ref={liveRef}
        className="layer layer-live"
        style={{ width: canvasSize.w, height: canvasSize.h, cursor }}
        aria-label="书写区域"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endGesture(e, false)}
        onPointerCancel={(e) => endGesture(e, true)}
        onPointerLeave={() => {
          hover.current = null;
          connectorHover.current = null;
          requestLive();
        }}
        onDoubleClick={(e) => {
          if (tool !== 'select' && tool !== 'lasso') return;
          const target = domNodeAt(e.clientX, e.clientY) ?? inkNodeAt(worldOf(e));
          const node = target ? doc.nodes[target] : undefined;
          if (!node) return;
          const nextGroup = visibleGroupId(node, activeGroupId);
          if (nextGroup) {
            setActiveGroupId(nextGroup);
            setSelectedIds(expandSelection(doc, [target!], nextGroup));
            return;
          }
          if (
            node[0] === 'paragraph'
            || node[0] === 'math_block'
            || (node[0] === 'shape' && isClosedShape(node[1].kind))
            || node[0] === 'connector'
          ) {
            openEditor(target, node[1].position);
          }
        }}
      />
      {editing && (
        <div className="world world-editor" style={worldStyle}>
          <div className={`node-edit${isCenteredLabel ? ' is-centered' : ''}`} style={{ left: editing.at.x, top: editing.at.y }}>
            {editorField}
            {isMathInput ? <MathView className="math-preview" source={editing.value} /> : hasInlineMath ? <div className="math-preview"><InlineText text={editing.value} /></div> : null}
          </div>
        </div>
      )}
      {hwrState && !overlay && (
        <div className="hwr-bar" role="region" aria-label="手写识别候选">
          <span className="hwr-label">识别候选</span>
          {hwrState.candidates.map((c, idx) => (
            <button key={c.text} className={idx === 0 ? 'hwr-candidate is-primary' : 'hwr-candidate'} onClick={() => applyHwrCandidate(c.text)}>
              {c.text}
            </button>
          ))}
          <button className="hwr-dismiss" onClick={dismissHwr}>保留笔迹</button>
        </div>
      )}
      {!drag && !selecting && !editing && selectionScreenBounds && selectedNodesList.length > 0 && (
        <SelectionBar
          bounds={selectionScreenBounds}
          canvasSize={canvasSize}
          overlay={overlay}
          nodes={selectedNodesList}
          canGroup={canGroup}
          canUngroup={canUngroup}
          canNormalize={canNormalize}
          canRecognize={canRecognize}
          onGroup={groupSelected}
          onUngroup={ungroupSelected}
          onDuplicate={duplicateSelected}
          onNormalize={normalizeSelected}
          onRecognize={recognizeSelected}
          onToggleShapeFill={toggleSelectedShapeFill}
          onToggleShapeRounded={toggleSelectedShapeRounded}
          onCycleConnectorRoute={cycleSelectedConnectorRoute}
          onCycleConnectorHeads={cycleSelectedConnectorHeads}
          onToggleConnectorDashed={toggleSelectedConnectorDashed}
          onEditInlineLabel={editSingleInlineLabel}
          onDelete={deleteSelected}
        />
      )}
      {isEmpty && !overlay && (
        <p className="empty-hint" aria-live="polite">
          直接落笔开始讲解 · <kbd>C</kbd> 连接线 · <kbd>S</kbd> 图形 · <kbd>T</kbd> 文字 · <kbd>L</kbd> 激光笔
        </p>
      )}
    </div>
  );
}
