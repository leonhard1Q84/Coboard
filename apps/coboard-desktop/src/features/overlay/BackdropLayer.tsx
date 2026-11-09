import type { BackdropConfig } from '../../ipc/types';

/** Native desktop is not part of the WebView backdrop: only actual alpha dimming is exposed.
 *  In passthrough a soft spotlight hole (--spot-x/--spot-y, driven by the native
 *  cursor poller) keeps the area under the real mouse pointer undimmed. */
export function BackdropLayer({ config, passthrough = false }: { config: BackdropConfig; passthrough?: boolean }) {
  return (
    <div
      className={`overlay-backdrop${passthrough ? ' is-passthrough' : ''}`}
      style={{ opacity: config.peek_through ? 0 : config.dim_opacity }}
      aria-hidden="true"
    />
  );
}
