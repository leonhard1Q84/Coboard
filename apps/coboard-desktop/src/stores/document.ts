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
    case 'translate': {
      const nodes = { ...doc.nodes };
      for (const id of op.ids) {
        const node = nodes[id];
        if (!node) continue;
        const attrs = {
          ...node[1],
          position: { x: node[1].position.x + op.dx, y: node[1].position.y + op.dy },
        };
        if (node[0] === 'shape' && (node[1].kind === 'line' || node[1].kind === 'arrow' || node[1].kind === 'curve' || node[1].kind === 'wave')) {
          nodes[id] = [
            'shape',
            {
              ...node[1],
              ...attrs,
              end: { x: node[1].end.x + op.dx, y: node[1].end.y + op.dy },
            },
          ];
        } else if (node[0] === 'connector') {
          nodes[id] = [
            'connector',
            {
              ...node[1],
              ...attrs,
              ...(node[1].from_point ? { from_point: { x: node[1].from_point.x + op.dx, y: node[1].from_point.y + op.dy } } : {}),
              ...(node[1].to_point ? { to_point: { x: node[1].to_point.x + op.dx, y: node[1].to_point.y + op.dy } } : {}),
              ...(node[1].waypoints?.length ? { waypoints: node[1].waypoints.map((wp) => ({ x: wp.x + op.dx, y: wp.y + op.dy })) } : {}),
            },
          ];
        } else {
          nodes[id] = [node[0], attrs, ...node.slice(2)] as typeof node;
        }
      }
      return { ...doc, nodes };
    }
    case 'group': {
      const nodes = { ...doc.nodes };
      for (const id of op.node_ids) {
        const node = nodes[id];
        if (!node) continue;
        const prev = node[1].group_ids ?? [];
        if (prev.includes(op.id)) continue;
        nodes[id] = [node[0], { ...node[1], group_ids: [...prev, op.id] }, ...node.slice(2)] as typeof node;
      }
      return { ...doc, nodes };
    }
    case 'ungroup': {
      const nodes = { ...doc.nodes };
      for (const id of op.node_ids) {
        const node = nodes[id];
        if (!node) continue;
        const prev = node[1].group_ids ?? [];
        if (prev[prev.length - 1] !== op.id) continue;
        const nextGroups = prev.slice(0, -1);
        const { group_ids: _old, ...restAttrs } = node[1];
        const attrs = nextGroups.length ? { ...restAttrs, group_ids: nextGroups } : restAttrs;
        nodes[id] = [node[0], attrs, ...node.slice(2)] as typeof node;
      }
      return { ...doc, nodes };
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
