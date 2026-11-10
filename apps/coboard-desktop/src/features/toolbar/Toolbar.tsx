import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { canRedo, canUndo, useSession } from '../../stores/session';
import { useOverlay } from '../../stores/overlay';
import {
  BRUSH_NAMES,
  INK,
  INK_NAMES,
  SIZES,
  SIZE_NAMES,
  TOOL_KEYS,
  TOOL_LABELS,
  useTools,
  type ConnectorHeadsPreset,
  type Tool,
  type ToolPanel,
} from '../../stores/tools';
import { CONNECTOR_ROUTE_NAMES } from '../canvas/connectors';
import { SHAPE_NAMES, SHAPE_PRESETS } from '../canvas/shapes';
import {
  BrushIcons,
  ConnectorHeadIcons,
  ConnectorRouteIcons,
  RedoIcon,
  ShapeIcons,
  ToolIcons,
  UndoIcon,
} from './icons';
import type { Brush, ConnectorRoute } from '../../ipc/types';

const TOOL_GROUPS: Tool[][] = [
  ['select', 'lasso'],
  ['pen', 'highlighter', 'laser', 'eraser'],
  ['connector', 'shape', 'text'],
];

const BRUSHES = (Object.keys(BRUSH_NAMES) as Brush[]).filter((b) => b !== 'highlighter');
const ROUTES: ConnectorRoute[] = ['straight', 'elbow', 'curve'];
const HEAD_PRESETS: { id: ConnectorHeadsPreset; label: string }[] = [
  { id: 'arrow', label: '单向' },
  { id: 'both', label: '双向' },
  { id: 'none', label: '无箭头' },
];

type Props = {
  overlay?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  onToolInteract?: () => void;
};

function flyoutOf(t: Tool): Exclude<ToolPanel, null> | null {
  if (t === 'pen') return 'brush';
  if (t === 'shape') return 'shape';
  if (t === 'connector') return 'connector';
  return null;
}

export function Toolbar({ overlay = false, leading, trailing, onToolInteract }: Props) {
  const {
    tool,
    brush,
    shape,
    drawAndHold,
    shapeDrawMode,
    shapeFill,
    shapeRounded,
    connectorRoute,
    connectorHeads,
    connectorDashed,
    color,
    size,
    panel,
    setTool,
    setBrush,
    setShape,
    setDrawAndHold,
    setShapeDrawMode,
    setShapeFill,
    setShapeRounded,
    setConnectorRoute,
    setConnectorHeads,
    setConnectorDashed,
    setColor,
    setSize,
    setPanel,
  } = useTools();
  const mainUndo = useSession(canUndo);
  const mainRedo = useSession(canRedo);
  const edit = useSession((s) => s.edit);
  const screen = useOverlay();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!panel) return;
    const closeOutside = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setPanel(null);
    };
    const closeEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanel(null);
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeEsc);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeEsc);
    };
  }, [panel, setPanel]);

  const choose = (t: Tool) => {
    onToolInteract?.();
    if (overlay) void screen.setPassthrough(false);
    const flyout = flyoutOf(t);
    if (flyout && tool === t) {
      setPanel(panel === flyout ? null : flyout);
      return;
    }
    setPanel(null);
    setTool(t);
  };

  const openFlyout = (kind: Exclude<ToolPanel, null>) => {
    onToolInteract?.();
    if (overlay) void screen.setPassthrough(false);
    setTool(kind === 'brush' ? 'pen' : kind);
    setPanel(panel === kind ? null : kind);
  };

  const pick = (apply: () => void) => {
    apply();
    setPanel(null);
    if (overlay) void screen.setPassthrough(false);
  };

  const toolLabel = (t: Tool) => {
    if (t === 'pen') return `画笔 · ${BRUSH_NAMES[brush]}（再点设置笔刷）`;
    if (t === 'shape') {
      return shapeDrawMode === 'auto'
        ? '图形 · 手绘自动规整（再点切换预设/样式）'
        : `图形 · ${SHAPE_NAMES[shape]}（再点切换模式）`;
    }
    if (t === 'connector') return `连接线 · ${CONNECTOR_ROUTE_NAMES[connectorRoute]}（再点调整样式）`;
    return TOOL_LABELS[t];
  };

  const renderFlyout = (kind: Exclude<ToolPanel, null>) => {
    if (kind === 'brush') {
      return (
        <div className="tool-options popover-card popover-stack" role="group" aria-label="笔刷选项">
          <div className="popover-row">
            {BRUSHES.map((b) => (
              <button type="button" key={b} className="tool" aria-pressed={brush === b} aria-label={BRUSH_NAMES[b]} title={BRUSH_NAMES[b]} onClick={() => pick(() => setBrush(b))}>
                {BrushIcons[b]}
              </button>
            ))}
          </div>
          <div className="popover-divider" />
          <button
            type="button"
            role="switch"
            aria-checked={drawAndHold}
            className="popover-switch"
            onClick={() => setDrawAndHold(!drawAndHold)}
          >
            <span className="popover-switch-text">
              <strong>绘制并按住</strong>
              <small>停顿规整形状 · 继续拖动可调大小角度</small>
            </span>
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
          </button>
        </div>
      );
    }

    if (kind === 'shape') {
      return (
        <div className="tool-options popover-card popover-stack" role="group" aria-label="图形选项">
          <div className="popover-segment" role="radiogroup" aria-label="图形绘制方式">
            <button
              type="button"
              role="radio"
              aria-checked={shapeDrawMode === 'auto'}
              className="segment-btn"
              onClick={() => pick(() => setShapeDrawMode('auto'))}
            >
              手绘自动规整
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={shapeDrawMode === 'preset'}
              className="segment-btn"
              onClick={() => setShapeDrawMode('preset')}
            >
              拖放预设
            </button>
          </div>
          <div className="popover-divider" />
          <div className="popover-row">
            {SHAPE_PRESETS.map((k) => (
              <button
                type="button"
                key={k}
                className="tool"
                aria-pressed={shapeDrawMode === 'preset' && shape === k}
                aria-label={SHAPE_NAMES[k]}
                title={`${SHAPE_NAMES[k]}（拖放创建）`}
                onClick={() => pick(() => setShape(k, 'preset'))}
              >
                {ShapeIcons[k]}
              </button>
            ))}
          </div>
          <div className="popover-divider" />
          <button
            type="button"
            role="switch"
            aria-checked={shapeFill}
            className="popover-switch"
            onClick={() => setShapeFill(!shapeFill)}
          >
            <span className="popover-switch-text">
              <strong>填充底色</strong>
            </span>
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={shapeRounded}
            className="popover-switch"
            onClick={() => setShapeRounded(!shapeRounded)}
          >
            <span className="popover-switch-text">
              <strong>矩形微圆角</strong>
            </span>
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
          </button>
        </div>
      );
    }

    return (
      <div className="tool-options popover-card popover-stack" role="group" aria-label="连接线样式">
        <div className="popover-row">
          {ROUTES.map((r) => (
            <button
              type="button"
              key={r}
              className="tool popover-chip-btn"
              aria-pressed={connectorRoute === r}
              aria-label={CONNECTOR_ROUTE_NAMES[r]}
              title={CONNECTOR_ROUTE_NAMES[r]}
              onClick={() => pick(() => setConnectorRoute(r))}
            >
              {ConnectorRouteIcons[r]}
              <span>{CONNECTOR_ROUTE_NAMES[r]}</span>
            </button>
          ))}
        </div>
        <div className="popover-divider" />
        <div className="popover-row">
          {HEAD_PRESETS.map((h) => (
            <button
              type="button"
              key={h.id}
              className="tool popover-chip-btn"
              aria-pressed={connectorHeads === h.id}
              aria-label={h.label}
              title={h.label}
              onClick={() => pick(() => setConnectorHeads(h.id))}
            >
              {ConnectorHeadIcons[h.id]}
              <span>{h.label}</span>
            </button>
          ))}
        </div>
        <div className="popover-divider" />
        <button
          type="button"
          role="switch"
          aria-checked={connectorDashed}
          className="popover-switch"
          onClick={() => setConnectorDashed(!connectorDashed)}
        >
          <span className="popover-switch-text">
            <strong>虚线连接</strong>
          </span>
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
        </button>
      </div>
    );
  };

  return (
    <div ref={boxRef} className="toolbox">
      <div className="toolbar" role="toolbar" aria-label="绘图工具" onMouseDown={(e) => e.preventDefault()}>
        {leading}
        {TOOL_GROUPS.map((group, gi) => (
          <div key={gi} className="toolbar-group" role="group" aria-label={gi === 0 ? '选择与套索' : gi === 1 ? '书写与擦除' : '构建与插入'}>
            {group.map((t) => {
              const flyout = flyoutOf(t);
              const icon =
                t === 'shape'
                  ? (shapeDrawMode === 'preset' ? ShapeIcons[shape] : ToolIcons.shape)
                  : t === 'connector'
                    ? ConnectorRouteIcons[connectorRoute]
                    : ToolIcons[t];
              const label = toolLabel(t);
              return (
                <div key={t} className="popover-anchor">
                  <button
                    type="button"
                    className={`tool${flyout ? ' has-flyout' : ''}`}
                    aria-label={label}
                    aria-pressed={tool === t}
                    aria-expanded={flyout ? panel === flyout : undefined}
                    title={`${label} ${TOOL_KEYS[t]}`}
                    onClick={() => choose(t)}
                    onContextMenu={(e) => {
                      if (!flyout) return;
                      e.preventDefault();
                      openFlyout(flyout);
                    }}
                  >
                    {icon}
                    <span className="tool-key" aria-hidden="true">{TOOL_KEYS[t]}</span>
                  </button>
                  {flyout && panel === flyout && renderFlyout(flyout)}
                </div>
              );
            })}
          </div>
        ))}
        <div className="toolbar-group" role="radiogroup" aria-label="墨迹颜色">
          {INK.map((hex, i) => (
            <button
              type="button"
              key={hex}
              className="tool swatch"
              role="radio"
              aria-checked={color === i}
              aria-label={INK_NAMES[i]}
              title={`${INK_NAMES[i]} ${i + 1}`}
              style={{ '--swatch': `var(--ink-${i + 1}${i === 0 ? '-display' : ''})` } as CSSProperties}
              onClick={() => {
                onToolInteract?.();
                setColor(i);
              }}
            >
              <span />
            </button>
          ))}
        </div>
        <div className="toolbar-group" role="radiogroup" aria-label="粗细">
          {SIZES.map((w, i) => (
            <button
              type="button"
              key={w}
              className="tool size"
              role="radio"
              aria-checked={size === i}
              aria-label={SIZE_NAMES[i]}
              title={`${SIZE_NAMES[i]} [ / ]`}
              onClick={() => {
                onToolInteract?.();
                setSize(i);
              }}
            >
              <span style={{ width: 4 + i * 3.5, height: 4 + i * 3.5 }} />
            </button>
          ))}
        </div>
        <div className="toolbar-group" role="group" aria-label="历史记录">
          <button
            type="button"
            className="tool"
            aria-label="撤销"
            title="撤销 ⌘Z"
            disabled={overlay ? !screen.ink.canUndo : !mainUndo}
            onClick={() => (overlay ? void screen.command('undo') : void edit({ type: 'undo' }))}
          >
            {UndoIcon}
          </button>
          <button
            type="button"
            className="tool"
            aria-label="重做"
            title="重做 ⇧⌘Z"
            disabled={overlay ? !screen.ink.canRedo : !mainRedo}
            onClick={() => (overlay ? void screen.command('redo') : void edit({ type: 'redo' }))}
          >
            {RedoIcon}
          </button>
        </div>
        {trailing}
      </div>
    </div>
  );
}
