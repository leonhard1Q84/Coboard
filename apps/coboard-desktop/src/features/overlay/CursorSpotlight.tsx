import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useOverlay } from '../../stores/overlay';

/**
 * While the overlay ignores mouse events the WebView cannot see the pointer, so
 * the native side polls the global cursor and forwards it as `overlay-cursor`.
 * Coordinates are stored on CSS vars: the backdrop mask punches a hole and the
 * halo dot tracks the exact pointer position.
 */
export function CursorSpotlight() {
  const active = useOverlay((s) => s.state.visible && s.state.passthrough);
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const un = listen<{ x: number; y: number }>('overlay-cursor', ({ payload }) => {
      const d = useOverlay.getState().state.display;
      root.style.setProperty('--spot-x', `${payload.x - d.x}px`);
      root.style.setProperty('--spot-y', `${payload.y - d.y}px`);
    });
    return () => {
      void un.then((off) => off());
      root.style.removeProperty('--spot-x');
      root.style.removeProperty('--spot-y');
    };
  }, [active]);
  if (!active) return null;
  return <div className="cursor-spot" aria-hidden="true" />;
}
