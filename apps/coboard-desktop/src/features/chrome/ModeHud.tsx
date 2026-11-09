import { useEffect, useState } from 'react';
import { useTools } from '../../stores/tools';
import { useViewport } from '../../stores/viewport';

/** Large, brief confirmation of a mode change — readable by the presenter at a glance. */
export function ModeHud() {
  const hud = useTools((s) => s.hud);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!hud) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 700);
    return () => clearTimeout(timer);
  }, [hud]);
  return (
    <div className={`hud${visible ? ' is-visible' : ''}`} aria-live="polite">
      {hud?.label}
    </div>
  );
}

export function ZoomIndicator() {
  const zoom = useViewport((s) => s.zoom);
  const reset = useViewport((s) => s.reset);
  return (
    <button className="zoom" title="复位视图 ⌘0" aria-label={`缩放 ${Math.round(zoom * 100)}%，点击复位`} onMouseDown={(e) => e.preventDefault()} onClick={reset}>
      {Math.round(zoom * 100)}%
    </button>
  );
}
