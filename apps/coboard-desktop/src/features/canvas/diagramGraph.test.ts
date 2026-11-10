import { describe, expect, it } from 'vitest';
import { EMPTY_DOCUMENT, optimisticDocument } from '../../stores/document';
import { buildSemanticGraph } from './diagramGraph';

describe('semantic diagram graph export (AI-01)', () => {
  it('exports shapes with inline text, math nodes, and typed directed/bidirectional edges deterministically', () => {
    const doc = optimisticDocument(EMPTY_DOCUMENT, [
      {
        type: 'edit',
        operations: [
          { type: 'insert', node: ['shape', { id: 'n_b', kind: 'diamond', position: { x: 300, y: 100 }, end: { x: 100, y: 80 }, width: 2, color: '#1f2329', text: '收敛?' }] },
          { type: 'insert', node: ['shape', { id: 'n_a', kind: 'rectangle', position: { x: 40, y: 100 }, end: { x: 120, y: 60 }, width: 2, color: '#2f6fed', text: '初始化参数' }] },
          { type: 'insert', node: ['math_block', { id: 'm1', position: { x: 40, y: 220 }, latex: 'E = mc^2' }] },
          {
            type: 'insert',
            node: [
              'connector',
              {
                id: 'e1',
                position: { x: 160, y: 130 },
                from: 'n_a',
                to: 'n_b',
                route: 'elbow',
                start_head: 'none',
                end_head: 'arrow',
                dashed: false,
                label: '迭代一步',
              },
            ],
          },
          {
            type: 'insert',
            node: [
              'connector',
              {
                id: 'e2',
                position: { x: 350, y: 180 },
                from: 'n_b',
                to_point: { x: 500, y: 240 },
                route: 'curve',
                start_head: 'arrow',
                end_head: 'arrow',
                dashed: true,
              },
            ],
          },
        ],
      },
    ]);

    const graph = buildSemanticGraph(doc);
    expect(graph.nodes.map((n) => n.id)).toEqual(['m1', 'n_a', 'n_b']);
    expect(graph.nodes.find((n) => n.id === 'n_a')).toMatchObject({ kind: 'shape', shape_kind: 'rectangle', text: '初始化参数' });
    expect(graph.nodes.find((n) => n.id === 'm1')).toMatchObject({ kind: 'math_block', text: 'E = mc^2' });

    expect(graph.edges).toEqual([
      {
        id: 'e1',
        from: 'n_a',
        to: 'n_b',
        directed: true,
        bidirectional: false,
        route: 'elbow',
        dashed: false,
        label: '迭代一步',
      },
      {
        id: 'e2',
        from: 'n_b',
        to_point: { x: 500, y: 240 },
        directed: true,
        bidirectional: true,
        route: 'curve',
        dashed: true,
      },
    ]);
  });
});
