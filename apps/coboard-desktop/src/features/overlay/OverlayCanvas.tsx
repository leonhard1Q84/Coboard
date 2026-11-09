import { Canvas } from '../canvas/Canvas';

/** Screen annotations share all tools and gestures with the document canvas. */
export function OverlayCanvas() {
  return <Canvas overlay />;
}
