import type { Action, Document, Operation } from '../ipc/types';

export const EMPTY_DOCUMENT: Document = { schema_version: 1, id: 'local', title: '未命名推导', revision: 0, nodes: {} };

function applyOperation(doc: Document, op: Operation): Document {
  switch (op.type) {
    case 'insert':
    case 'replace':
      return { ...doc, nodes: { ...doc.nodes, [op.node[1].id]: op.node } };
    case 'delete': {
      const { [op.id]: _removed, ...nodes } = doc.nodes;
      return { ...doc, nodes };
    }
    case 'move': {
      const node = doc.nodes[op.id];
      if (!node) return doc;
      const moved = [node[0], { ...node[1], position: op.position }, ...node.slice(2)] as typeof node;
      return { ...doc, nodes: { ...doc.nodes, [op.id]: moved } };
    }
    case 'rename':
      return { ...doc, title: op.title };
  }
}

/** Confirmed document plus queued, not-yet-confirmed edits. Undo/redo show only after confirmation. */
export function optimisticDocument(base: Document, queued: readonly Action[]): Document {
  let doc = base;
  for (const action of queued) {
    if (action.type === 'edit') for (const op of action.operations) doc = applyOperation(doc, op);
  }
  return doc;
}
