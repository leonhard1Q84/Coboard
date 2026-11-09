import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useSession } from './session';
import { optimisticDocument } from './document';
import type { EditRequest, SessionView } from '../ipc/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const session = (revision = 0): SessionView => ({
  document: { schema_version: 1, id: 'doc', title: 'test', revision, nodes: {} },
  package_path: '/test.coboard',
  can_undo: false,
  can_redo: false,
  recovery: { snapshot_revision: 0, replayed_updates: 0, elapsed_ms: 0, missing_assets: [] },
  gateway: null,
  gateway_unavailable: true,
});
const sent = (call: number) => (vi.mocked(invoke).mock.calls[call][1] as { request: EditRequest }).request;

beforeEach(() => {
  vi.resetAllMocks();
  useSession.setState({ session: session(), status: 'saved', error: null, rejected: null, queue: [] });
});

describe('durable document state', () => {
  it('keeps failed requests and retries the exact id and revision', async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: 'disk_full', message: 'full' }).mockResolvedValueOnce(session(1));
    const success = await useSession.getState().edit({ type: 'edit', operations: [{ type: 'rename', title: 'new' }] });
    expect(success).toBe(false);
    expect(useSession.getState().session?.document.revision).toBe(0);
    expect(useSession.getState().queue).toHaveLength(1);
    expect(await useSession.getState().retry()).toBe(true);
    expect(sent(1)).toEqual(sent(0));
    expect(useSession.getState().status).toBe('saved');
    expect(useSession.getState().queue).toHaveLength(0);
  });

  it('does not claim saved until IPC resolves and serializes overlapping edits', async () => {
    let complete!: (value: SessionView) => void;
    vi.mocked(invoke)
      .mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }))
      .mockResolvedValueOnce(session(2));
    const first = useSession.getState().edit({ type: 'undo' });
    expect(useSession.getState().status).toBe('saving');
    const second = useSession.getState().edit({ type: 'redo' });
    expect(invoke).toHaveBeenCalledTimes(1);
    complete(session(1));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(sent(1).expected_revision).toBe(1);
    expect(useSession.getState().status).toBe('saved');
  });

  it('drops deterministically rejected edits without blocking later ones', async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: 'invalid_edit', message: 'bad' }).mockResolvedValueOnce(session(1));
    const bad = useSession.getState().edit({ type: 'redo' });
    const good = useSession.getState().edit({ type: 'edit', operations: [{ type: 'rename', title: 'ok' }] });
    expect(await bad).toBe(false);
    expect(await good).toBe(true);
    expect(useSession.getState().rejected?.code).toBe('invalid_edit');
    expect(useSession.getState().status).toBe('saved');
  });

  it('accepts drawing before the session is ready and flushes after load', async () => {
    useSession.setState({ session: null, status: 'loading' });
    vi.mocked(invoke).mockResolvedValueOnce(session(0)).mockResolvedValueOnce(session(1));
    const stroke = useSession.getState().edit({ type: 'edit', operations: [{ type: 'rename', title: 'early' }] });
    expect(invoke).not.toHaveBeenCalled();
    await useSession.getState().load();
    expect(await stroke).toBe(true);
    expect(sent(1).expected_revision).toBe(0);
  });
});

describe('optimistic view', () => {
  it('shows queued inserts, moves and deletes before confirmation', () => {
    const base = session().document;
    const node = ['paragraph', { id: 'a', position: { x: 0, y: 0 } }, ['text', 'hi']] as const;
    const doc = optimisticDocument(base, [
      { type: 'edit', operations: [{ type: 'insert', node: [...node] as never }] },
      { type: 'edit', operations: [{ type: 'move', id: 'a', position: { x: 5, y: 6 } }] },
    ]);
    expect(doc.nodes.a[1].position).toEqual({ x: 5, y: 6 });
    expect(optimisticDocument(doc, [{ type: 'edit', operations: [{ type: 'delete', id: 'a' }] }]).nodes.a).toBeUndefined();
    expect(base.nodes.a).toBeUndefined();
  });
});
