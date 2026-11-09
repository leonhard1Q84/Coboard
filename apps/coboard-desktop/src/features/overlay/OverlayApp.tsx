import { useEffect } from 'react';
import { useOverlay } from '../../stores/overlay';
import { BackdropLayer } from './BackdropLayer';
import { CursorSpotlight } from './CursorSpotlight';
import { OverlayCanvas } from './OverlayCanvas';

export function OverlayApp() {
  const { state, load } = useOverlay();
  useEffect(() => { void load(); }, [load]);
  return <main className="overlay-window-root"><BackdropLayer config={state.backdrop} passthrough={state.passthrough} /><OverlayCanvas /><CursorSpotlight /></main>;
}
