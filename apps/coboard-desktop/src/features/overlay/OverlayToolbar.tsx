import { useEffect, useRef, useState } from 'react';
import { DEFAULT_BACKDROP, useOverlay } from '../../stores/overlay';
import { useTools } from '../../stores/tools';
import { BackdropIcon, CloseIcon, HelpIcon, PassthroughIcon, TrashIcon } from '../toolbar/icons';
import { Toolbar } from '../toolbar/Toolbar';

export function OverlayToolbar() {
  const screen = useOverlay();
  const toolPanel = useTools((s) => s.panel);
  const setToolPanel = useTools((s) => s.setPanel);
  const [panel, setPanel] = useState<'help' | 'backdrop' | null>(null);
  const [clearNotice, setClearNotice] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dismissClearNotice = () => {
    clearTimeout(clearTimer.current);
    setClearNotice(null);
  };

  // One popover or toast at a time so popovers never collide with the undo toast.
  useEffect(() => {
    if (toolPanel) {
      setPanel(null);
      dismissClearNotice();
    }
  }, [toolPanel]);

  useEffect(() => {
    if (!panel) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPanel(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanel(null);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [panel]);

  useEffect(() => () => clearTimeout(clearTimer.current), []);

  const togglePanel = (p: 'help' | 'backdrop') => {
    setToolPanel(null);
    dismissClearNotice();
    setPanel((cur) => (cur === p ? null : p));
  };

  const handleClear = () => {
    const count = screen.ink.count;
    if (!count) return;
    setPanel(null);
    setToolPanel(null);
    void screen.clearInk();
    clearTimeout(clearTimer.current);
    setClearNotice(count);
    clearTimer.current = setTimeout(() => setClearNotice(null), 3500);
  };

  const handleUndoClear = () => {
    dismissClearNotice();
    void screen.command('undo');
  };

  const leading = (
    <span className="screen-drag" data-tauri-drag-region title="拖动工具栏" aria-label="拖动工具栏">
      ⠿
    </span>
  );

  const trailing = (
    <div className="toolbar-group" role="group" aria-label="屏幕控制">
      <button
        type="button"
        className="screen-mode"
        aria-pressed={screen.state.passthrough}
        onClick={() => {
          setPanel(null);
          dismissClearNotice();
          void screen.setPassthrough(!screen.state.passthrough);
        }}
        title="绘制 / 穿透 · ⌥P 或 Esc"
      >
        {PassthroughIcon}
        <span>{screen.state.passthrough ? '穿透中' : '绘制中'}</span>
      </button>

      <div className="popover-anchor">
        <button
          type="button"
          className="tool"
          aria-label="背景压暗"
          aria-expanded={panel === 'backdrop'}
          aria-pressed={panel === 'backdrop'}
          title="背景压暗"
          onClick={() => togglePanel('backdrop')}
        >
          {BackdropIcon}
        </button>
        {panel === 'backdrop' && (
          <section className="screen-panel popover-card popover-right" aria-label="背景压暗">
            <div className="option-heading">
              <strong>背景压暗</strong>
              <span className="option-value">{Math.round(screen.state.backdrop.dim_opacity * 100)}%</span>
            </div>
            <label className="backdrop-menu-row">
              <input
                aria-label="背景压暗程度"
                type="range"
                min="0"
                max="0.85"
                step="0.05"
                value={screen.state.backdrop.dim_opacity}
                onChange={(e) => void screen.setBackdrop({ dim_opacity: Number(e.target.value), blur_px: 0, desaturate: 0 })}
              />
            </label>
            <div className="screen-actions">
              <button type="button" onClick={() => void screen.setBackdrop({ dim_opacity: 0 })}>透明</button>
              <button type="button" onClick={() => void screen.setBackdrop(DEFAULT_BACKDROP)}>柔和</button>
              <button type="button" onClick={() => void screen.setBackdrop({ dim_opacity: 0.65 })}>专注</button>
            </div>
          </section>
        )}
      </div>

      <button
        type="button"
        className="tool"
        aria-label="一键清屏"
        title="一键清屏（可撤销）"
        disabled={!screen.ink.count}
        onClick={handleClear}
      >
        {TrashIcon}
      </button>

      <div className="popover-anchor">
        <button
          type="button"
          className="tool"
          aria-label="帮助"
          aria-expanded={panel === 'help'}
          aria-pressed={panel === 'help'}
          title="快捷键与说明"
          onClick={() => togglePanel('help')}
        >
          {HelpIcon}
        </button>
        {panel === 'help' && (
          <section className="screen-panel popover-card popover-right" aria-label="屏幕讲解指南">
            <div className="option-heading">
              <strong>屏幕讲解</strong>
              <button type="button" onClick={() => setPanel(null)}>关闭</button>
            </div>
            <p><kbd>⌥Space</kbd> 呼出/收起 · <kbd>⌥P</kbd> / <kbd>Esc</kbd> 切换穿透（聚光环跟随鼠标）· 按住 <kbd>\</kbd> 临时看清底图。</p>
            <p><kbd>V</kbd> 框选 · <kbd>Q</kbd> 套索 · <kbd>C</kbd> 连接线 · <kbd>S</kbd> 图形 · <kbd>⌘G</kbd>/<kbd>⇧⌘G</kbd> 组合/拆组 · 标注可 <kbd>⌘Z</kbd> 撤销。</p>
          </section>
        )}
      </div>

      <button
        type="button"
        className="tool screen-exit"
        aria-label="结束屏幕讲解"
        title="结束 ⌥Space"
        onClick={() => void screen.toggle(false)}
      >
        {CloseIcon}
      </button>
    </div>
  );

  return (
    <div ref={rootRef} className="overlay-toolbar-container">
      {screen.error && (
        <div className="screen-error" role="alert">
          <span>{screen.error}</span>
          <button type="button" onClick={screen.dismissError}>关闭</button>
        </div>
      )}
      {clearNotice !== null && (
        <div className="screen-toast" role="status">
          <span>已清除 {clearNotice} 个标注</span>
          <button type="button" onClick={handleUndoClear}>撤销 ⌘Z</button>
        </div>
      )}
      <Toolbar
        overlay
        leading={leading}
        trailing={trailing}
        onToolInteract={() => {
          setPanel(null);
          dismissClearNotice();
        }}
      />
    </div>
  );
}
