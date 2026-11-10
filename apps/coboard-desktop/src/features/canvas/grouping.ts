import type { Document, Operation, SceneNode, ShapeNode, StrokeNode } from '../../ipc/types';
import { optimisticDocument } from '../../stores/document';
import { mergeRecentStrokesToShape, normalizeStroke, SHAPE_NAMES, type ShapeOptions } from './shapes';

export function visibleGroupId(node: SceneNode, activeGroupId: string | null): string | null {
  const groups = node[1].group_ids ?? [];
  if (!groups.length) return null;
  if (!activeGroupId) return groups[groups.length - 1];
  const idx = groups.indexOf(activeGroupId);
  if (idx === -1) return groups[groups.length - 1];
  return idx > 0 ? groups[idx - 1] : null;
}

export function groupMemberIds(doc: Document, groupId: string): string[] {
  return Object.values(doc.nodes)
    .filter((n) => n[1].group_ids?.includes(groupId))
    .map((n) => n[1].id);
}

export function expandSelection(doc: Document, seedIds: Iterable<string>, activeGroupId: string | null): Set<string> {
  const result = new Set<string>();
  const targetGroups = new Set<string>();
  for (const id of seedIds) {
    const node = doc.nodes[id];
    if (!node) continue;
    result.add(id);
    const gid = visibleGroupId(node, activeGroupId);
    if (gid) targetGroups.add(gid);
  }
  if (targetGroups.size) {
    for (const node of Object.values(doc.nodes)) {
      const groups = node[1].group_ids;
      if (groups?.some((g) => targetGroups.has(g))) result.add(node[1].id);
    }
  }
  return result;
}

export function selectedOuterGroupId(doc: Document, selectedIds: ReadonlySet<string>, activeGroupId: string | null): string | null {
  let shared: string | null = null;
  let count = 0;
  for (const id of selectedIds) {
    const node = doc.nodes[id];
    if (!node) continue;
    count++;
    const vg = visibleGroupId(node, activeGroupId);
    if (!vg) return null;
    if (shared === null) shared = vg;
    else if (shared !== vg) return null;
  }
  if (!shared || count === 0) return null;
  const members = groupMemberIds(doc, shared);
  return members.length === count && members.every((id) => selectedIds.has(id)) ? shared : null;
}

export function canGroupSelection(doc: Document, selectedIds: ReadonlySet<string>, activeGroupId: string | null): boolean {
  let validCount = 0;
  for (const id of selectedIds) if (doc.nodes[id]) validCount++;
  if (validCount < 2) return false;
  return selectedOuterGroupId(doc, selectedIds, activeGroupId) === null;
}

export function canUngroupSelection(doc: Document, selectedIds: ReadonlySet<string>, activeGroupId: string | null): boolean {
  return selectedOuterGroupId(doc, selectedIds, activeGroupId) !== null;
}

function sharedOuterChain(doc: Document, ids: readonly string[], activeGroupId: string | null): string[] {
  if (!activeGroupId || !ids.length) return [];
  const first = doc.nodes[ids[0]]?.[1].group_ids ?? [];
  const idx = first.indexOf(activeGroupId);
  if (idx === -1) return [];
  const chain = first.slice(idx);
  for (const id of ids.slice(1)) {
    const groups = doc.nodes[id]?.[1].group_ids ?? [];
    const nIdx = groups.indexOf(activeGroupId);
    if (nIdx === -1) return [];
    const tail = groups.slice(nIdx);
    if (tail.length !== chain.length || tail.some((g, i) => g !== chain[i])) return [];
  }
  return chain;
}

function stripGroupOps(doc: Document, targetGroupId: string): { ops: Operation[]; doc: Document } {
  const members = groupMemberIds(doc, targetGroupId);
  if (!members.length) return { ops: [], doc };
  const sampleGroups = doc.nodes[members[0]]?.[1].group_ids ?? [];
  const idx = sampleGroups.indexOf(targetGroupId);
  if (idx === -1) return { ops: [], doc };
  const outer = sampleGroups.slice(idx + 1);
  const ops: Operation[] = [];
  for (const gid of [...outer].reverse()) {
    const gMembers = groupMemberIds(doc, gid);
    if (gMembers.length) ops.push({ type: 'ungroup', id: gid, node_ids: gMembers });
  }
  ops.push({ type: 'ungroup', id: targetGroupId, node_ids: members });
  for (const gid of outer) {
    const gMembers = groupMemberIds(doc, gid);
    if (gMembers.length) ops.push({ type: 'group', id: gid, node_ids: gMembers });
  }
  const nextDoc = ops.length ? optimisticDocument(doc, [{ type: 'edit', operations: ops }]) : doc;
  return { ops, doc: nextDoc };
}

export function buildGroupOps(
  doc: Document,
  selectedIds: ReadonlySet<string>,
  activeGroupId: string | null,
  newGroupId: string = crypto.randomUUID(),
): Operation[] {
  const ids = [...selectedIds].filter((id) => !!doc.nodes[id]);
  if (ids.length < 2) return [];
  const outer = sharedOuterChain(doc, ids, activeGroupId);
  if (!outer.length) return [{ type: 'group', id: newGroupId, node_ids: ids }];
  const ops: Operation[] = [];
  for (const gid of [...outer].reverse()) {
    const gMembers = groupMemberIds(doc, gid);
    if (gMembers.length) ops.push({ type: 'ungroup', id: gid, node_ids: gMembers });
  }
  ops.push({ type: 'group', id: newGroupId, node_ids: ids });
  for (const gid of outer) {
    const gMembers = groupMemberIds(doc, gid);
    if (gMembers.length) ops.push({ type: 'group', id: gid, node_ids: gMembers });
  }
  return ops;
}

export function buildUngroupOps(
  doc: Document,
  selectedIds: ReadonlySet<string>,
  activeGroupId: string | null,
): Operation[] {
  const gid = selectedOuterGroupId(doc, selectedIds, activeGroupId);
  if (!gid) return [];
  return stripGroupOps(doc, gid).ops;
}

export function buildDeleteOps(doc: Document, selectedIds: ReadonlySet<string>): Operation[] {
  const toDelete = new Set<string>();
  for (const id of selectedIds) if (doc.nodes[id]) toDelete.add(id);
  if (!toDelete.size) return [];
  for (const node of Object.values(doc.nodes)) {
    if (node[0] === 'connector') {
      const { from, to } = node[1];
      if ((from && toDelete.has(from)) || (to && toDelete.has(to))) {
        toDelete.add(node[1].id);
      }
    }
  }
  const touchedGroups = new Set<string>();
  for (const id of toDelete) {
    for (const gid of doc.nodes[id]?.[1].group_ids ?? []) touchedGroups.add(gid);
  }
  const deleteOps: Operation[] = [...toDelete].map((id) => ({ type: 'delete', id }));
  let curDoc = optimisticDocument(doc, [{ type: 'edit', operations: deleteOps }]);
  const cleanupOps: Operation[] = [];
  for (const gid of touchedGroups) {
    if (groupMemberIds(curDoc, gid).length === 1) {
      const stripped = stripGroupOps(curDoc, gid);
      cleanupOps.push(...stripped.ops);
      curDoc = stripped.doc;
    }
  }
  return [...deleteOps, ...cleanupOps];
}

export function buildTranslateOps(doc: Document, ids: Iterable<string>, dx: number, dy: number): Operation[] {
  const valid = [...new Set([...ids].filter((id) => !!doc.nodes[id]))];
  if (!valid.length || (dx === 0 && dy === 0)) return [];
  return [{ type: 'translate', ids: valid, dx, dy }];
}

const shiftPt = (p: { x: number; y: number }, offset: number) => ({
  x: Math.round((p.x + offset) * 100) / 100,
  y: Math.round((p.y + offset) * 100) / 100,
});

export function buildDuplicateOps(
  doc: Document,
  selectedIds: ReadonlySet<string>,
  offset = 24,
  idGen: () => string = () => crypto.randomUUID(),
): { ops: Operation[]; newIds: string[] } {
  const idMap = new Map<string, string>();
  const sources: SceneNode[] = [];
  for (const id of selectedIds) {
    const node = doc.nodes[id];
    if (!node) continue;
    if (node[0] === 'connector') {
      const { from, to } = node[1];
      if ((from && !selectedIds.has(from)) || (to && !selectedIds.has(to))) continue;
    }
    sources.push(node);
    idMap.set(id, idGen());
  }
  if (!sources.length) return { ops: [], newIds: [] };

  const groupMemberTotal = new Map<string, number>();
  for (const node of Object.values(doc.nodes)) {
    for (const gid of node[1].group_ids ?? []) groupMemberTotal.set(gid, (groupMemberTotal.get(gid) ?? 0) + 1);
  }
  const selectedGroupCount = new Map<string, number>();
  for (const node of sources) {
    for (const gid of node[1].group_ids ?? []) selectedGroupCount.set(gid, (selectedGroupCount.get(gid) ?? 0) + 1);
  }
  const groupMap = new Map<string, string>();
  for (const [gid, count] of selectedGroupCount) {
    if (count >= 2 && count === groupMemberTotal.get(gid)) groupMap.set(gid, idGen());
  }

  const ops: Operation[] = [];
  const newIds: string[] = [];
  for (const node of sources) {
    const newId = idMap.get(node[1].id)!;
    newIds.push(newId);
    const mappedGroups = (node[1].group_ids ?? []).map((g) => groupMap.get(g)).filter((g): g is string => !!g);
    const { group_ids: _oldGroups, ...restAttrs } = node[1];
    const baseAttrs = {
      ...restAttrs,
      id: newId,
      position: shiftPt(node[1].position, offset),
      ...(mappedGroups.length ? { group_ids: mappedGroups } : {}),
    };
    let clone: SceneNode;
    if (node[0] === 'shape' && (node[1].kind === 'line' || node[1].kind === 'arrow' || node[1].kind === 'curve' || node[1].kind === 'wave')) {
      clone = [
        'shape',
        {
          ...baseAttrs,
          kind: node[1].kind,
          width: node[1].width,
          color: node[1].color,
          end: shiftPt(node[1].end, offset),
          ...(node[1].points?.length ? { points: node[1].points } : {}),
        },
      ];
    } else if (node[0] === 'connector') {
      const a = node[1];
      clone = [
        'connector',
        {
          ...baseAttrs,
          ...(a.from ? { from: idMap.get(a.from)! } : {}),
          ...(a.to ? { to: idMap.get(a.to)! } : {}),
          ...(a.from_point ? { from_point: shiftPt(a.from_point, offset) } : {}),
          ...(a.to_point ? { to_point: shiftPt(a.to_point, offset) } : {}),
          ...(a.waypoints?.length ? { waypoints: a.waypoints.map((wp) => shiftPt(wp, offset)) } : {}),
        },
      ];
    } else {
      clone = [node[0], baseAttrs, ...node.slice(2)] as SceneNode;
    }
    ops.push({ type: 'insert', node: clone });
  }
  return { ops, newIds };
}

export function buildNormalizeOps(
  doc: Document,
  ids: Iterable<string>,
  optsForColor: (strokeColor: string) => ShapeOptions,
): { ops: Operation[]; nextSelected?: string; label?: string } {
  const strokes = [...ids]
    .map((id) => doc.nodes[id])
    .filter((n): n is StrokeNode => n?.[0] === 'stroke');
  if (strokes.length >= 2 && strokes.length <= 4) {
    const firstGroups = strokes[0][1].group_ids ?? [];
    const sameGroups =
      firstGroups.length > 0
      && strokes.every((s) => {
        const g = s[1].group_ids ?? [];
        return g.length === firstGroups.length && g.every((gid, i) => gid === firstGroups[i]);
      });
    const merged = mergeRecentStrokesToShape(
      strokes.slice(0, -1),
      strokes[strokes.length - 1],
      optsForColor(strokes[0][1].color),
    );
    if (merged) {
      const replacedSet = new Set(merged.replacedIds);
      const survivingGroups = sameGroups
        ? firstGroups.filter((gid) =>
            Object.values(doc.nodes).some((n) => !replacedSet.has(n[1].id) && n[1].group_ids?.includes(gid)),
          )
        : [];
      const shaped: ShapeNode = survivingGroups.length
        ? ['shape', { ...merged.shape[1], group_ids: survivingGroups }]
        : merged.shape;

      const toDelete = new Set(merged.replacedIds);
      for (const node of Object.values(doc.nodes)) {
        if (node[0] === 'connector') {
          const { from, to } = node[1];
          if ((from && toDelete.has(from)) || (to && toDelete.has(to))) toDelete.add(node[1].id);
        }
      }
      const touchedGroups = new Set<string>();
      for (const id of toDelete) {
        for (const gid of doc.nodes[id]?.[1].group_ids ?? []) touchedGroups.add(gid);
      }
      const baseOps: Operation[] = [
        ...[...toDelete].map((id): Operation => ({ type: 'delete', id })),
        { type: 'insert', node: shaped },
      ];
      let curDoc = optimisticDocument(doc, [{ type: 'edit', operations: baseOps }]);
      const cleanupOps: Operation[] = [];
      for (const gid of touchedGroups) {
        if (groupMemberIds(curDoc, gid).length === 1) {
          const stripped = stripGroupOps(curDoc, gid);
          cleanupOps.push(...stripped.ops);
          curDoc = stripped.doc;
        }
      }
      return {
        ops: [...baseOps, ...cleanupOps],
        nextSelected: shaped[1].id,
        label: SHAPE_NAMES[shaped[1].kind],
      };
    }
  }
  const ops: Operation[] = [];
  for (const stroke of strokes) {
    const fitted = normalizeStroke(stroke, optsForColor(stroke[1].color));
    if (fitted) ops.push({ type: 'replace', node: fitted });
  }
  return { ops };
}
