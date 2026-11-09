import { create } from 'zustand';
import type { Brush, ShapeKind } from '../ipc/types';

export type Tool = 'select' | 'pen' | 'highlighter' | 'laser' | 'eraser' | 'text' | 'shape';

export const TOOL_LABELS: Record<Tool, string> = {
  select: '选择',
  pen: '画笔',
  highlighter: '荧光笔',
  laser: '激光笔',
  eraser: '橡皮',
  text: '文字',
  shape: '图形',
};

export const TOOL_KEYS: Record<Tool, string> = { select: 'V', pen: 'P', highlighter: 'H', laser: 'L', eraser: 'E', text: 'T', shape: 'S' };

export const BRUSH_NAMES: Record<Brush, string> = { pen: '圆珠笔', pencil: '铅笔', fountain: '钢笔', marker: '记号笔', highlighter: '荧光笔' };

/** Stored ink values. Must match --ink-* tokens; dark canvas remaps INK[0] at render time. */
export const INK = ['#1f2329', '#e5484d', '#2f6fed', '#2b9a66'] as const;
export const INK_NAMES = ['墨黑', '演示红', '演示蓝', '演示绿'] as const;
export const SIZES = [2, 4, 8] as const;
export const SIZE_NAMES = ['细', '中', '粗'] as const;
export const HIGHLIGHTER_SCALE = 4;
export const HIGHLIGHTER_OPACITY = 0.35;

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('coboard-tools-sync') : null;

type ToolState = {
  tool: Tool;
  brush: Brush;
  shape: ShapeKind;
  autoShape: boolean;
  autoRecognize: boolean;
  setBrush: (brush: Brush) => void;
  setShape: (shape: ShapeKind) => void;
  setAutoShape: (value: boolean) => void;
  setAutoRecognize: (value: boolean) => void;
  /** Tool to return to after a one-shot tool (text, formula) finishes. */
  previous: Tool;
  color: number;
  size: number;
  hud: { label: string; at: number } | null;
  /** Open flyout above the toolbar; per-window, so help/backdrop panels can close it. */
  panel: 'brush' | 'shape' | null;
  setPanel: (panel: 'brush' | 'shape' | null) => void;
  setTool: (tool: Tool) => void;
  back: () => void;
  setColor: (index: number) => void;
  setSize: (index: number) => void;
  announce: (label: string) => void;
};

export const useTools = create<ToolState>((set, get) => {
  if (channel) {
    channel.onmessage = (e) => {
      if (e.data?.type === 'request') {
        const { tool, brush, shape, autoShape, autoRecognize, color, size } = get();
        channel.postMessage({ type: 'snapshot', tool, brush, shape, autoShape, autoRecognize, color, size });
        return;
      }
      const data = e.data as { type: string; tool?: Tool; color?: number; size?: number; hud?: { label: string; at: number }; brush?: Brush; shape?: ShapeKind; autoShape?: boolean; autoRecognize?: boolean };
      if (data.type === 'snapshot' && data.tool && data.brush && data.shape && typeof data.color === 'number' && typeof data.size === 'number') {
        set({ tool: data.tool, brush: data.brush, shape: data.shape, autoShape: !!data.autoShape, autoRecognize: !!data.autoRecognize, color: data.color, size: data.size });
      }
      else if (data.type === 'brush' && data.brush) set({ brush: data.brush });
      else if (data.type === 'shape' && data.shape) set({ shape: data.shape });
      else if (data.type === 'autoShape' && typeof data.autoShape === 'boolean') set({ autoShape: data.autoShape });
      else if (data.type === 'autoRecognize' && typeof data.autoRecognize === 'boolean') set({ autoRecognize: data.autoRecognize });
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
    autoShape: false,
    autoRecognize: false,
    setBrush: (brush) => {
      channel?.postMessage({ type: 'brush', brush });
      channel?.postMessage({ type: 'tool', tool: brush === 'highlighter' ? 'highlighter' : 'pen' });
      set({ brush, tool: brush === 'highlighter' ? 'highlighter' : 'pen' });
    },
    setShape: (shape) => {
      channel?.postMessage({ type: 'shape', shape });
      channel?.postMessage({ type: 'tool', tool: 'shape' });
      set({ shape, tool: 'shape' });
    },
    setAutoShape: (autoShape) => { channel?.postMessage({ type: 'autoShape', autoShape }); set({ autoShape }); },
    setAutoRecognize: (autoRecognize) => { channel?.postMessage({ type: 'autoRecognize', autoRecognize }); set({ autoRecognize }); },
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
        const nextTool = ['pen', 'highlighter', 'shape', 'text'].includes(s.tool) ? s.tool : 'pen';
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
