import { useState } from 'react';
import type { ConnectionProfile, ConnectionProfileInput, SshAuthMethod } from '@shared/types';
import { useI18n } from '../i18n/context';
import { useAppActions } from '../state/context';
import { IconKey, IconLoader, IconLock, IconServer, IconClose } from './icons';

interface Props {
  /** 正在编辑的配置；null 表示新建 */
  editing: ConnectionProfile | null;
  onClose: () => void;
}

export function ProfileDialog({ editing, onClose }: Props) {
  const { t, tError } = useI18n();
  const { connect, saveProfile } = useAppActions();

  const [name, setName] = useState(editing?.name ?? '');
  const [host, setHost] = useState(editing?.host ?? '');
  const [port, setPort] = useState(String(editing?.port ?? 22));
  const [username, setUsername] = useState(editing?.username ?? '');
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>(
    editing?.authMethod ?? 'password',
  );
  const [password, setPassword] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState(editing?.privateKeyPath ?? '');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(Boolean(editing));
  const [remotePath, setRemotePath] = useState(editing?.remotePath ?? '');
  const [localPath, setLocalPath] = useState(editing?.localPath ?? '');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const hasSavedCredential = Boolean(editing);

  const pickKey = async () => {
    const res = await window.transius.profile.pickPrivateKey();
    if (!res.ok || !res.data) return;
    setPrivateKeyPath(res.data.path);
    setPrivateKey(res.data.content);
  };

  const pickLocal = async () => {
    const dir = await window.transius.dialog.pickLocalDirectory();
    if (dir) setLocalPath(dir);
  };

  const buildInput = (): ConnectionProfileInput | null => {
    if (!host.trim() || !username.trim()) {
      setError('err.REQUIRED');
      return null;
    }
    if (authMethod === 'password' && !password && !hasSavedCredential) {
      setError('err.AUTH_REQUIRED');
      return null;
    }
    if (authMethod === 'privateKey' && !privateKeyPath) {
      setError('err.AUTH_REQUIRED');
      return null;
    }
    return {
      id: editing?.id,
      name: name.trim() || host.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      authMethod,
      privateKeyPath: authMethod === 'privateKey' ? privateKeyPath : undefined,
      remotePath: remotePath.trim(),
      localPath: localPath.trim() || undefined,
      password: password || undefined,
      privateKey: privateKey || undefined,
      passphrase: passphrase || undefined,
      rememberSecret: remember,
    };
  };

  const doSave = async (andConnect: boolean) => {
    const input = buildInput();
    if (!input) return;
    setError(null);
    const ok = await saveProfile(input);
    if (!ok) {
      setError(t('err.UNKNOWN'));
      return;
    }
    if (andConnect) {
      setConnecting(true);
      // 保存后需要拿到真实 id 才能连接
      const listRes = await window.transius.profile.list();
      const list = listRes.ok ? listRes.data : [];
      const saved =
        list.find((p) => p.id === editing?.id) ?? list[list.length - 1];
      if (!saved) {
        setConnecting(false);
        return;
      }
      const res = await connect({
        profileId: saved.id,
        password: password || undefined,
        passphrase: passphrase || undefined,
      });
      setConnecting(false);
      if (res) onClose();
      else setError(t('err.AUTH_FAILED'));
      return;
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <span>{editing ? t('conn.editTitle') : t('conn.newTitle')}</span>
          <span className="spacer" />
          <button className="btn ghost icon" onClick={onClose} aria-label={t('common.close')}>
            <IconClose size={15} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>{t('conn.name')}</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={host || 'My server'}
              autoFocus
            />
          </div>

          <div className="form-grid">
            <div className="field">
              <label>{t('conn.host')}</label>
              <input
                className="input"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.10"
              />
            </div>
            <div className="field">
              <label>{t('conn.port')}</label>
              <input
                className="input"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="22"
              />
            </div>
            <div className="field span-2">
              <label>{t('conn.username')}</label>
              <input
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="root"
              />
            </div>
          </div>

          <div className="field">
            <label>{t('conn.auth')}</label>
            <select
              className="select"
              value={authMethod}
              onChange={(e) => setAuthMethod(e.target.value as SshAuthMethod)}
            >
              <option value="password">{t('conn.authPassword')}</option>
              <option value="privateKey">{t('conn.authKey')}</option>
            </select>
          </div>

          {authMethod === 'password' ? (
            <div className="field">
              <label>{t('conn.password')}</label>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={hasSavedCredential ? t('conn.savedPassword') : ''}
              />
            </div>
          ) : (
            <>
              <div className="field">
                <label>{t('conn.keyFile')}</label>
                <div className="row">
                  <input
                    className="input"
                    value={privateKeyPath}
                    onChange={(e) => setPrivateKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                  />
                  <button className="btn" onClick={pickKey} type="button">
                    <IconKey size={14} />
                    {t('conn.chooseKey')}
                  </button>
                </div>
              </div>
              <div className="field">
                <label>{t('conn.passphrase')}</label>
                <input
                  className="input"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={hasSavedCredential ? t('conn.savedPassword') : ''}
                />
              </div>
            </>
          )}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <IconLock size={13} />
            {t('conn.remember')}
          </label>

          <div className="form-grid">
            <div className="field">
              <label>{t('conn.remotePath')}</label>
              <input
                className="input"
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                placeholder="/home/user"
              />
            </div>
            <div className="field">
              <label>{t('conn.localPath')}</label>
              <div className="row">
                <input
                  className="input"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder="C:\\Users"
                />
                <button className="btn icon" onClick={pickLocal} type="button">
                  <IconServer size={14} />
                </button>
              </div>
            </div>
          </div>

          {error && (
            <div style={{ color: 'var(--danger)', fontSize: 12 }}>{tError(error)}</div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            {t('conn.cancel')}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => void doSave(false)} disabled={connecting}>
            {t('conn.save')}
          </button>
          <button
            className="btn primary"
            onClick={() => void doSave(true)}
            disabled={connecting}
          >
            {connecting && <IconLoader size={13} className="spin" />}
            {connecting ? t('conn.connecting') : t('conn.saveAndConnect')}
          </button>
        </div>
      </div>
    </div>
  );
}
