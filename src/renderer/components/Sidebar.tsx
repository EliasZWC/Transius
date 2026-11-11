import { useState } from 'react';
import type { ConnectionProfile } from '@shared/types';
import { useI18n } from '../i18n/context';
import { useAppActions, useAppState } from '../state/context';
import { ProfileDialog } from './ProfileDialog';
import { IconAdd, IconEdit, IconLoader, IconPlug, IconServer, IconDelete } from './icons';

export function Sidebar() {
  const { t, tError } = useI18n();
  const { profiles, connected, busy, toast } = useAppState();
  const { deleteProfile, connect, disconnect, refreshConnection } = useAppActions();

  const [dialog, setDialog] = useState<{ open: boolean; editing: ConnectionProfile | null }>({
    open: false,
    editing: null,
  });
  /** 正在连接的配置 id，用于显示 spinner */
  const [pendingId, setPendingId] = useState<string | null>(null);

  /** 双击连接：若无已保存的密码会失败，此时自动打开编辑框让用户补录 */
  const quickConnect = async (p: ConnectionProfile) => {
    setPendingId(p.id);
    const ok = await connect({ profileId: p.id });
    setPendingId(null);
    if (!ok) setDialog({ open: true, editing: p });
  };

  const primaryAction = async () => {
    if (connected) {
      await disconnect();
      return;
    }
    if (profiles.length === 0) {
      setDialog({ open: true, editing: null });
      return;
    }
    // 最近连接过的优先
    const latest = [...profiles].sort(
      (a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0),
    )[0];
    await quickConnect(latest);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>{t('conn.title')}</span>
        <button
          className="btn ghost icon"
          title={t('conn.new')}
          onClick={() => setDialog({ open: true, editing: null })}
        >
          <IconAdd size={15} />
        </button>
      </div>

      <div className="profile-list">
        {profiles.length === 0 && (
          <div className="empty-hint">
            {t('conn.empty')}
            <br />
            {t('conn.emptyHint')}
          </div>
        )}
        {profiles.map((p) => (
          <div
            key={p.id}
            className={`profile-item${connected && pendingId === p.id ? ' active' : ''}`}
            onDoubleClick={() => void quickConnect(p)}
            title={`${p.username}@${p.host}:${p.port}`}
          >
            <div className="profile-icon">
              {pendingId === p.id ? (
                <IconLoader size={14} className="spin" />
              ) : (
                <IconServer size={14} />
              )}
            </div>
            <div className="profile-meta">
              <div className="profile-name">{p.name}</div>
              <div className="profile-sub">
                {p.username}@{p.host}
              </div>
            </div>
            <div className="profile-actions">
              <button
                className="btn ghost icon sm"
                title={t('conn.edit')}
                onClick={(e) => {
                  e.stopPropagation();
                  setDialog({ open: true, editing: p });
                }}
              >
                <IconEdit size={13} />
              </button>
              <button
                className="btn ghost icon sm"
                title={t('conn.delete')}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(t('conn.deleteConfirm', { name: p.name }))) {
                    void deleteProfile(p.id);
                  }
                }}
              >
                <IconDelete size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <button
          className="btn primary"
          style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy || pendingId !== null}
          onClick={() => void primaryAction()}
        >
          {busy || pendingId ? (
            <IconLoader size={14} className="spin" />
          ) : (
            <IconPlug size={14} />
          )}
          {busy || pendingId
            ? t('conn.connecting')
            : connected
              ? t('conn.disconnect')
              : t('conn.connect')}
        </button>
        {toast?.kind === 'error' && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              color: 'var(--danger)',
              lineHeight: 1.5,
              userSelect: 'text',
            }}
          >
            {tError(toast.text)}
          </div>
        )}
      </div>

      {dialog.open && (
        <ProfileDialog
          editing={dialog.editing}
          onClose={() => {
            setDialog({ open: false, editing: null });
            void refreshConnection();
          }}
        />
      )}
    </aside>
  );
}
