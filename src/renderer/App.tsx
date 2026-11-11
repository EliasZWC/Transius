import { useEffect } from 'react';
import { useI18n } from './i18n/context';
import { dict, type DictKey } from './i18n/dict';
import { useAppActions, useAppState } from './state/context';
import { Sidebar } from './components/Sidebar';
import { FilePane } from './components/FilePane';
import { TransferPanel } from './components/TransferPanel';
import { TitleBar } from './components/TitleBar';
import { IconClose } from './components/icons';

export function App() {
  const { toast } = useAppState();
  const { clearToast } = useAppActions();

  return (
    <div className="app">
      <TitleBar />

      <div className="main">
        <Sidebar />
        <div className="workspace">
          <div className="panes">
            <FilePane side="local" />
            <FilePane side="remote" />
          </div>
          <TransferPanel />
        </div>
      </div>

      {toast && <Toast kind={toast.kind} text={toast.text} onClose={clearToast} />}
    </div>
  );
}

/** Toast：text 可能是 i18n key，也可能是主进程返回的 `CODE: ...` */
function Toast({
  kind,
  text,
  onClose,
}: {
  kind: 'error' | 'info';
  text: string;
  onClose: () => void;
}) {
  const { t, tError, lang } = useI18n();

  // 统一解析：先看成 i18n key（如 "err.AUTH_FAILED"），再退回错误码解析
  let message: string;
  if (text.startsWith('err.')) {
    const code = text.slice(4);
    const entry = dict[`err.${code}` as DictKey];
    message = entry ? entry[lang] : tError(text);
  } else {
    message = tError(text);
  }

  // 5 秒后自动消失（错误保留更久，便于阅读）
  useEffect(() => {
    const timer = window.setTimeout(onClose, kind === 'error' ? 8000 : 3000);
    return () => window.clearTimeout(timer);
  }, [onClose, kind]);

  return (
    <div className={`toast ${kind}`} role="status">
      <span className="toast-text">{message || text}</span>
      <button className="toast-close" onClick={onClose} aria-label={t('common.close')}>
        <IconClose size={13} />
      </button>
    </div>
  );
}
