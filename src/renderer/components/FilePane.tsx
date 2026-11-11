import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LocalEntry, RemoteEntry } from '@shared/types';
import { formatSize, formatTime, posixJoin } from '@shared/paths';
import { useI18n } from '../i18n/context';
import { useAppActions, useAppState, type DropItem, type Side } from '../state/context';
import {
  IconArrowUp,
  IconDownload,
  IconFile,
  IconFolder,
  IconCreateFolder,
  IconHome,
  IconLink,
  IconLoader,
  IconRefresh,
  IconUpload,
  IconClose,
} from './icons';

type Entry = LocalEntry | RemoteEntry;

interface Props {
  side: Side;
}

export function FilePane({ side }: Props) {
  const { t } = useI18n();
  const { local, remote, connected, settings } = useAppState();
  const actions = useAppActions();

  const listing = side === 'local' ? local : remote;
  const isRemote = side === 'remote';

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pathInput, setPathInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const lastClicked = useRef<string | null>(null);

  // 目录变化时清空选择并同步路径栏
  useEffect(() => {
    setSelected(new Set());
    setPathInput(listing?.path ?? '');
    lastClicked.current = null;
  }, [listing?.path, side]);

  const entries = useMemo(() => {
    const all = listing?.entries ?? [];
    return settings.showHiddenFiles
      ? all
      : all.filter((e) => !e.name.startsWith('.'));
  }, [listing?.entries, settings.showHiddenFiles]);

  const navigate = useCallback(
    (dir: string | null) => {
      if (isRemote) void actions.navigateRemote(dir);
      else void actions.navigateLocal(dir);
    },
    [actions, isRemote],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      if (isRemote) {
        if (!listing) return;
        await actions.navigateRemote(listing.path);
      } else {
        await actions.navigateLocal(listing?.path ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, [actions, isRemote, listing]);

  const submitPath = () => {
    const value = pathInput.trim();
    if (!value) return;
    navigate(value);
  };

  // ---------- 选择逻辑 ----------
  const onRowClick = (e: React.MouseEvent, entry: Entry) => {
    if (e.shiftKey && lastClicked.current) {
      const names = entries.map((x) => x.name);
      const a = names.indexOf(lastClicked.current);
      const b = names.indexOf(entry.name);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(names.slice(lo, hi + 1)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(entry.name)) next.delete(entry.name);
      else next.add(entry.name);
      setSelected(next);
      lastClicked.current = entry.name;
      return;
    }
    setSelected(new Set([entry.name]));
    lastClicked.current = entry.name;
  };

  const openEntry = (entry: Entry) => {
    if (entry.type === 'd') navigate(entry.path);
    else if (!isRemote) void window.transius.dialog.openPathInShell(entry.path);
  };

  // ---------- 传输操作 ----------
  const transferSelected = async () => {
    const names = [...selected];
    if (names.length === 0) return;
    if (isRemote) await actions.enqueueDownload(names);
    else {
      const paths = entries.filter((e) => selected.has(e.name)).map((e) => e.path);
      await actions.enqueueUpload(paths);
    }
  };

  // ---------- 拖拽 ----------
  const dragItems = (): DropItem[] =>
    entries
      .filter((e) => selected.has(e.name))
      .map((e) => ({
        path: e.path,
        name: e.name,
        isDirectory: e.type === 'd',
        size: e.size,
      }));

  const onDragStart = (e: React.DragEvent) => {
    // 拖动行但该行未被选中时，先只拖该行
    const target = e.currentTarget as HTMLElement;
    const name = target.dataset.name;
    let items = dragItems();
    if (name && !selected.has(name)) {
      const entry = entries.find((x) => x.name === name);
      if (entry) {
        items = [
          {
            path: entry.path,
            name: entry.name,
            isDirectory: entry.type === 'd',
            size: entry.size,
          },
        ];
        setSelected(new Set([entry.name]));
      }
    }
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/x-transius-side', side);
    e.dataTransfer.setData('application/x-transius-items', JSON.stringify(items));
    // 兼容：也放纯文本，便于调试与外部拖拽
    e.dataTransfer.setData('text/plain', items.map((i) => i.path).join('\n'));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const fromSide = e.dataTransfer.getData('application/x-transius-side') as Side | '';
    if (!fromSide || fromSide === side) return;
    const raw = e.dataTransfer.getData('application/x-transius-items');
    if (!raw) return;
    try {
      const items = JSON.parse(raw) as DropItem[];
      void actions.enqueueDrop(fromSide, items);
    } catch {
      // 忽略无法解析的载荷
    }
  };

  // ---------- 远程目录操作 ----------
  const createFolder = async () => {
    const name = window.prompt(t('fs.newFolderPrompt'), '');
    if (!name) return;
    const base = listing?.path ?? '/';
    const r = await window.transius.fs.mkdirRemote(posixJoin(base, name));
    if (!r.ok) actions.showError(r.error);
    else void reload();
  };

  const renameSelected = async () => {
    const name = [...selected][0];
    if (!name || !listing) return;
    const entry = entries.find((e) => e.name === name);
    if (!entry) return;
    const next = window.prompt(t('fs.renamePrompt'), name);
    if (!next || next === name) return;
    const r = await window.transius.fs.renameRemote(
      entry.path,
      posixJoin(listing.path, next),
    );
    if (!r.ok) actions.showError(r.error);
    else void reload();
  };

  const removeSelected = async () => {
    const items = entries.filter((e) => selected.has(e.name));
    if (items.length === 0) return;
    if (!isRemote) {
      // 本地删除不在此处实现，避免误删用户数据；引导用户到系统文件管理器
      const first = items[0];
      await window.transius.dialog.revealInShell(first.path);
      return;
    }
    if (!window.confirm(t('fs.removeConfirm', { n: items.length }))) return;
    const r = await window.transius.fs.removeRemote(items.map((e) => e.path));
    if (!r.ok) actions.showError(r.error);
    else setSelected(new Set());
    void reload();
  };

  const changePermissions = async () => {
    const name = [...selected][0];
    if (!name || !listing) return;
    const entry = entries.find((e) => e.name === name) as RemoteEntry | undefined;
    if (!entry) return;
    const current = entry.mode ? entry.mode.toString(8) : '644';
    const input = window.prompt(t('fs.permissionsPrompt'), current);
    if (!input) return;
    if (!/^[0-7]{3,4}$/.test(input)) {
      actions.showError('fs.invalidMode');
      return;
    }
    const r = await window.transius.fs.chmodRemote(entry.path, parseInt(input, 8));
    if (!r.ok) actions.showError(r.error);
    else void reload();
  };

  // ---------- 渲染 ----------
  const gridTemplate = isRemote
    ? 'minmax(0,1fr) 86px 92px 118px'
    : 'minmax(0,1fr) 86px 118px';

  const canOperate = isRemote && connected;

  return (
    <section
      className={`pane${dragOver ? ' drop-target' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        // 仅当真正离开面板时才取消高亮
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="pane-head">
        <span className="pane-title">{isRemote ? t('fs.remote') : t('fs.local')}</span>
        <div className="path-bar">
          <input
            className="path-input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPath();
              if (e.key === 'Escape') setPathInput(listing?.path ?? '');
            }}
            onBlur={() => setPathInput(listing?.path ?? '')}
            placeholder={t('fs.pathPlaceholder')}
            spellCheck={false}
          />
        </div>
        <button
          className="btn ghost icon"
          title={t('fs.parent')}
          disabled={!listing?.parent}
          onClick={() => navigate(listing?.parent ?? null)}
        >
          <IconArrowUp size={14} />
        </button>
        <button
          className="btn ghost icon"
          title={t('fs.refresh')}
          onClick={() => void reload()}
        >
          {loading ? <IconLoader size={14} className="spin" /> : <IconRefresh size={14} />}
        </button>
      </div>

      <div className="pane-toolbar">
        {isRemote ? (
          <>
            <button
              className="btn sm"
              onClick={() => void transferSelected()}
              disabled={selected.size === 0 || !connected}
              title={t('fs.download')}
            >
              <IconDownload size={13} />
              {t('fs.download')}
            </button>
            <button
              className="btn sm"
              onClick={() => void createFolder()}
              disabled={!canOperate}
            >
              <IconCreateFolder size={13} />
              {t('fs.newFolder')}
            </button>
            {selected.size === 1 && (
              <button className="btn sm" onClick={() => void renameSelected()}>
                {t('fs.rename')}
              </button>
            )}
            {selected.size === 1 && (
              <button
                className="btn sm"
                onClick={() => void changePermissions()}
                disabled={!canOperate}
                title={t('fs.permissions')}
              >
                {t('fs.permissions')}
              </button>
            )}
          </>
        ) : (
          <>
            <button
              className="btn sm"
              onClick={() => void transferSelected()}
              disabled={selected.size === 0 || !connected}
              title={t('fs.upload')}
            >
              <IconUpload size={13} />
              {t('fs.upload')}
            </button>
            <button
              className="btn sm"
              onClick={async () => {
                const dir = await window.transius.dialog.pickLocalDirectory();
                if (dir) navigate(dir);
              }}
            >
              {t('common.browse')}
            </button>
            {selected.size === 1 &&
              (() => {
                const e = entries.find((x) => selected.has(x.name));
                const isDir = e?.type === 'd';
                return (
                  <button
                    className="btn sm"
                    onClick={() =>
                      e &&
                      (isDir
                        ? void window.transius.dialog.openPathInShell(e.path)
                        : void window.transius.dialog.revealInShell(e.path))
                    }
                    title={isDir ? t('fs.openInOs') : t('fs.revealInOs')}
                  >
                    {isDir ? t('fs.openInOs') : t('fs.revealInOs')}
                  </button>
                );
              })()}
          </>
        )}

        {selected.size > 1 && (
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {t('fs.selected', { n: selected.size })}
          </span>
        )}
        <span className="spacer" />
        {isRemote && (
          <button
            className="btn ghost icon"
            title={t('fs.home')}
            disabled={!connected}
            onClick={() => navigate('~')}
          >
            <IconHome size={14} />
          </button>
        )}
      </div>

      <div className="file-head" style={{ gridTemplateColumns: gridTemplate }}>
        <span>{t('fs.name')}</span>
        <span style={{ textAlign: 'right' }}>{t('fs.size')}</span>
        {isRemote && <span>{t('fs.mode')}</span>}
        <span style={{ textAlign: 'right' }}>{t('fs.modified')}</span>
      </div>

      <div
        className="file-list"
        onClick={(e) => {
          // 点击空白处清空选择
          if (e.target === e.currentTarget) setSelected(new Set());
        }}
      >
        {isRemote && !connected && (
          <div className="pane-empty">{t('fs.notConnected')}</div>
        )}
        {(!isRemote || connected) && entries.length === 0 && !loading && (
          <div className="pane-empty">
            {listing ? t('fs.empty') : t('fs.loading')}
          </div>
        )}

        {entries.map((entry) => {
          const isDir = entry.type === 'd';
          const cls = `file-row${selected.has(entry.name) ? ' selected' : ''}`;
          const modeText = (entry as RemoteEntry).modeText;
          return (
            <div
              key={entry.name}
              className={cls}
              style={{ gridTemplateColumns: gridTemplate }}
              data-name={entry.name}
              draggable
              onDragStart={onDragStart}
              onClick={(e) => onRowClick(e, entry)}
              onDoubleClick={() => openEntry(entry)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!selected.has(entry.name)) {
                  setSelected(new Set([entry.name]));
                }
              }}
            >
              <div className="col-name">
                {isDir ? (
                  <IconFolder size={15} className="file-icon icon-folder" />
                ) : entry.type === 'l' ? (
                  <IconLink size={15} className="file-icon icon-link" />
                ) : (
                  <IconFile size={15} className="file-icon icon-file" />
                )}
                <span className="file-name" title={entry.path}>
                  {entry.name}
                </span>
              </div>
              <div className="col-size">{isDir ? '—' : formatSize(entry.size)}</div>
              {isRemote && <div className="col-mode">{modeText ?? ''}</div>}
              <div className="col-time">{formatTime(entry.mtime)}</div>
            </div>
          );
        })}
      </div>

      {/* 选中项操作条：仅远程面板显示 */}
      {selected.size > 0 && isRemote && connected && (
        <div className="selection-bar">
          <button className="btn sm danger" onClick={() => void removeSelected()}>
            <IconClose size={12} />
            {t('fs.remove')}
          </button>
          <span className="spacer" />
          <button className="btn ghost icon sm" onClick={() => setSelected(new Set())}>
            <IconClose size={12} />
          </button>
        </div>
      )}
    </section>
  );
}
