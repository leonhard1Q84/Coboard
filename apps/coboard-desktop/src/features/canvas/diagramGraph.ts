import type { ConnectorRoute, Document, Point, SceneNode, ShapeKind } from '../../ipc/types';

export type SemanticNode = {
  id: string;
  kind: Exclude<SceneNode[0], 'connector'>;
  position: Point;
  shape_kind?: ShapeKind;
  text?: string;
  group_ids: string[];
};

export type SemanticEdge = {
  id: string;
  from?: string;
  to?: string;
  from_point?: Point;
  to_point?: Point;
  directed: boolean;
  bidirectional: boolean;
  route: ConnectorRoute;
  dashed: boolean;
  label?: string;
};

export type SemanticGraph = {
  document_id: string;
  title: string;
  revision: number;
  nodes: SemanticNode[];
  edges: SemanticEdge[];
};

function extractSearchText(node: SceneNode): string | undefined {
  switch (node[0]) {
    case 'paragraph':
      return node[2][1] || undefined;
    case 'math_block':
      return node[1].latex || undefined;
    case 'derivation_card': {
      const parts = node
        .slice(2)
        .map((b) => {
          const blk = b as Extract<SceneNode, ['derivation_card', ...unknown[]]>[2];
          return blk[0] === 'paragraph' ? blk[2][1] : blk[1].latex;
        })
        .filter(Boolean);
      return parts.length ? parts.join(' ') : undefined;
    }
    case 'shape':
      return node[1].text?.trim() || undefined;
    case 'connector':
      return node[1].label?.trim() || undefined;
    default:
      return undefined;
  }
}

/** Exports a compact semantic graph of objects and their connector relations for AI comprehension (AI-01). */
export function buildSemanticGraph(doc: Document): SemanticGraph {
  const nodes: SemanticNode[] = [];
  const edges: SemanticEdge[] = [];
  const entries = Object.values(doc.nodes).sort((a, b) => a[1].id.localeCompare(b[1].id));

  for (const node of entries) {
    if (node[0] === 'connector') {
      const a = node[1];
      const startArrow = a.start_head === 'arrow';
      const endArrow = (a.end_head ?? 'arrow') === 'arrow';
      edges.push({
        id: a.id,
        ...(a.from ? { from: a.from } : {}),
        ...(a.to ? { to: a.to } : {}),
        ...(a.from_point ? { from_point: a.from_point } : {}),
        ...(a.to_point ? { to_point: a.to_point } : {}),
        directed: startArrow || endArrow,
        bidirectional: startArrow && endArrow,
        route: a.route ?? 'straight',
        dashed: !!a.dashed,
        ...(a.label ? { label: a.label } : {}),
      });
    } else {
      const text = extractSearchText(node);
      nodes.push({
        id: node[1].id,
        kind: node[0],
        position: node[1].position,
        ...(node[0] === 'shape' ? { shape_kind: node[1].kind } : {}),
        ...(text ? { text } : {}),
        group_ids: node[1].group_ids ?? [],
      });
    }
  }

  return {
    document_id: doc.id,
    title: doc.title,
    revision: doc.revision,
    nodes,
    edges,
  };
}
