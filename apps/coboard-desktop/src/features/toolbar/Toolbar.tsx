import type { CSSProperties } from 'react';
import { canRedo, canUndo, useSession } from '../../stores/session';
import { useOverlay } from '../../stores/overlay';
import { BRUSH_NAMES, INK, INK_NAMES, SIZES, SIZE_NAMES, TOOL_KEYS, TOOL_LABELS, useTools, type Tool } from '../../stores/tools';
import { SHAPE_NAMES } from '../canvas/shapes';
import { AutoRecognizeIcon, AutoShapeIcon, BrushIcons, RedoIcon, ShapeIcons, ToolIcons, UndoIcon } from './icons';
import type { Brush, ShapeKind } from '../../ipc/types';

const TOOLS: Tool[] = ['select', 'pen', 'highlighter', 'laser', 'eraser', 'text', 'shape'];
const BRUSHES = (Object.keys(BRUSH_NAMES) as Brush[]).filter((b) => b !== 'highlighter');
const SHAPES = Object.keys(SHAPE_NAMES) as ShapeKind[];

export function Toolbar({ overlay = false }: { overlay?: boolean }) {
  const { tool, brush, shape, autoShape, autoRecognize, color, size, panel, setTool, setBrush, setShape, setAutoShape, setAutoRecognize, setColor, setSize, setPanel } = useTools();
  const mainUndo = useSession(canUndo), mainRedo = useSession(canRedo);
  const edit = useSession((s) => s.edit);
  const screen = useOverlay();
  const choose = (t: Tool) => {
    if (overlay) void screen.setPassthrough(false);
    if (t === 'pen') setPanel(panel === 'brush' ? null : 'brush');
    else if (t === 'shape') setPanel(panel === 'shape' ? null : 'shape');
    else setPanel(null);
    setTool(t);
  };
  const pick = (apply: () => void) => {
    apply();
    setPanel(null);
    if (overlay) void screen.setPassthrough(false);
  };
  return (
    <div className="toolbox">
      {panel && <div className="tool-options" role="group" aria-label={panel === 'brush' ? '笔刷选项' : '图形选项'}>
        {panel === 'brush' ? <>
          {BRUSHES.map((b) => <button key={b} className="tool" aria-pressed={brush === b} aria-label={BRUSH_NAMES[b]} title={BRUSH_NAMES[b]} onClick={() => pick(() => setBrush(b))}>{BrushIcons[b]}</button>)}
          <button className="tool" aria-pressed={autoShape} aria-label="停笔规整图形" title="停笔规整图形" onClick={() => setAutoShape(!autoShape)}>{AutoShapeIcon}</button>
          <button className="tool" aria-pressed={autoRecognize} aria-label="手写识别文字" title="手写识别文字" onClick={() => setAutoRecognize(!autoRecognize)}>{AutoRecognizeIcon}</button>
        </> : SHAPES.map((k) => <button key={k} className="tool" aria-pressed={shape === k} aria-label={SHAPE_NAMES[k]} title={SHAPE_NAMES[k]} onClick={() => pick(() => setShape(k))}>{ShapeIcons[k]}</button>)}
      </div>}
      <div className="toolbar" role="toolbar" aria-label="绘图工具" onMouseDown={(e) => e.preventDefault()}>
        <div className="toolbar-group">{TOOLS.map((t) => <button key={t} className="tool" aria-label={t === 'pen' ? `画笔与笔刷 · ${BRUSH_NAMES[brush]}` : TOOL_LABELS[t]} aria-pressed={tool === t} title={`${t === 'pen' ? `笔刷：${BRUSH_NAMES[brush]}` : TOOL_LABELS[t]} ${TOOL_KEYS[t]}`} onClick={() => choose(t)}>{ToolIcons[t]}</button>)}</div>
        <div className="toolbar-group" role="radiogroup" aria-label="墨迹颜色">{INK.map((hex, i) => <button key={hex} className="tool swatch" role="radio" aria-checked={color === i} aria-label={INK_NAMES[i]} title={`${INK_NAMES[i]} ${i + 1}`} style={{ '--swatch': `var(--ink-${i + 1}${i === 0 ? '-display' : ''})` } as CSSProperties} onClick={() => setColor(i)}><span /></button>)}</div>
        <div className="toolbar-group" role="radiogroup" aria-label="粗细">{SIZES.map((w, i) => <button key={w} className="tool size" role="radio" aria-checked={size === i} aria-label={SIZE_NAMES[i]} title={`${SIZE_NAMES[i]} [ ]`} onClick={() => setSize(i)}><span style={{ width: 4 + i * 4, height: 4 + i * 4 }} /></button>)}</div>
        <div className="toolbar-group">
          <button className="tool" aria-label="撤销" title="撤销 ⌘Z" disabled={overlay ? !screen.ink.canUndo : !mainUndo} onClick={() => overlay ? void screen.command('undo') : void edit({ type: 'undo' })}>{UndoIcon}</button>
          <button className="tool" aria-label="重做" title="重做 ⇧⌘Z" disabled={overlay ? !screen.ink.canRedo : !mainRedo} onClick={() => overlay ? void screen.command('redo') : void edit({ type: 'redo' })}>{RedoIcon}</button>
        </div>
      </div>
    </div>
  );
}
