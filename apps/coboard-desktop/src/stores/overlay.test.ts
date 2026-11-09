import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn().mockResolvedValue(undefined), listen: vi.fn().mockResolvedValue(() => undefined) }));
import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { DEFAULT_OVERLAY_STATE, useOverlay } from './overlay';

beforeEach(() => { vi.clearAllMocks(); useOverlay.setState({ state: DEFAULT_OVERLAY_STATE, error: null }); });
describe('honest native overlay state', () => {
  it('only changes mode after native acknowledgement and preserves it on failure', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ...DEFAULT_OVERLAY_STATE, visible: true, passthrough: true });
    await useOverlay.getState().setPassthrough(true);
    expect(useOverlay.getState().state.passthrough).toBe(true);
    vi.mocked(invoke).mockRejectedValueOnce({ message: '窗口不可用' });
    await useOverlay.getState().setPassthrough(false);
    expect(useOverlay.getState().state.passthrough).toBe(true);
    expect(useOverlay.getState().error).toBe('窗口不可用');
  });
  it('resets native transient modes when hiding', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(DEFAULT_OVERLAY_STATE);
    await useOverlay.getState().toggle(false);
    expect(invoke).toHaveBeenCalledWith('toggle_overlay', { visible: false });
    expect(useOverlay.getState().state.visible).toBe(false);
  });
  it('targets editing commands to the overlay canvas without editing the main document', async () => {
    await useOverlay.getState().clearInk();
    expect(emitTo).toHaveBeenCalledWith('overlay', 'overlay-edit', 'clear');
    expect(invoke).not.toHaveBeenCalled();
  });
});
