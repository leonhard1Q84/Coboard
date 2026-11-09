import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Action, ApiError, EditRequest, SessionView } from '../ipc/types';

export type SaveStatus = 'loading' | 'saved' | 'pending' | 'saving' | 'failed';

/** A queued edit. `request` is fixed on first send so retries reuse the exact id and revision. */
export type QueuedEdit = { id: string; action: Action; request: EditRequest | null };

type SessionState = {
  session: SessionView | null;
  status: SaveStatus;
  /** Blocking failure: the queue is paused until retry. */
  error: ApiError | null;
  /** Non-blocking: an edit the core rejected deterministically was dropped; the queue continues. */
  rejected: ApiError | null;
  queue: QueuedEdit[];
  load: () => Promise<void>;
  edit: (action: Action) => Promise<boolean>;
  retry: () => Promise<boolean>;
  dismissRejected: () => void;
};

/** Retrying these cannot succeed; keeping them would block every later edit. */
const REJECTED = new Set(['invalid_edit', 'input_too_large']);

export const canUndo = (s: SessionState) => !!s.session?.can_undo || s.queue.some((q) => q.action.type === 'edit');
export const canRedo = (s: SessionState) => !!s.session?.can_redo && !s.queue.some((q) => q.action.type === 'edit');

function errorOf(error: unknown): ApiError {
  if (typeof error === 'object' && error !== null && 'message' in error && 'code' in error) return error as ApiError;
  return { code: 'ipc_unavailable', message: '未连接本地存储，新内容尚未保存。请通过 Coboard 桌面应用打开后重试。' };
}

const settle = new Map<string, (ok: boolean) => void>();

export const useSession = create<SessionState>((set, get) => {
  let pumping = false;

  // Sends queued edits strictly one at a time. Input never waits on this loop.
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const { queue, session, status } = get();
        const head = queue[0];
        if (!head || !session || status === 'failed' || status === 'loading') break;
        const request = head.request ?? { request_id: head.id, expected_revision: session.document.revision, action: head.action };
        set({ status: 'saving', queue: [{ ...head, request }, ...queue.slice(1)] });
        try {
          const next = await invoke<SessionView>('apply_edit', { request });
          const rest = get().queue.slice(1);
          set({ session: next, queue: rest, status: rest.length ? 'pending' : 'saved', error: null });
          settle.get(head.id)?.(true);
        } catch (raw) {
          const error = errorOf(raw);
          settle.get(head.id)?.(false);
          if (REJECTED.has(error.code)) {
            const rest = get().queue.slice(1);
            set({ queue: rest, rejected: error, status: rest.length ? 'pending' : 'saved' });
            continue;
          }
          set({ status: 'failed', error });
          break;
        } finally {
          settle.delete(head.id);
        }
      }
    } finally {
      pumping = false;
    }
  };

  return {
    session: null,
    status: 'loading',
    error: null,
    rejected: null,
    queue: [],
    dismissRejected: () => set({ rejected: null }),
    load: async () => {
      // Queued edits survive reloads; a sent-but-unconfirmed head is retried with its original id.
      if (get().status === 'saving') return;
      set({ status: 'loading', error: null });
      try {
        const session = await invoke<SessionView>('get_session');
        set({ session, status: get().queue.length ? 'pending' : 'saved' });
        await pump();
      } catch (error) {
        set({ status: 'failed', error: errorOf(error) });
      }
    },
    edit: (action) => {
      const id = crypto.randomUUID();
      const done = new Promise<boolean>((resolve) => settle.set(id, resolve));
      set((s) => ({ queue: [...s.queue, { id, action, request: null }], status: s.status === 'saved' ? 'pending' : s.status }));
      void pump();
      return done;
    },
    retry: async () => {
      const { status, queue, session, error } = get();
      if (status === 'saving') return false;
      if (error?.code === 'revision_conflict' && queue.length) {
        // The base moved: rebuild the head against the reloaded document under a fresh id.
        set({ queue: [{ ...queue[0], id: crypto.randomUUID(), request: null }, ...queue.slice(1)] });
        await get().load();
      } else if (!session) {
        await get().load();
      } else if (queue.length) {
        set({ status: 'pending', error: null });
        await pump();
      } else {
        await get().load();
      }
      return get().status === 'saved';
    },
  };
});
