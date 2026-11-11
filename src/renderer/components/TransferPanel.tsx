import { useState } from 'react';
import type { TransferItem } from '@shared/types';
import { formatSize, formatSpeed } from '@shared/paths';
import { useI18n } from '../i18n/context';
import { useAppActions, useAppState } from '../state/context';
import type { DictKey } from '../i18n/dict';
import {
  IconChevronDown,
  IconChevronUp,
  IconClose,
  IconDelete,
  IconDownload,
  IconPause,
  IconPlay,
  IconRetry,
  IconTransfer,
  IconUpload,
} from './icons';

export function TransferPanel() {
  const { t, tError } = useI18n();
  const { transfers } = useAppState();
  const {
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    retryTransfer,
    removeTransfer,
    clearFinished,
  } = useAppActions();

  const [collapsed, setCollapsed] = useState(false);

  const active = transfers.filter(
    (x) => x.state === 'active' || x.state === 'queued' || x.state === 'scanning',
  ).length;
  const finished = transfers.filter(
    (x) => x.state === 'completed' || x.state === 'canceled' || x.state === 'error',
  ).length;

  return (
    <div className={`transfer-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="transfer-head">
        <button
          className="btn ghost icon sm"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? t('transfer.title') : t('common.close')}
        >
          {collapsed ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        </button>
        <span className="transfer-title">
          <IconTransfer size={14} />
          {t('transfer.title')}
          {transfers.length > 0 && <span className="transfer-count">{active}</span>}
        </span>
        <span className="spacer" />
        {finished > 0 && (
          <button className="btn sm ghost" onClick={() => void clearFinished()}>
            <IconDelete size={12} />
            {t('transfer.clearFinished')}
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="transfer-list">
          {transfers.length === 0 && (
            <div className="pane-empty">{t('transfer.empty')}</div>
          )}
          {transfers.map((item) => (
            <TransferRow
              key={item.id}
              item={item}
              onPause={() => void pauseTransfer(item.id)}
              onResume={() => void resumeTransfer(item.id)}
              onCancel={() => void cancelTransfer(item.id)}
              onRetry={() => void retryTransfer(item.id)}
              onRemove={() => void removeTransfer(item.id)}
              tState={t(`transfer.state.${item.state}` as DictKey)}
              tFiles={
                item.fileCount
                  ? t('transfer.files', {
                      done: item.filesDone ?? 0,
                      total: item.fileCount,
                    })
                  : undefined
              }
              tError={tError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TransferRow({
  item,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRemove,
  tState,
  tFiles,
  tError,
}: {
  item: TransferItem;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onRemove: () => void;
  tState: string;
  tFiles?: string;
  tError: (raw: string) => string;
}) {
  const pct = item.size > 0 ? Math.min(100, (item.transferred / item.size) * 100) : 0;
  const isActive = item.state === 'active';
  const isPaused = item.state === 'paused';
  const isError = item.state === 'error';
  const isQueued = item.state === 'queued' || item.state === 'scanning';
  const isDone = item.state === 'completed';

  const fillClass = isDone ? 'progress-fill done' : isError ? 'progress-fill err' : 'progress-fill';

  return (
    <div className="transfer-row">
      <div className="transfer-dir-arrow" title={item.direction}>
        {item.direction === 'upload' ? (
          <IconUpload size={14} style={{ color: 'var(--on-surface-variant)' }} />
        ) : (
          <IconDownload size={14} style={{ color: 'var(--on-surface-variant)' }} />
        )}
      </div>

      <div className="transfer-main">
        <div className="transfer-name" title={item.name}>
          {item.name}
        </div>
        <div className="transfer-sub" title={item.direction === 'upload' ? item.remotePath : item.localPath}>
          {item.direction === 'upload' ? '→ ' : '← '}
          {item.direction === 'upload' ? item.remotePath : item.localPath}
        </div>
      </div>

      <div className="progress-wrap">
        <div className="progress-bar">
          <div className={fillClass} style={{ width: `${pct}%` }} />
        </div>
        <div className="progress-text">
          <span>
            {formatSize(item.transferred)} / {formatSize(item.size)}
          </span>
          <span>{isActive && item.speed > 0 ? formatSpeed(item.speed) : `${pct.toFixed(0)}%`}</span>
        </div>
      </div>

      <div className={`state-label ${item.state}`}>
        {item.state === 'active' && tFiles ? tFiles : tState}
        {isError && item.error && (
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2 }}>
            {tError(item.error)}
          </div>
        )}
      </div>

      <div className="transfer-actions">
        {(isActive || isQueued) && (
          <button className="btn ghost icon sm" title="Pause" onClick={onPause}>
            <IconPause size={12} />
          </button>
        )}
        {isPaused && (
          <button className="btn ghost icon sm" title="Resume" onClick={onResume}>
            <IconPlay size={12} />
          </button>
        )}
        {isError && (
          <button className="btn ghost icon sm" title="Retry" onClick={onRetry}>
            <IconRetry size={12} />
          </button>
        )}
        {!isDone && item.state !== 'canceled' && (
          <button className="btn ghost icon sm" title="Cancel" onClick={onCancel}>
            <IconClose size={12} />
          </button>
        )}
        {isDone || item.state === 'canceled' || isError ? (
          <button className="btn ghost icon sm" title="Remove" onClick={onRemove}>
            <IconDelete size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
