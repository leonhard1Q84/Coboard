import { createRoot } from 'react-dom/client';
import { App } from './App';
import { OverlayApp } from './features/overlay/OverlayApp';
import { OverlayToolbarApp } from './features/overlay/OverlayToolbarApp';
import './styles/tokens.css';
import './styles/app.css';

const params = new URLSearchParams(window.location.search);
const windowKind = params.get('window');

if (windowKind === 'overlay' || windowKind === 'overlay-toolbar') document.documentElement.dataset.surface = 'overlay';

const root = document.getElementById('root');
if (root) {
  if (windowKind === 'overlay') {
    createRoot(root).render(<OverlayApp />);
  } else if (windowKind === 'overlay-toolbar') {
    createRoot(root).render(<OverlayToolbarApp />);
  } else {
    createRoot(root).render(<App />);
  }
}
