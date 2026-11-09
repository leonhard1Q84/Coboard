import { create } from 'zustand';
import type { Action, Document, SceneNode } from '../ipc/types';
import { EMPTY_DOCUMENT, optimisticDocument } from './document';

const INITIAL: Document = { ...EMPTY_DOCUMENT, id: 'screen-notes', title: '屏幕标注' };
// Screen notes are temporary. Single owner: overlay canvas; toolbar receives status only.
export const useOverlayBoard = create<{
  document: Document;
  past: Document[];
  future: Document[];
  edit: (action: Action) => Promise<boolean>;
  clear: () => void;
}>((set, get) => ({
  document: INITIAL, past: [], future: [],
  edit: async (action) => {
    const { document, past, future } = get();
    if (action.type === 'undo') {
      const previous = past.at(-1);
      if (!previous) return false;
      set({ document: previous, past: past.slice(0, -1), future: [document, ...future].slice(0, 100) });
    } else if (action.type === 'redo') {
      if (!future.length) return false;
      set({ document: future[0], past: [...past, document].slice(-100), future: future.slice(1) });
    } else {
      if (!action.operations.length) return false;
      set({ document: optimisticDocument(document, [action]), past: [...past, document].slice(-100), future: [] });
    }
    return true;
  },
  clear: () => {
    const nodes: SceneNode[] = Object.values(get().document.nodes);
    void get().edit({ type: 'edit', operations: nodes.map((n) => ({ type: 'delete', id: n[1].id })) });
  },
}));
