import { create } from 'zustand';
import type { Brush, ConnectorRoute, ShapeKind } from '../ipc/types';

export type Tool = 'select' | 'lasso' | 'pen' | 'highlighter' | 'laser' | 'eraser' | 'connector' | 'shape' | 'text';
export type ShapeDrawMode = 'auto' | 'preset';
export type ConnectorHeadsPreset = 'arrow' | 'both' | 'none';
export type ToolPanel = 'brush' | 'shape' | 'connector' | null;

export const TOOL_LABELS: Record<Tool, string> = {
  select: '选择',
  lasso: '套索',
  pen: '画笔',
  highlighter: '荧光笔',
  laser: '激光笔',
  eraser: '橡皮',
  connector: '连接线',
  shape: '图形',
  text: '文字',
};

export const TOOL_KEYS: Record<Tool, string> = {
  select: 'V',
  lasso: 'Q',
  pen: 'P',
  highlighter: 'H',
  laser: 'L',
  eraser: 'E',
  connector: 'C',
  shape: 'S',
  text: 'T',
};

export const BRUSH_NAMES: Record<Brush, string> = {
  pen: '圆珠笔',
  pencil: '铅笔',
  fountain: '钢笔',
  marker: '记号笔',
  highlighter: '荧光笔',
};

/** Stored ink values. Must match --ink-* tokens; dark canvas remaps INK[0] at render time. */
export const INK = ['#1f2329', '#e5484d', '#2f6fed', '#2b9a66'] as const;
export const INK_NAMES = ['墨黑', '演示红', '演示蓝', '演示绿'] as const;
export const SIZES = [2, 4, 8] as const;
export const SIZE_NAMES = ['细', '中', '粗'] as const;
export const HIGHLIGHTER_SCALE = 4;
export const HIGHLIGHTER_OPACITY = 0.35;

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('coboard-tools-sync') : null;

type SyncPayload = {
  type: string;
  tool?: Tool;
  brush?: Brush;
  shape?: ShapeKind;
  drawAndHold?: boolean;
  autoRecognize?: boolean;
  shapeDrawMode?: ShapeDrawMode;
  shapeFill?: boolean;
  shapeRounded?: boolean;
  connectorRoute?: ConnectorRoute;
  connectorHeads?: ConnectorHeadsPreset;
  connectorDashed?: boolean;
  color?: number;
  size?: number;
  hud?: { label: string; at: number };
};

type ToolState = {
  tool: Tool;
  brush: Brush;
  shape: ShapeKind;
  drawAndHold: boolean;
  autoRecognize: boolean;
  shapeDrawMode: ShapeDrawMode;
  shapeFill: boolean;
  shapeRounded: boolean;
  connectorRoute: ConnectorRoute;
  connectorHeads: ConnectorHeadsPreset;
  connectorDashed: boolean;
  setBrush: (brush: Brush) => void;
  setShape: (shape: ShapeKind, mode?: ShapeDrawMode) => void;
  setDrawAndHold: (value: boolean) => void;
  setAutoRecognize: (value: boolean) => void;
  setShapeDrawMode: (mode: ShapeDrawMode) => void;
  setShapeFill: (value: boolean) => void;
  setShapeRounded: (value: boolean) => void;
  setConnectorRoute: (route: ConnectorRoute) => void;
  setConnectorHeads: (heads: ConnectorHeadsPreset) => void;
  setConnectorDashed: (value: boolean) => void;
  /** Tool to return to after a one-shot tool (text) finishes. */
  previous: Tool;
  color: number;
  size: number;
  hud: { label: string; at: number } | null;
  /** Open flyout above the toolbar; per-window, so canvas/backdrop panels can close it. */
  panel: ToolPanel;
  setPanel: (panel: ToolPanel) => void;
  setTool: (tool: Tool) => void;
  back: () => void;
  setColor: (index: number) => void;
  setSize: (index: number) => void;
  announce: (label: string) => void;
};

export const useTools = create<ToolState>((set, get) => {
  if (channel) {
    channel.onmessage = (e) => {
      const data = e.data as SyncPayload | undefined;
      if (!data) return;
      if (data.type === 'request') {
        const {
          tool,
          brush,
          shape,
          drawAndHold,
          autoRecognize,
          shapeDrawMode,
          shapeFill,
          shapeRounded,
          connectorRoute,
          connectorHeads,
          connectorDashed,
          color,
          size,
        } = get();
        channel.postMessage({
          type: 'snapshot',
          tool,
          brush,
          shape,
          drawAndHold,
          autoRecognize,
          shapeDrawMode,
          shapeFill,
          shapeRounded,
          connectorRoute,
          connectorHeads,
          connectorDashed,
          color,
          size,
        });
        return;
      }
      if (data.type === 'snapshot' && data.tool && data.brush && data.shape && typeof data.color === 'number' && typeof data.size === 'number') {
        set({
          tool: data.tool,
          brush: data.brush,
          shape: data.shape,
          drawAndHold: data.drawAndHold ?? true,
          autoRecognize: !!data.autoRecognize,
          shapeDrawMode: data.shapeDrawMode ?? 'auto',
          shapeFill: !!data.shapeFill,
          shapeRounded: data.shapeRounded ?? true,
          connectorRoute: data.connectorRoute ?? 'straight',
          connectorHeads: data.connectorHeads ?? 'arrow',
          connectorDashed: !!data.connectorDashed,
          color: data.color,
          size: data.size,
        });
      } else if (data.type === 'brush' && data.brush) set({ brush: data.brush });
      else if (data.type === 'shape' && data.shape) {
        set({ shape: data.shape, ...(data.shapeDrawMode ? { shapeDrawMode: data.shapeDrawMode } : {}) });
      }
      else if (data.type === 'drawAndHold' && typeof data.drawAndHold === 'boolean') set({ drawAndHold: data.drawAndHold });
      else if (data.type === 'autoRecognize' && typeof data.autoRecognize === 'boolean') set({ autoRecognize: data.autoRecognize });
      else if (data.type === 'shapeDrawMode' && data.shapeDrawMode) set({ shapeDrawMode: data.shapeDrawMode });
      else if (data.type === 'shapeFill' && typeof data.shapeFill === 'boolean') set({ shapeFill: data.shapeFill });
      else if (data.type === 'shapeRounded' && typeof data.shapeRounded === 'boolean') set({ shapeRounded: data.shapeRounded });
      else if (data.type === 'connectorRoute' && data.connectorRoute) set({ connectorRoute: data.connectorRoute });
      else if (data.type === 'connectorHeads' && data.connectorHeads) set({ connectorHeads: data.connectorHeads });
      else if (data.type === 'connectorDashed' && typeof data.connectorDashed === 'boolean') set({ connectorDashed: data.connectorDashed });
      else if (data.type === 'tool' && data.tool) set({ tool: data.tool });
      else if (data.type === 'color' && typeof data.color === 'number') set({ color: data.color });
      else if (data.type === 'size' && typeof data.size === 'number') set({ size: data.size });
      else if (data.type === 'hud' && data.hud) set({ hud: data.hud });
    };
    channel.postMessage({ type: 'request' });
  }

  return {
    tool: 'pen',
    brush: 'pen',
    shape: 'rectangle',
    drawAndHold: true,
    autoRecognize: false,
    shapeDrawMode: 'auto',
    shapeFill: false,
    shapeRounded: true,
    connectorRoute: 'straight',
    connectorHeads: 'arrow',
    connectorDashed: false,
    setBrush: (brush) => {
      const nextTool: Tool = brush === 'highlighter' ? 'highlighter' : 'pen';
      channel?.postMessage({ type: 'brush', brush });
      channel?.postMessage({ type: 'tool', tool: nextTool });
      set({ brush, tool: nextTool });
    },
    setShape: (shape, mode = 'preset') => {
      channel?.postMessage({ type: 'shape', shape, shapeDrawMode: mode });
      channel?.postMessage({ type: 'tool', tool: 'shape' });
      set({ shape, shapeDrawMode: mode, tool: 'shape' });
    },
    setDrawAndHold: (drawAndHold) => {
      channel?.postMessage({ type: 'drawAndHold', drawAndHold });
      set({ drawAndHold });
    },
    setAutoRecognize: (autoRecognize) => {
      channel?.postMessage({ type: 'autoRecognize', autoRecognize });
      set({ autoRecognize });
    },
    setShapeDrawMode: (shapeDrawMode) => {
      channel?.postMessage({ type: 'shapeDrawMode', shapeDrawMode });
      channel?.postMessage({ type: 'tool', tool: 'shape' });
      set({ shapeDrawMode, tool: 'shape' });
    },
    setShapeFill: (shapeFill) => {
      channel?.postMessage({ type: 'shapeFill', shapeFill });
      set({ shapeFill });
    },
    setShapeRounded: (shapeRounded) => {
      channel?.postMessage({ type: 'shapeRounded', shapeRounded });
      set({ shapeRounded });
    },
    setConnectorRoute: (connectorRoute) => {
      channel?.postMessage({ type: 'connectorRoute', connectorRoute });
      channel?.postMessage({ type: 'tool', tool: 'connector' });
      set({ connectorRoute, tool: 'connector' });
    },
    setConnectorHeads: (connectorHeads) => {
      channel?.postMessage({ type: 'connectorHeads', connectorHeads });
      channel?.postMessage({ type: 'tool', tool: 'connector' });
      set({ connectorHeads, tool: 'connector' });
    },
    setConnectorDashed: (connectorDashed) => {
      channel?.postMessage({ type: 'connectorDashed', connectorDashed });
      set({ connectorDashed });
    },
    previous: 'pen',
    color: 0,
    size: 1,
    hud: null,
    panel: null,
    setPanel: (panel) => set({ panel }),
    setTool: (tool) =>
      set((s) => {
        if (s.tool === tool) return s;
        channel?.postMessage({ type: 'tool', tool });
        return { tool, previous: s.tool === 'text' ? s.previous : s.tool };
      }),
    back: () =>
      set((s) => {
        channel?.postMessage({ type: 'tool', tool: s.previous });
        return { tool: s.previous };
      }),
    setColor: (color) =>
      set((s) => {
        const nextTool = ['pen', 'highlighter', 'connector', 'shape', 'text'].includes(s.tool) ? s.tool : 'pen';
        channel?.postMessage({ type: 'color', color });
        channel?.postMessage({ type: 'tool', tool: nextTool });
        return { color, tool: nextTool };
      }),
    setSize: (index) => {
      const size = Math.max(0, Math.min(SIZES.length - 1, index));
      channel?.postMessage({ type: 'size', size });
      set({ size });
    },
    announce: (label) => {
      const hud = { label, at: performance.now() };
      channel?.postMessage({ type: 'hud', hud });
      set({ hud });
    },
  };
});
