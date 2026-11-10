import type { ConnectorRoute, SceneNode } from '../../ipc/types';
import { CONNECTOR_ROUTE_NAMES } from './connectors';
import type { Rect } from './geometry';
import { isClosedShape } from './shapes';
import { DuplicateIcon, GroupIcon, TrashIcon, UngroupIcon } from '../toolbar/icons';

type Props = {
  bounds: Rect;
  canvasSize: { w: number; h: number };
  overlay: boolean;
  nodes: SceneNode[];
  canGroup: boolean;
  canUngroup: boolean;
  canNormalize: boolean;
  canRecognize: boolean;
  onGroup: () => void;
  onUngroup: () => void;
  onDuplicate: () => void;
  onNormalize: () => void;
  onRecognize: () => void;
  onToggleShapeFill: () => void;
  onToggleShapeRounded: () => void;
  onCycleConnectorRoute: () => void;
  onCycleConnectorHeads: () => void;
  onToggleConnectorDashed: () => void;
  onEditInlineLabel: () => void;
  onDelete: () => void;
};

/** Contextual floating bar anchored beneath (or above) the active selection. */
export function SelectionBar({
  bounds,
  canvasSize,
  overlay,
  nodes,
  canGroup,
  canUngroup,
  canNormalize,
  canRecognize,
  onGroup,
  onUngroup,
  onDuplicate,
  onNormalize,
  onRecognize,
  onToggleShapeFill,
  onToggleShapeRounded,
  onCycleConnectorRoute,
  onCycleConnectorHeads,
  onToggleConnectorDashed,
  onEditInlineLabel,
  onDelete,
}: Props) {
  const bottomLimit = canvasSize.h - (overlay ? 92 : 96);
  const preferBelow = bounds.y + bounds.h + 56 <= bottomLimit;
  const top = preferBelow ? bounds.y + bounds.h + 12 : Math.max(overlay ? 16 : 52, bounds.y - 48);
  const centerX = Math.max(170, Math.min(canvasSize.w - 170, bounds.x + bounds.w / 2));

  const closedShapes = nodes.filter((n): n is Extract<SceneNode, ['shape', ...unknown[]]> => n[0] === 'shape' && isClosedShape(n[1].kind));
  const rectangles = closedShapes.filter((n) => n[1].kind === 'rectangle');
  const connectors = nodes.filter((n): n is Extract<SceneNode, ['connector', ...unknown[]]> => n[0] === 'connector');
  const singleNode = nodes.length === 1 ? nodes[0] : null;
  const canEditLabel =
    singleNode && ((singleNode[0] === 'shape' && isClosedShape(singleNode[1].kind)) || singleNode[0] === 'connector');

  const fillActive = closedShapes.length > 0 && closedShapes.every((n) => !!n[1].fill);
  const roundedActive = rectangles.length > 0 && rectangles.every((n) => (n[1].corner_radius ?? 0) > 0);
  const curRoute: ConnectorRoute = connectors[0]?.[1].route ?? 'straight';
  const curHeadsLabel =
    connectors[0]
      ? connectors[0][1].start_head === 'arrow' && (connectors[0][1].end_head ?? 'arrow') === 'arrow'
        ? '双向'
        : (connectors[0][1].end_head ?? 'arrow') === 'arrow'
          ? '单向'
          : '无箭头'
      : '单向';
  const dashedActive = connectors.length > 0 && connectors.every((n) => !!n[1].dashed);

  return (
    <div
      className="selection-actions"
      role="toolbar"
      aria-label={`已选 ${nodes.length} 项操作`}
      style={{ left: centerX, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
    >
      {canGroup && (
        <button type="button" className="selection-btn" onClick={onGroup} title="组合 ⌘G">
          {GroupIcon}
          <span>组合</span>
        </button>
      )}
      {canUngroup && (
        <button type="button" className="selection-btn" onClick={onUngroup} title="取消组合 ⇧⌘G">
          {UngroupIcon}
          <span>取消组合</span>
        </button>
      )}
      {closedShapes.length > 0 && (
        <>
          <button type="button" className="selection-btn" aria-pressed={fillActive} onClick={onToggleShapeFill} title="切换填充底色">
            <span>填充</span>
          </button>
          {rectangles.length > 0 && (
            <button type="button" className="selection-btn" aria-pressed={roundedActive} onClick={onToggleShapeRounded} title="切换矩形圆角">
              <span>圆角</span>
            </button>
          )}
        </>
      )}
      {connectors.length > 0 && (
        <>
          <button type="button" className="selection-btn" onClick={onCycleConnectorRoute} title="切换连接线形态（直线 / 折线 / 曲线）">
            <span>{CONNECTOR_ROUTE_NAMES[curRoute]}</span>
          </button>
          <button type="button" className="selection-btn" onClick={onCycleConnectorHeads} title="切换箭头方向（单向 / 双向 / 无）">
            <span>{curHeadsLabel}</span>
          </button>
          <button type="button" className="selection-btn" aria-pressed={dashedActive} onClick={onToggleConnectorDashed} title="切换虚线">
            <span>虚线</span>
          </button>
        </>
      )}
      {canEditLabel && (
        <button type="button" className="selection-btn" onClick={onEditInlineLabel} title="编辑内嵌文字（双击或 Enter）">
          <span>{singleNode?.[0] === 'connector' ? '标签' : '文字'}</span>
        </button>
      )}
      {canNormalize && (
        <button type="button" className="selection-btn" onClick={onNormalize} title="规整所选笔迹为几何图形">
          <span>规整</span>
        </button>
      )}
      {canRecognize && !overlay && (
        <button type="button" className="selection-btn" onClick={onRecognize} title="识别笔迹为文字">
          <span>识字</span>
        </button>
      )}
      <button type="button" className="selection-btn" onClick={onDuplicate} aria-label="复制所选" title="复制 ⌘D">
        {DuplicateIcon}
      </button>
      <span className="selection-sep" role="separator" aria-orientation="vertical" />
      <button type="button" className="selection-btn is-danger" onClick={onDelete} title="删除 ⌫" aria-label="删除所选">
        {TrashIcon}
      </button>
    </div>
  );
}
