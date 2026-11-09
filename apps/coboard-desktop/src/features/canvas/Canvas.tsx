import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { useOverlayBoard } from '../../stores/overlayBoard';
import { useOverlay, type OverlayCommand } from '../../stores/overlay';
import { makeShape, normalizeStroke, recognizeShape } from './shapes';
import type { InkPoint, Operation, Point, RecognitionCandidate, RecognitionInk, SceneNode, ShapeKind, ShapeNode, SourceRef, StrokeNode } from '../../ipc/types';
import { EMPTY_DOCUMENT, optimisticDocument } from '../../stores/document';
import { canRedo, canUndo, useSession } from '../../stores/session';
import { HIGHLIGHTER_OPACITY, HIGHLIGHTER_SCALE, INK, INK_NAMES, SIZES, SIZE_NAMES, TOOL_LABELS, useTools, type Tool } from '../../stores/tools';
import { toWorld, useViewport } from '../../stores/viewport';
import { hitInk, hitInkSegment, inkBounds, isInk } from './geometry';
import { drawInk, drawLaser, drawShape, drawStroke, OneEuroFilter, type InkStyle, type LaserSample } from './ink';
import { InlineText } from './InlineText';
import { looksLikeMath, segmentInlineMath } from './math';
import { MathView } from './MathView';
import { isDomNode, NodeView } from './NodeView';
import { HandwritingClient, sameRecognitionInk } from './handwritingClient';
import { recognizeIncrementally } from './handwritingTransport';
import { recordCandidatePresentation, type RecognitionTiming } from './handwritingMetrics';

const KEY_TOOLS: Record<string, Tool> = { v: 'select', p: 'pen', h: 'highlighter', l: 'laser', e: 'eraser', t: 'text', s: 'shape' };
const ERASER_RADIUS = 10;
const HIT_TOLERANCE = 6;
const NO_IDS: ReadonlySet<string> = new Set();

type Gesture =
  | { kind: 'draw'; pointer: number; style: InkStyle; t0: number; filter: OneEuroFilter; points: InkPoint[]; preview?: ShapeNode }
  | { kind: 'shape'; pointer: number; start: Point; end: Point; shape: ShapeKind; color: string; width: number }
  | { kind: 'laser'; pointer: number; trail: LaserSample[] }
  | { kind: 'erase'; pointer: number; last: Point; hits: Set<string> }
  | { kind: 'drag'; pointer: number; id: string; start: Point; moved: boolean }
  | { kind: 'pan'; pointer: number; lastX: number; lastY: number }
  | { kind: 'place'; pointer: number; at: Point; target: string | null };

type Editing = { id: string | null; at: Point; value: string };

const round = (v: number, d = 100) => Math.round(v * d) / d;
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, [contenteditable="true"]');
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const recognitionInk = ([, s]: StrokeNode): RecognitionInk => ({ id: s.id, points: s.points.map((p) => [s.position.x + p.x, s.position.y + p.y]) });

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

export function Canvas({ overlay = false }: { overlay?: boolean }) {
  const base = useSession((s) => s.session?.document);
  const queue = useSession((s) => s.queue);
  const sessionEdit = useSession((s) => s.edit);
  const screenBoard = useOverlayBoard();
  const edit = overlay ? screenBoard.edit : sessionEdit;
  const mainDoc = useMemo(() => optimisticDocument(base ?? EMPTY_DOCUMENT, queue.map((q) => q.action)), [base, queue]);
  const doc = overlay ? screenBoard.document : mainDoc;
  const { tool, brush, shape, autoShape, autoRecognize, color, size, setColor, setSize, announce, back } = useTools();
  const viewport = useViewport();
  const view = overlay ? { ...viewport, x: 0, y: 0, zoom: 1 } : viewport;
  const dark = useDarkMode();
  const palette = useMemo(() => ({ ink1: cssVar('--ink-1-display'), selection: cssVar('--color-selection'), laser: cssVar('--ink-laser') }), [dark]);

  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_IDS);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [hwrState, setHwrState] = useState<{ strokeIds: string[]; ink: RecognitionInk[]; candidates: RecognitionCandidate[]; anchor: Point; timing: RecognitionTiming; computeMs: number } | null>(null);
  const hwrIdsRef = useRef<string[]>([]);
  const hwrClient = useMemo(() => new HandwritingClient(recognizeIncrementally, (result, ink, timing) => {
    let minX = Infinity, minY = Infinity;
    for (const s of ink) for (const [x, y] of s.points) { minX = Math.min(minX, x); minY = Math.min(minY, y); }
    if (result.candidates.length && Number.isFinite(minX) && Number.isFinite(minY)) {
      setHwrState({ strokeIds: result.stroke_ids, ink, candidates: result.candidates, anchor: { x: round(minX), y: round(minY) }, timing, computeMs: result.elapsed_ms });
    }
  }, (error) => {
    setHwrState(null);
    // Start the next pen-up from fresh ink after an invalid line or missing
    // model, rather than carrying a permanently failing snapshot forever.
    hwrIdsRef.current = [];
    const message = typeof error === 'object' && error && 'message' in error ? String(error.message) : '暂未识别出文字，已保留笔迹。';
    useTools.getState().announce(message);
  }), []);
  useEffect(() => () => hwrClient.cancel(), [hwrClient]);
  useLayoutEffect(() => {
    if (hwrState && !overlay) return recordCandidatePresentation(hwrState.timing, hwrState.computeMs);
  }, [hwrState, overlay]);

  const container = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const canvasSize = useElementSize(container);
  const gesture = useRef<Gesture | null>(null);
  const handoff = useRef<{ pts: InkPoint[]; style: InkStyle } | null>(null);
  const trails = useRef<LaserSample[][]>([]);
  const hover = useRef<Point | null>(null);
  const frame = useRef(0);
  const shapeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editingRef = useRef<Editing | null>(null);
  editingRef.current = editing;

  const inkColor = (hex: string) => (hex === INK[0] ? palette.ink1 : hex);
  const selectedNode = selected ? doc.nodes[selected] : undefined;

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

  // Committed + optimistic ink. Highlighter goes first so pen ink stays crisp on top.
  useLayoutEffect(() => {
    const ctx = prepare(sceneRef.current);
    if (!ctx) return;
    const nodes = Object.values(doc.nodes).filter((n) => !hidden.has(n[1].id) && n[1].id !== drag?.id);
    const order = (n: SceneNode) => (n[0] === 'stroke' && n[1].brush === 'highlighter' ? 0 : 1);
    for (const node of nodes.sort((a, b) => order(a) - order(b))) {
      if (node[0] === 'stroke') drawStroke(ctx, node, inkColor(node[1].color));
      else if (node[0] === 'shape') drawShape(ctx, node, inkColor(node[1].color));
      else if (node[0] === 'connector') {
        const from = doc.nodes[node[1].from]?.[1].position;
        const to = doc.nodes[node[1].to]?.[1].position;
        if (from && to) {
          ctx.strokeStyle = palette.ink1;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
        }
      }
    }
    handoff.current = null;
    requestLive();
  }, [doc, view.x, view.y, view.zoom, canvasSize, hidden, drag?.id, palette]);

  // Ephemeral layer: live stroke, drag preview, selection, laser, tool cursors.
  const drawLive = () => {
    frame.current = 0;
    const ctx = prepare(liveRef.current);
    if (!ctx) return;
    if (handoff.current) drawInk(ctx, handoff.current.pts, handoff.current.style);
    const g = gesture.current;
    if (g?.kind === 'draw') {
      if (g.preview) drawShape(ctx, g.preview, inkColor(g.style.color));
      else drawInk(ctx, g.points, { ...g.style, color: inkColor(g.style.color) });
    }
    if (g?.kind === 'shape') drawShape(ctx, makeShape(g.shape, g.start, g.end, g.color, g.width, 'preview'), inkColor(g.color));
    const dragged = drag && doc.nodes[drag.id];
    if (dragged && dragged[0] === 'stroke') drawStroke(ctx, dragged, inkColor(dragged[1].color), drag.dx, drag.dy);
    if (dragged && dragged[0] === 'shape') drawShape(ctx, dragged, inkColor(dragged[1].color), drag.dx, drag.dy);
    const bounds = selectedNode && inkBounds(selectedNode);
    if (bounds) {
      const pad = 4 / view.zoom;
      const off = drag?.id === selected ? drag : { dx: 0, dy: 0 };
      ctx.save();
      ctx.strokeStyle = palette.selection;
      ctx.lineWidth = 1.5 / view.zoom;
      ctx.setLineDash([4 / view.zoom, 3 / view.zoom]);
      ctx.strokeRect(bounds.x - pad + off.dx, bounds.y - pad + off.dy, bounds.w + pad * 2, bounds.h + pad * 2);
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
  useEffect(requestLive, [selected, drag, tool, view, canvasSize, doc, palette]);
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
    Object.values(doc.nodes).reverse().find((n) => isInk(n) && hitInk(n, w, HIT_TOLERANCE / view.zoom))?.[1].id ?? null;

  const commit = (operations: Operation[]) => {
    if (operations.length) void edit({ type: 'edit', operations });
  };

  const commitEditing = () => {
    const ed = editingRef.current;
    if (!ed) return;
    editingRef.current = null;
    setEditing(null);
    const value = ed.value.trim() ? ed.value.replace(/\s+$/, '') : '';
    const kind = looksLikeMath(value) ? 'math_block' : 'paragraph';
    const existing = ed.id ? doc.nodes[ed.id] : undefined;
    const makeNode = (attrs: { id: string; position: Point; source?: SourceRef }): SceneNode =>
      kind === 'paragraph' ? ['paragraph', attrs, ['text', value]] : ['math_block', { ...attrs, latex: value }];
    if (existing) {
      const current = existing[0] === 'paragraph' ? existing[2][1] : existing[0] === 'math_block' ? existing[1].latex : null;
      if (!value) commit([{ type: 'delete', id: existing[1].id }]);
      else if (value !== current || existing[0] !== kind) {
        const attrs = existing[1];
        commit([{ type: 'replace', node: makeNode({ id: attrs.id, position: attrs.position, ...(attrs.source ? { source: attrs.source } : {}) }) }]);
      }
    } else if (value) {
      commit([{ type: 'insert', node: makeNode({ id: crypto.randomUUID(), position: { x: round(ed.at.x), y: round(ed.at.y) } }) }]);
    }
    if (useTools.getState().tool === 'text') back();
  };

  const openEditor = (target: string | null, at: Point) => {
    const node = target ? doc.nodes[target] : undefined;
    if (node?.[0] === 'paragraph') setEditing({ id: node[1].id, at: node[1].position, value: node[2][1] });
    else if (node?.[0] === 'math_block') setEditing({ id: node[1].id, at: node[1].position, value: node[1].latex });
    else setEditing({ id: null, at, value: '' });
    setSelected(null);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return;
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
        const style: InkStyle = { color: INK[color], width: SIZES[size] * (hl ? HIGHLIGHTER_SCALE : chosenBrush === 'marker' ? 2.5 : 1), brush: chosenBrush, opacity: hl ? HIGHLIGHTER_OPACITY : 1 };
        const filter = new OneEuroFilter();
        const f = filter.filter(w.x, w.y, 0);
        const pressure = e.pointerType === 'pen' ? Math.min(1, Math.max(0, e.pressure)) : 0.5;
        gesture.current = { kind: 'draw', pointer, style, t0: e.timeStamp, filter, points: [{ ...f, pressure, elapsed_ms: 0 }] };
        break;
      }
      case 'shape':
        gesture.current = { kind: 'shape', pointer, start: w, end: w, shape, color: INK[color], width: SIZES[size] };
        break;
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
        const hit = domNodeAt(e.clientX, e.clientY) ?? inkNodeAt(w);
        setSelected(hit);
        if (hit) gesture.current = { kind: 'drag', pointer, id: hit, start: w, moved: false };
        else if (!overlay) {
          gesture.current = { kind: 'pan', pointer, lastX: e.clientX, lastY: e.clientY };
          setPanning(true);
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
      if (isInk(node) && !g.hits.has(node[1].id) && hitInkSegment(node, g.last, w, ERASER_RADIUS / view.zoom)) {
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
      if (tool === 'laser' || tool === 'eraser') requestLive();
      return;
    }
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const events = samples.length ? samples : [e.nativeEvent];
    switch (g.kind) {
      case 'draw':
        { const count = g.points.length;
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
        if (autoShape && g.style.brush !== 'highlighter') {
          shapeTimer.current = setTimeout(() => {
            if (gesture.current !== g) return;
            g.preview = recognizeShape(g.points.slice(0, 100_000), g.style.color, g.style.width) ?? undefined;
            requestLive();
          }, 600);
        }
        break; }
      case 'shape':
        g.end = worldOf(e);
        break;
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
        if (g.moved) setDrag({ id: g.id, dx, dy });
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
    clearTimeout(shapeTimer.current);
    setPanning(false);
    if (g.kind === 'draw' && !cancelled) commitStroke(g, e.timeStamp);
    if (g.kind === 'shape' && !cancelled && Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) > 3) {
      commit([{ type: 'insert', node: makeShape(g.shape, g.start, g.end, g.color, g.width) }]);
    }
    if (g.kind === 'erase') {
      if (!cancelled) commit([...g.hits].map((id) => ({ type: 'delete', id })));
      if (selected && g.hits.has(selected)) setSelected(null);
      setHidden(NO_IDS);
    }
    if (g.kind === 'drag') {
      if (g.moved && drag && !cancelled) commitMove(drag.id, drag.dx, drag.dy);
      setDrag(null);
    }
    if (g.kind === 'place' && !cancelled) openEditor(g.target, g.at);
    requestLive();
  };

  const commitStroke = (g: Extract<Gesture, { kind: 'draw' }>, penUpAt: number) => {
    if (g.preview) { commit([{ type: 'insert', node: g.preview }]); return; }
    const origin = g.points[0];
    const position = { x: round(origin.x), y: round(origin.y) };
    const points = g.points.slice(0, 100_000).map((p) => ({ x: round(p.x - position.x), y: round(p.y - position.y), pressure: round(p.pressure, 1000), elapsed_ms: p.elapsed_ms }));
    const { color: hex, width, brush, opacity } = g.style;
    const node: StrokeNode = ['stroke', { id: crypto.randomUUID(), position, points, width, color: hex, ...(brush !== 'pen' ? { brush, opacity } : {}) }];
    handoff.current = { pts: g.points, style: { ...g.style, color: inkColor(hex) } };
    commit([{ type: 'insert', node }]);
    if (autoRecognize && brush !== 'highlighter') {
      runIncrementalHwr([...hwrIdsRef.current, node[1].id], node, penUpAt);
    }
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
    if (liveStrokeIds.length !== hwrState.strokeIds.length || !liveStrokeIds.every((id, i) => {
      const node = doc.nodes[id];
      return node?.[0] === 'stroke' && sameRecognitionInk(recognitionInk(node), hwrState.ink[i]);
    })) {
      runIncrementalHwr(hwrIdsRef.current);
      return;
    }
    const value = text.trim();
    const kind = looksLikeMath(value) ? 'math_block' : 'paragraph';
    const attrs = { id: crypto.randomUUID(), position: hwrState.anchor };
    const node: SceneNode = kind === 'paragraph' ? ['paragraph', attrs, ['text', value]] : ['math_block', { ...attrs, latex: value }];
    const ops: Operation[] = [...liveStrokeIds.map((id): Operation => ({ type: 'delete', id })), { type: 'insert', node }];
    hwrClient.cancel();
    hwrIdsRef.current = [];
    setHwrState(null);
    setSelected(null);
    commit(ops);
  };

  const dismissHwr = () => {
    hwrClient.cancel();
    hwrIdsRef.current = [];
    setHwrState(null);
  };

  const commitMove = (id: string, dx: number, dy: number) => {
    const node = doc.nodes[id];
    if (!node) return;
    const { x, y } = node[1].position;
    const position = { x: round(x + dx), y: round(y + dy) };
    if (node[0] === 'shape' && (node[1].kind === 'line' || node[1].kind === 'arrow')) {
      // Line ends are absolute, so a move must translate both points together.
      const end = { x: round(node[1].end.x + dx), y: round(node[1].end.y + dy) };
      commit([{ type: 'replace', node: ['shape', { ...node[1], position, end }] }]);
    } else commit([{ type: 'move', id, position }]);
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
    // Safari-family pinch events; Chromium never fires these.
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
  const keyState = useRef({ selected, doc, edit });
  keyState.current = { selected, doc, edit };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      const session = useSession.getState();
      if (e.metaKey) {
        if (k === 'z') {
          e.preventDefault();
          if (overlay || (e.shiftKey ? canRedo(session) : canUndo(session))) void keyState.current.edit({ type: e.shiftKey ? 'redo' : 'undo' });
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
      } else if ((k === 'backspace' || k === 'delete') && keyState.current.selected) {
        e.preventDefault();
        const id = keyState.current.selected;
        if (keyState.current.doc.nodes[id]) void keyState.current.edit({ type: 'edit', operations: [{ type: 'delete', id }] });
        setSelected(null);
      } else if (k === 'escape') {
        if (gesture.current) { gesture.current = null; clearTimeout(shapeTimer.current); setHidden(NO_IDS); setDrag(null); requestLive(); }
        else if (keyState.current.selected) setSelected(null);
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
    if (selected && !doc.nodes[selected]) setSelected(null);
    if (hwrIdsRef.current.length) runIncrementalHwr(hwrIdsRef.current);
  }, [doc, selected]);

  useEffect(() => {
    if (!autoRecognize && hwrIdsRef.current.length) {
      hwrClient.cancel();
      hwrIdsRef.current = [];
      setHwrState(null);
    }
  }, [autoRecognize]);

  useEffect(() => {
    if (!overlay) return;
    let disposed = false;
    const stops: (() => void)[] = [];
    const add = (p: Promise<() => void>) => { void p.then((stop) => disposed ? stop() : stops.push(stop)).catch(() => undefined); };
    const report = () => {
      const state = useOverlayBoard.getState();
      void emitTo('overlay-toolbar', 'overlay-ink-status', { canUndo: !!state.past.length, canRedo: !!state.future.length, count: Object.keys(state.document.nodes).length, selected: !!keyState.current.selected }).catch(() => undefined);
    };
    add(listen('overlay-status-request', report));
    add(listen<OverlayCommand>('overlay-edit', ({ payload }) => {
      const state = useOverlayBoard.getState();
      const id = keyState.current.selected;
      if (payload === 'clear') { state.clear(); setSelected(null); }
      else if (payload === 'undo' || payload === 'redo') void state.edit({ type: payload });
      else if (id && payload === 'delete') void state.edit({ type: 'edit', operations: [{ type: 'delete', id }] });
      else if (id && payload === 'normalize') {
        const node = state.document.nodes[id];
        const fitted = node?.[0] === 'stroke' ? normalizeStroke(node) : null;
        if (fitted) void state.edit({ type: 'edit', operations: [{ type: 'replace', node: fitted }] });
        else announce('请选择接近直线、矩形或椭圆的笔迹');
      }
    }));
    const unsubscribe = useOverlayBoard.subscribe(report);
    report();
    return () => { disposed = true; stops.forEach((stop) => stop()); unsubscribe(); };
  }, [overlay, announce]);
  useEffect(() => {
    if (overlay) void emitTo('overlay-toolbar', 'overlay-ink-status', { canUndo: !!screenBoard.past.length, canRedo: !!screenBoard.future.length, count: Object.keys(doc.nodes).length, selected: !!selected }).catch(() => undefined);
  }, [overlay, selected, doc, screenBoard.past.length, screenBoard.future.length]);

  const domNodes = Object.values(doc.nodes).filter(isDomNode);
  const isEmpty = Object.keys(doc.nodes).length === 0 && !editing;
  const cursor = spaceHeld || panning ? (panning ? 'grabbing' : 'grab') : tool === 'select' ? 'default' : tool === 'text' ? 'text' : tool === 'pen' || tool === 'highlighter' || tool === 'shape' ? 'crosshair' : 'none';
  const worldStyle = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` };
  const grid = 24 * view.zoom;
  const editorLines = editing ? editing.value.split('\n') : [];
  const isMathInput = editing ? looksLikeMath(editing.value) : false;
  const hasInlineMath = !isMathInput && !!editing && segmentInlineMath(editing.value).some((s) => s.kind === 'math');
  const editorField = editing ? (
    <textarea
      className={`editor ${isMathInput ? 'editor-math' : 'node-text'}`}
      style={{
        left: 0,
        top: 0,
        width: `${Math.max(8, ...editorLines.map(visualLength)) + 2}ch`,
      }}
      rows={Math.max(1, editorLines.length)}
      value={editing.value}
      placeholder="文字或公式，例如 x \times 2"
      aria-label="文字或公式"
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

  return (
    <div
      ref={container}
      className={`board${overlay ? ' board-overlay' : ''}`}
      style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x}px ${view.y}px`, ...(view.zoom < 0.35 ? { backgroundImage: 'none' } : {}) }}
    >
      <canvas ref={sceneRef} className="layer" style={{ width: canvasSize.w, height: canvasSize.h }} aria-hidden="true" />
      <div className="world" style={worldStyle} aria-label="画布内容">
        {domNodes.map((n) =>
          editing?.id === n[1].id ? null : (
            <NodeView key={n[1].id} node={n} selected={selected === n[1].id} dx={drag?.id === n[1].id ? drag.dx : 0} dy={drag?.id === n[1].id ? drag.dy : 0} />
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
          requestLive();
        }}
        onDoubleClick={(e) => {
          if (tool !== 'select') return;
          const target = domNodeAt(e.clientX, e.clientY);
          const node = target ? doc.nodes[target] : undefined;
          if (node?.[0] === 'paragraph' || node?.[0] === 'math_block') openEditor(target, node[1].position);
        }}
      />
      {editing && (
        <div className="world world-editor" style={worldStyle}>
          <div className="node-edit" style={{ left: editing.at.x, top: editing.at.y }}>
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
      {selectedNode && !overlay && <div className="selection-actions">{selectedNode[0] === 'stroke' && <><button onClick={() => { const fitted = normalizeStroke(selectedNode); if (fitted) commit([{ type: 'replace', node: fitted }]); else announce('这笔不接近直线、矩形或椭圆'); }}>规整为图形</button><button onClick={() => runIncrementalHwr([selectedNode[1].id], selectedNode)}>识别为文字</button></>}<button onClick={() => commit([{ type: 'delete', id: selectedNode[1].id }])}>删除</button></div>}
      {isEmpty && !overlay && (
        <p className="empty-hint" aria-live="polite">
          直接落笔开始讲解 · <kbd>T</kbd> 文字 · <kbd>L</kbd> 激光笔 · <kbd>H</kbd> 荧光笔
        </p>
      )}
    </div>
  );
}
