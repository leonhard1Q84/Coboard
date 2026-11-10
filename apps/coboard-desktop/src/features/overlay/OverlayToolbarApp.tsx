import { useEffect, useLayoutEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useOverlay } from '../../stores/overlay';
import { OverlayToolbar } from './OverlayToolbar';
import { ModeHud } from '../chrome/ModeHud';

export function OverlayToolbarApp() {
  const load = useOverlay((s) => s.load);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { void load(); }, [load]);

  // Measure the toolbar plus any open popover/toast so the native window wraps only visible controls.
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const syncSize = () => {
      const rect = element.getBoundingClientRect();
      let minLeft = rect.left;
      let maxRight = rect.right;
      let minTop = rect.top;
      let maxBottom = rect.bottom;
      for (const node of element.querySelectorAll('.popover-card, .screen-toast, .screen-error')) {
        const r = node.getBoundingClientRect();
        minLeft = Math.min(minLeft, r.left);
        maxRight = Math.max(maxRight, r.right);
        minTop = Math.min(minTop, r.top);
        maxBottom = Math.max(maxBottom, r.bottom);
      }
      const width = Math.ceil(maxRight - minLeft + 24);
      const height = Math.ceil(maxBottom - minTop + 24);
      void invoke('resize_overlay_toolbar', { width, height }).catch(() => undefined);
    };
    const resize = new ResizeObserver(syncSize);
    resize.observe(element);
    const mutations = new MutationObserver(() => requestAnimationFrame(syncSize));
    mutations.observe(element, { childList: true, subtree: true });
    syncSize();
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, []);

  return (
    <div className="overlay-toolbar-window-root">
      <div ref={content} className="overlay-toolbar-content">
        <OverlayToolbar />
      </div>
      <ModeHud />
    </div>
  );
}
