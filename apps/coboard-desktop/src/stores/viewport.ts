import { create } from 'zustand';
import type { Point } from '../ipc/types';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
const ORIGIN = { x: 96, y: 96 };

type ViewportState = {
  x: number;
  y: number;
  zoom: number;
  panBy: (dx: number, dy: number) => void;
  /** Zooms keeping the screen point (cx, cy) fixed over the same canvas point. */
  zoomAt: (cx: number, cy: number, zoom: number) => void;
  reset: () => void;
};

export const useViewport = create<ViewportState>((set) => ({
  ...ORIGIN,
  zoom: 1,
  panBy: (dx, dy) => set((s) => ({ x: s.x + dx, y: s.y + dy })),
  zoomAt: (cx, cy, target) =>
    set((s) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target));
      return { zoom, x: cx - ((cx - s.x) * zoom) / s.zoom, y: cy - ((cy - s.y) * zoom) / s.zoom };
    }),
  reset: () => set({ ...ORIGIN, zoom: 1 }),
}));

export const toWorld = (v: { x: number; y: number; zoom: number }, sx: number, sy: number): Point => ({
  x: (sx - v.x) / v.zoom,
  y: (sy - v.y) / v.zoom,
});
