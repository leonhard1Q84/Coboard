import { useEffect, useLayoutEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useOverlay } from '../../stores/overlay';
import { OverlayToolbar } from './OverlayToolbar';
import { ModeHud } from '../chrome/ModeHud';

export function OverlayToolbarApp() {
  const load = useOverlay((s) => s.load);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { void load(); }, [load]);
  // Match the actual controls, including popovers; avoid invisible regions eating clicks.
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const resize = new ResizeObserver(() => {
      const options = element.querySelector('.tool-options')?.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const extra = options ? Math.max(0, rect.top - options.top) : 0;
      void invoke('resize_overlay_toolbar', { width: Math.ceil(rect.width + 24), height: Math.ceil(rect.height + extra + 24) }).catch(() => undefined);
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  return <div className="overlay-toolbar-window-root"><div ref={content} className="overlay-toolbar-content"><OverlayToolbar /></div><ModeHud /></div>;
}
