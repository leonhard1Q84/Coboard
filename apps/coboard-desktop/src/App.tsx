import { useEffect } from 'react';
import { Canvas } from './features/canvas/Canvas';
import { ModeHud, ZoomIndicator } from './features/chrome/ModeHud';
import { Notices } from './features/chrome/Notices';
import { TitleBar } from './features/chrome/TitleBar';
import { Toolbar } from './features/toolbar/Toolbar';
import { useSession } from './stores/session';
import { useOverlay } from './stores/overlay';

export function App() {
  const load = useSession((s) => s.load);
  const overlayLoad = useOverlay((s) => s.load);
  const overlayVisible = useOverlay((s) => s.state.visible);
  // The canvas accepts ink immediately; opening and recovery finish in the background.
  useEffect(() => {
    void load();
    void overlayLoad();
  }, [load, overlayLoad]);
  return (
    <main className="app">
      <Canvas />
      <TitleBar />
      <Notices />
      <ModeHud />
      {!overlayVisible && (
        <div className="dock">
          <Toolbar />
        </div>
      )}
      <ZoomIndicator />
    </main>
  );
}
