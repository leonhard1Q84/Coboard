import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useOverlay } from '../../stores/overlay';

/**
 * While the overlay ignores mouse events the WebView cannot see the pointer, so
 * the native side polls the global cursor and forwards it as `overlay-cursor`.
 * Listening whenever the overlay is visible prevents missing the initial point
 * emitted right as passthrough activates.
 */
export function CursorSpotlight() {
  const visible = useOverlay((s) => s.state.visible);
  const active = useOverlay((s) => s.state.visible && s.state.passthrough);

  useEffect(() => {
    if (!visible) return;
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
  }, [visible]);

  if (!active) return null;
  return (
    <div className="cursor-spot" aria-hidden="true">
      <span className="cursor-spot-ring" />
    </div>
  );
}
