import { useSession } from '../../stores/session';

/** Top-centre toasts. Only states the user can act on; diagnostics stay in the save-status tooltip. */
export function Notices() {
  const { session, status, error, rejected, queue, retry, load, dismissRejected } = useSession();
  const hasImages = !!session && Object.values(session.document.nodes).some((n) => n[0] === 'image');
  const missing = session?.recovery.missing_assets.length ?? 0;
  return (
    <div className="notices">
      {error && status === 'failed' && (
        <div className="toast is-danger" role="alert">
          <div>
            <strong>{queue.length ? `${queue.length} 项内容尚未保存` : '本地存储未就绪'}</strong>
            <p>{error.message}{queue.length ? '内容仍保留在画布上。' : ''}</p>
          </div>
          <button onClick={() => void retry()}>重试</button>
        </div>
      )}
      {rejected && (
        <div className="toast" role="alert">
          <div>
            <strong>有一项操作未能执行</strong>
            <p>{rejected.message}</p>
          </div>
          <button onClick={dismissRejected}>知道了</button>
        </div>
      )}
      {missing > 0 && (
        <div className="toast" role="alert">
          <div>
            <strong>{missing} 项图片资源缺失</strong>
            <p>其他内容已恢复，原始引用已保留。</p>
          </div>
        </div>
      )}
      {hasImages && session?.gateway_unavailable && (
        <div className="toast">
          <div>
            <strong>图片暂时无法显示</strong>
            <p>书写与保存不受影响。</p>
          </div>
          <button onClick={() => void load()}>重试</button>
        </div>
      )}
    </div>
  );
}
