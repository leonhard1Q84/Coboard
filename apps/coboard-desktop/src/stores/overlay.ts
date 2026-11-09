import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import type { BackdropConfig, OverlayState } from '../ipc/types';

export const DEFAULT_BACKDROP: BackdropConfig = { dim_opacity: 0.25, desaturate: 0, blur_px: 0, peek_through: false };
export const DEFAULT_OVERLAY_STATE: OverlayState = {
  visible: false, passthrough: false, backdrop: DEFAULT_BACKDROP,
  display: { x: 0, y: 0, width: 1440, height: 900, scale_factor: 2 },
};
export type OverlayCommand = 'undo' | 'redo' | 'clear' | 'delete' | 'normalize';
export type OverlayInkStatus = { canUndo: boolean; canRedo: boolean; count: number; selected: boolean };
const ink: OverlayInkStatus = { canUndo: false, canRedo: false, count: 0, selected: false };
const message = (error: unknown) => typeof error === 'object' && error && 'message' in error ? String(error.message) : '屏幕控制未完成，请重试。';

type OverlayStore = {
  state: OverlayState;
  ink: OverlayInkStatus;
  initialized: boolean;
  error: string | null;
  load: () => Promise<void>;
  dismissError: () => void;
  toggle: (visible?: boolean) => Promise<void>;
  setPassthrough: (passthrough: boolean) => Promise<void>;
  setBackdrop: (config: Partial<BackdropConfig>) => Promise<void>;
  setPeekThrough: (peek: boolean) => void;
  clearInk: () => Promise<void>;
  command: (command: OverlayCommand) => Promise<void>;
};

export const useOverlay = create<OverlayStore>((set, get) => {
  let listeners: Promise<void> | null = null;
  const init = () => listeners ??= (async () => {
    await listen<string>('overlay-control-error', (event) => set({ error: event.payload }));
    await listen<OverlayState>('overlay-state-changed', (event) => set({ state: event.payload }));
    await listen<OverlayInkStatus>('overlay-ink-status', (event) => set({ ink: event.payload }));
  })().catch((error) => { listeners = null; set({ error: message(error) }); });
  const update = async (command: string, args: Record<string, unknown>) => {
    try { set({ state: await invoke<OverlayState>(command, args), error: null }); }
    catch (error) { set({ error: message(error) }); }
  };
  return {
    state: DEFAULT_OVERLAY_STATE, ink, initialized: false, error: null,
    dismissError: () => set({ error: null }),
    load: async () => {
      await init();
      try { set({ state: await invoke<OverlayState>('get_overlay_state'), initialized: true }); }
      catch (error) { set({ initialized: true, error: message(error) }); }
      try { await emitTo('overlay', 'overlay-status-request'); } catch { /* State error is already shown. */ }
    },
    toggle: (visible) => update('toggle_overlay', { visible }),
    setPassthrough: (passthrough) => update('set_overlay_passthrough', { passthrough }),
    setBackdrop: (patch) => update('set_backdrop_config', { backdrop: { ...get().state.backdrop, ...patch } }),
    setPeekThrough: (peek_through) => {
      const cur = get().state;
      if (cur.backdrop.peek_through !== peek_through) void get().setBackdrop({ peek_through });
    },
    command: async (command) => {
      try { await emitTo('overlay', 'overlay-edit', command); set({ error: null }); }
      catch (error) { set({ error: message(error) }); }
    },
    clearInk: async () => get().command('clear'),
  };
});
