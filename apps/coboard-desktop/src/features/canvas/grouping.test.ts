import { describe, expect, it } from 'vitest';
import type { Document, InkPoint, SceneNode } from '../../ipc/types';
import { EMPTY_DOCUMENT, optimisticDocument } from '../../stores/document';
import {
  buildDeleteOps,
  buildDuplicateOps,
  buildGroupOps,
  buildNormalizeOps,
  buildTranslateOps,
  buildUngroupOps,
  canGroupSelection,
  canUngroupSelection,
  expandSelection,
  selectedOuterGroupId,
} from './grouping';

const makeDoc = (): Document =>
  optimisticDocument(EMPTY_DOCUMENT, [
    {
      type: 'edit',
      operations: [
        { type: 'insert', node: ['paragraph', { id: 'a', position: { x: 10, y: 10 } }, ['text', 'A']] },
        { type: 'insert', node: ['paragraph', { id: 'b', position: { x: 50, y: 10 } }, ['text', 'B']] },
        { type: 'insert', node: ['paragraph', { id: 'c', position: { x: 90, y: 10 } }, ['text', 'C']] },
        { type: 'insert', node: ['shape', { id: 'l1', kind: 'arrow', position: { x: 0, y: 0 }, end: { x: 30, y: 40 }, width: 4, color: '#1f2329' }] },
      ],
    },
  ]);

describe('grouping and multi-selection transforms', () => {
  it('supports nested group, subgroup, drill-down selection, ungroup, and orphan cleanup', () => {
    let doc = makeDoc();
    expect(canGroupSelection(doc, new Set(['a', 'b']), null)).toBe(true);
    doc = optimisticDocument(doc, [{ type: 'edit', operations: buildGroupOps(doc, new Set(['a', 'b']), null, 'g1') }]);
    expect(expandSelection(doc, ['a'], null)).toEqual(new Set(['a', 'b']));
    expect(selectedOuterGroupId(doc, new Set(['a', 'b']), null)).toBe('g1');
    expect(canGroupSelection(doc, new Set(['a', 'b']), null)).toBe(false);
    expect(canUngroupSelection(doc, new Set(['a', 'b']), null)).toBe(true);

    // Outer group g2 wrapping g1 + c
    doc = optimisticDocument(doc, [{ type: 'edit', operations: buildGroupOps(doc, new Set(['a', 'b', 'c']), null, 'g2') }]);
    expect(expandSelection(doc, ['a'], null)).toEqual(new Set(['a', 'b', 'c']));
    expect(expandSelection(doc, ['a'], 'g2')).toEqual(new Set(['a', 'b']));
    expect(expandSelection(doc, ['a'], 'g1')).toEqual(new Set(['a']));

    // Ungroup g1 while drilled inside g2
    doc = optimisticDocument(doc, [{ type: 'edit', operations: buildUngroupOps(doc, new Set(['a', 'b']), 'g2') }]);
    expect(doc.nodes.a[1].group_ids).toEqual(['g2']);
    expect(doc.nodes.b[1].group_ids).toEqual(['g2']);
    expect(doc.nodes.c[1].group_ids).toEqual(['g2']);

    // Delete 2 of 3 members -> remaining survivor c is auto-ungrouped
    doc = optimisticDocument(doc, [{ type: 'edit', operations: buildDeleteOps(doc, new Set(['a', 'b'])) }]);
    expect(doc.nodes.c[1].group_ids).toBeUndefined();
  });

  it('translates lines/arrows and duplicates groups with fresh group ids', () => {
    let doc = makeDoc();
    doc = optimisticDocument(doc, [{ type: 'edit', operations: buildGroupOps(doc, new Set(['a', 'l1']), null, 'g1') }]);
    doc = optimisticDocument(doc, [{ type: 'edit', operations: buildTranslateOps(doc, ['a', 'l1'], 15, -5) }]);
    expect(doc.nodes.a[1].position).toEqual({ x: 25, y: 5 });
    expect(doc.nodes.l1[0] === 'shape' && doc.nodes.l1[1].end).toEqual({ x: 45, y: 35 });

    let n = 0;
    const { ops, newIds } = buildDuplicateOps(doc, new Set(['a', 'l1']), 20, () => `copy_${++n}`);
    doc = optimisticDocument(doc, [{ type: 'edit', operations: ops }]);
    expect(newIds).toEqual(['copy_1', 'copy_2']);
    expect(doc.nodes.copy_1[1].group_ids).toEqual(['copy_3']);
    expect(doc.nodes.copy_2[1].group_ids).toEqual(['copy_3']);
  });

  it('cleans up anchored connectors on delete while duplicating free/paired connectors safely', () => {
    let doc = optimisticDocument(makeDoc(), [
      {
        type: 'edit',
        operations: [
          { type: 'insert', node: ['connector', { id: 'c_bound', position: { x: 0, y: 0 }, from: 'a', to: 'b' }] },
          { type: 'insert', node: ['connector', { id: 'c_free', position: { x: 0, y: 0 }, from_point: { x: 10, y: 10 }, to_point: { x: 60, y: 60 }, waypoints: [{ x: 35, y: 20 }] }] },
        ],
      },
    ]);
    let seq = 0;
    const dupPartial = buildDuplicateOps(doc, new Set(['a', 'c_bound', 'c_free']), 12, () => `d_${++seq}`);
    expect(dupPartial.newIds).toEqual(['d_1', 'd_2']);
    const afterDup = optimisticDocument(doc, [{ type: 'edit', operations: dupPartial.ops }]);
    expect(afterDup.nodes.d_2[0]).toBe('connector');
    if (afterDup.nodes.d_2[0] === 'connector') {
      expect(afterDup.nodes.d_2[1].from_point).toEqual({ x: 22, y: 22 });
      expect(afterDup.nodes.d_2[1].waypoints).toEqual([{ x: 47, y: 32 }]);
    }

    doc = optimisticDocument(doc, [{ type: 'edit', operations: buildTranslateOps(doc, ['c_free'], 10, 5) }]);
    if (doc.nodes.c_free[0] === 'connector') {
      expect(doc.nodes.c_free[1].from_point).toEqual({ x: 20, y: 15 });
      expect(doc.nodes.c_free[1].waypoints).toEqual([{ x: 45, y: 25 }]);
    }

    doc = optimisticDocument(doc, [{ type: 'edit', operations: buildDeleteOps(doc, new Set(['a'])) }]);
    expect(doc.nodes.a).toBeUndefined();
    expect(doc.nodes.c_bound).toBeUndefined();
    expect(doc.nodes.c_free).toBeDefined();
  });

  it('preserves shared groups with siblings and avoids orphan 1-member groups or dangling connectors on normalize merge', () => {
    const ink = (xy: [number, number][]): InkPoint[] => xy.map(([x, y], i) => ({ x, y, pressure: 0.5, elapsed_ms: i * 10 }));
    const s1: SceneNode = ['stroke', { id: 's1', position: { x: 0, y: 0 }, points: ink([[0, 0], [50, 0], [100, 0]]), width: 4, color: '#1f2329', group_ids: ['g1'] }];
    const s2: SceneNode = ['stroke', { id: 's2', position: { x: 100, y: 0 }, points: ink([[0, 0], [0, 35], [0, 70]]), width: 4, color: '#1f2329', group_ids: ['g1'] }];
    const s3: SceneNode = ['stroke', { id: 's3', position: { x: 100, y: 70 }, points: ink([[0, 0], [-50, 0], [-100, 0]]), width: 4, color: '#1f2329', group_ids: ['g1'] }];
    const s4: SceneNode = ['stroke', { id: 's4', position: { x: 0, y: 70 }, points: ink([[0, 0], [0, -35], [0, -70]]), width: 4, color: '#1f2329', group_ids: ['g1'] }];
    const sibling: SceneNode = ['paragraph', { id: 'sib', position: { x: 150, y: 0 }, group_ids: ['g1'] }, ['text', 'note']];

    const docWithSibling = optimisticDocument(EMPTY_DOCUMENT, [{
      type: 'edit',
      operations: [s1, s2, s3, s4, sibling].map((node) => ({ type: 'insert' as const, node })),
    }]);
    const res1 = buildNormalizeOps(docWithSibling, ['s1', 's2', 's3', 's4'], () => ({}));
    const after1 = optimisticDocument(docWithSibling, [{ type: 'edit', operations: res1.ops }]);
    expect(res1.nextSelected).toBeDefined();
    expect(after1.nodes[res1.nextSelected!]?.[0]).toBe('shape');
    expect(after1.nodes[res1.nextSelected!]?.[1].group_ids).toEqual(['g1']);
    expect(after1.nodes.sib[1].group_ids).toEqual(['g1']);

    const conn: SceneNode = ['connector', { id: 'c1', position: { x: 0, y: 0 }, from: 's1', to: 's2', route: 'straight' }];
    const docWholeGroup = optimisticDocument(EMPTY_DOCUMENT, [{
      type: 'edit',
      operations: [s1, s2, s3, s4, conn].map((node) => ({ type: 'insert' as const, node })),
    }]);
    const res2 = buildNormalizeOps(docWholeGroup, ['s1', 's2', 's3', 's4'], () => ({}));
    const after2 = optimisticDocument(docWholeGroup, [{ type: 'edit', operations: res2.ops }]);
    expect(after2.nodes.c1).toBeUndefined();
    expect(after2.nodes[res2.nextSelected!]?.[1].group_ids).toBeUndefined();
  });
});
