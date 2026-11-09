import { beforeEach, expect, it } from 'vitest';
import { EMPTY_DOCUMENT } from './document';
import { useOverlayBoard } from './overlayBoard';

beforeEach(() => useOverlayBoard.setState({ document: EMPTY_DOCUMENT, past: [], future: [] }));
it('treats erase and clear as transactions and restores all content through undo/redo', async () => {
  const edit = useOverlayBoard.getState().edit;
  await edit({ type: 'edit', operations: ['a', 'b'].map((id) => ({ type: 'insert', node: ['paragraph', { id, position: { x: 0, y: 0 } }, ['text', id]] })) });
  await edit({ type: 'edit', operations: [{ type: 'delete', id: 'a' }, { type: 'delete', id: 'b' }] });
  expect(Object.keys(useOverlayBoard.getState().document.nodes)).toHaveLength(0);
  await edit({ type: 'undo' });
  expect(Object.keys(useOverlayBoard.getState().document.nodes)).toEqual(['a', 'b']);
  useOverlayBoard.getState().clear();
  await edit({ type: 'undo' });
  expect(Object.keys(useOverlayBoard.getState().document.nodes)).toHaveLength(2);
  await edit({ type: 'redo' });
  expect(Object.keys(useOverlayBoard.getState().document.nodes)).toHaveLength(0);
});
it('invalidates redo after a new edit', async () => {
  const edit = useOverlayBoard.getState().edit;
  await edit({ type: 'edit', operations: [{ type: 'rename', title: 'a' }] });
  await edit({ type: 'undo' });
  await edit({ type: 'edit', operations: [{ type: 'rename', title: 'b' }] });
  expect(await edit({ type: 'redo' })).toBe(false);
  expect(useOverlayBoard.getState().document.title).toBe('b');
});
