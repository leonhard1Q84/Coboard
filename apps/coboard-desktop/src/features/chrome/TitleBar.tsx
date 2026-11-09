import { useEffect, useState } from 'react';
import { optimisticDocument, EMPTY_DOCUMENT } from '../../stores/document';
import { useOverlay } from '../../stores/overlay';
import { useSession, type SaveStatus } from '../../stores/session';
import { ScreenShareIcon } from '../toolbar/icons';

/** Brief saves never flash "保存中" during a talk; only slow or failed saves surface. */
function useSettledStatus(status: SaveStatus) {
  const [shown, setShown] = useState(status);
  useEffect(() => {
    if (status === 'saved' || status === 'failed') {
      setShown(status);
      return;
    }
    const timer = setTimeout(() => setShown(status), 600);
    return () => clearTimeout(timer);
  }, [status]);
  return shown;
}

const LABELS: Record<SaveStatus, string> = { loading: '正在打开', pending: '保存中', saving: '保存中', saved: '已保存', failed: '保存失败' };

export function TitleBar() {
  const session = useSession((s) => s.session);
  const queue = useSession((s) => s.queue);
  const status = useSession((s) => s.status);
  const edit = useSession((s) => s.edit);
  const retry = useSession((s) => s.retry);
  const shown = useSettledStatus(status);
  const title = optimisticDocument(session?.document ?? EMPTY_DOCUMENT, queue.map((q) => q.action)).title;
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    const next = draft?.trim();
    setDraft(null);
    if (next && next !== title) void edit({ type: 'edit', operations: [{ type: 'rename', title: next.slice(0, 128) }] });
  };
  const diagnostics = session
    ? `修订 ${session.document.revision} · ${session.package_path}${queue.length ? ` · 待写入 ${queue.length}` : ''}`
    : '尚未连接本地存储';

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-inner" data-tauri-drag-region>
        {draft === null ? (
          <button className="title" title="重命名" onClick={() => setDraft(title)}>
            {title}
          </button>
        ) : (
          <input
            className="title-input"
            value={draft}
            maxLength={128}
            autoFocus
            aria-label="画布名称"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setDraft(null);
            }}
          />
        )}
        {shown === 'failed' && !session && !queue.length ? (
          <span className="save-status is-failed" role="status" title={diagnostics}>
            <span className="dot" />
            未连接本地存储
          </span>
        ) : shown === 'failed' ? (
          <button className={`save-status is-failed`} role="status" title={diagnostics} onClick={() => void retry()}>
            <span className="dot" />
            保存失败 · 重试
          </button>
        ) : (
          <span className={`save-status is-${shown}`} role="status" title={diagnostics} data-tauri-drag-region>
            <span className="dot" />
            {LABELS[shown]}
          </span>
        )}
        <button
          className="btn-overlay-toggle"
          title="呼出屏幕覆盖层 (⌥Space)"
          aria-label="呼出屏幕覆盖层"
          onClick={() => void useOverlay.getState().toggle(true)}
        >
          {ScreenShareIcon}
          <span>覆盖层</span>
        </button>
      </div>
    </header>
  );
}
