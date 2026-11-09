import { useEffect, useState } from 'react';
import { useOverlay, DEFAULT_BACKDROP } from '../../stores/overlay';
import { useTools } from '../../stores/tools';
import { Toolbar } from '../toolbar/Toolbar';

export function OverlayToolbar() {
  const screen = useOverlay();
  const toolPanel = useTools((s) => s.panel);
  const setToolPanel = useTools((s) => s.setPanel);
  const [panel, setPanel] = useState<'help' | 'backdrop' | null>(null);
  const [clearing, setClearing] = useState(false);
  // One flyout at a time: a toolbar flyout closes this panel, and vice versa.
  useEffect(() => {
    if (toolPanel) setPanel(null);
  }, [toolPanel]);
  const togglePanel = (p: 'help' | 'backdrop') => {
    setToolPanel(null);
    setPanel(panel === p ? null : p);
  };
  return (
    <div className="overlay-toolbar-container">
      {screen.error && <div className="screen-error" role="alert"><span>{screen.error}</span><button onClick={screen.dismissError}>关闭</button></div>}
      {panel === 'help' && <section className="screen-panel" aria-label="屏幕讲解指南">
        <div className="option-heading"><strong>在屏幕上讲解</strong><button onClick={() => setPanel(null)}>知道了</button></div>
        <p><kbd>⌥Space</kbd> 呼出 / 收起 · <kbd>⌥P</kbd> 或 <kbd>Esc</kbd> 在绘制与穿透间切换；穿透时聚光灯标示鼠标位置。画笔、图形、文字与画布一致；按住 <kbd>\</kbd> 临时看清底图。</p>
        <p>标注为临时内容，退出应用即清除，清屏可撤销。工具栏是否被观众看到取决于会议软件。</p>
      </section>}
      {panel === 'backdrop' && <section className="screen-panel" aria-label="背景压暗">
        <div className="option-heading"><strong>让背景退后</strong><button onClick={() => setPanel(null)}>完成</button></div>
        <label className="backdrop-menu-row">压暗 {Math.round(screen.state.backdrop.dim_opacity * 100)}%<input aria-label="背景压暗程度" type="range" min="0" max="0.85" step="0.05" value={screen.state.backdrop.dim_opacity} onChange={(e) => void screen.setBackdrop({ dim_opacity: Number(e.target.value), blur_px: 0, desaturate: 0 })} /></label>
        <div className="screen-actions"><button onClick={() => void screen.setBackdrop({ dim_opacity: 0 })}>透明</button><button onClick={() => void screen.setBackdrop(DEFAULT_BACKDROP)}>柔和</button><button onClick={() => void screen.setBackdrop({ dim_opacity: 0.65 })}>专注</button></div>
      </section>}
      <Toolbar overlay />
      <div className="screen-controls" role="toolbar" aria-label="屏幕讲解控制">
        <span className="screen-drag" data-tauri-drag-region title="拖动工具栏" aria-label="拖动工具栏">⠿</span>
        <button className="screen-mode" aria-pressed={screen.state.passthrough} onClick={() => void screen.setPassthrough(!screen.state.passthrough)} title="绘制 / 穿透 · ⌥P 或 Esc">{screen.state.passthrough ? '穿透中' : '绘制中'}</button>
        <button aria-expanded={panel === 'backdrop'} onClick={() => togglePanel('backdrop')}>背景</button>
        {screen.ink.selected && <button onClick={() => void screen.command('normalize')}>规整</button>}
        {screen.ink.selected && <button onClick={() => void screen.command('delete')}>删除</button>}
        <button disabled={!screen.ink.count} onClick={() => setClearing(!clearing)}>清屏</button>
        <button aria-expanded={panel === 'help'} aria-label="帮助" title="帮助" onClick={() => togglePanel('help')}>?</button>
        <button onClick={() => void screen.toggle(false)}>结束</button>
      </div>
      {clearing && <div className="screen-confirm" role="group" aria-label="确认清屏"><span>清除全部 {screen.ink.count} 个标注？可撤销。</span><button onClick={() => { void screen.clearInk(); setClearing(false); }}>清除</button><button onClick={() => setClearing(false)}>取消</button></div>}
    </div>
  );
}
