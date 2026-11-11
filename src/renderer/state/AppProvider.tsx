import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AppSettings,
  ConnectRequest,
  ConnectionProfile,
  ConnectionProfileInput,
  DirectoryListing,
  IpcResult,
  TransferItem,
  TransferProgressEvent,
  TransferStateEvent,
} from '@shared/types';
import { posixBasename, posixJoin } from '@shared/paths';
import {
  AppActionsContext,
  AppStateContext,
  type AppState,
  type AppActions,
  type DropItem,
  type Side,
} from './context';

const api = window.transius;

/** 主进程 handler 均返回 IpcResult，这里统一解包成数组 */
async function loadProfiles(): Promise<ConnectionProfile[]> {
  const r = await api.profile.list();
  return r.ok ? r.data : [];
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [profiles, setProfiles] = useState<AppState['profiles']>([]);
  const [settings, setSettings] = useState<AppSettings>({
    language: 'zh',
    concurrency: 3,
    confirmBeforeOverwrite: true,
    showHiddenFiles: false,
  });
  const [local, setLocal] = useState<DirectoryListing | null>(null);
  const [remote, setRemote] = useState<DirectoryListing | null>(null);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<AppState['toast']>(null);

  // 用 ref 保存最新目录，避免闭包拿到过期值（拖拽/快捷键场景）
  const localRef = useRef<DirectoryListing | null>(null);
  const remoteRef = useRef<DirectoryListing | null>(null);
  localRef.current = local;
  remoteRef.current = remote;

  const showError = useCallback((text: string) => {
    setToast({ kind: 'error', text });
  }, []);
  const showInfo = useCallback((text: string) => {
    setToast({ kind: 'info', text });
  }, []);
  const clearToast = useCallback(() => setToast(null), []);

  // ---------- 初始化 ----------
  useEffect(() => {
    void (async () => {
      const [list, st, snap, home] = await Promise.all([
        loadProfiles(),
        api.settings.get(),
        api.transfer.snapshot(),
        api.fs.homeLocal(),
      ]);
      setProfiles(list);
      if (st.ok) setSettings(st.data);
      setTransfers(snap.ok ? snap.data.items : []);
      // 默认打开用户主目录
      if (home.ok) {
        const listing = await api.fs.listLocal(home.data);
        if (listing.ok) setLocal(listing.data);
      }
      const status = await api.ssh.status();
      if (status.ok) {
        setConnected(status.data.connected);
        setHost(status.data.host);
      }
    })();
  }, []);

  // ---------- 传输事件订阅 ----------
  useEffect(() => {
    const offProgress = api.transfer.onProgress((e: TransferProgressEvent) => {
      setTransfers((prev) =>
        prev.map((item) =>
          item.id === e.id
            ? {
                ...item,
                transferred: e.transferred,
                size: e.size || item.size,
                speed: e.speed,
                filesDone: e.filesDone ?? item.filesDone,
                fileCount: e.fileCount ?? item.fileCount,
              }
            : item,
        ),
      );
    });

    const offState = api.transfer.onState((e: TransferStateEvent) => {
      setTransfers((prev) => {
        const exists = prev.some((t) => t.id === e.id);
        if (!exists) {
          // 新任务：主动拉一次快照
          void api.transfer.snapshot().then((snap) => {
            if (snap.ok) setTransfers(snap.data.items);
          });
          return prev;
        }
        return prev.map((item) =>
          item.id === e.id
            ? {
                ...item,
                state: e.state,
                error: e.error,
                transferred: e.transferred ?? item.transferred,
                size: e.size ?? item.size,
                speed: e.speed ?? item.speed,
              }
            : item,
        );
      });
    });

    return () => {
      offProgress();
      offState();
    };
  }, []);

  // 传输完成后自动刷新对应目录，让用户看到新文件
  const finishedIds = useRef(new Set<string>());
  useEffect(() => {
    const newly = transfers.filter(
      (t) => t.state === 'completed' && !finishedIds.current.has(t.id),
    );
    if (newly.length === 0) return;
    for (const t of newly) finishedIds.current.add(t.id);
    const needLocal = newly.some((t) => t.direction === 'download');
    const needRemote = newly.some((t) => t.direction === 'upload');
    void (async () => {
      if (needLocal && localRef.current) {
        const r = await api.fs.listLocal(localRef.current.path);
        if (r.ok) setLocal(r.data);
      }
      if (needRemote && remoteRef.current && connected) {
        const r = await api.fs.listRemote(remoteRef.current.path);
        if (r.ok) setRemote(r.data);
      }
    })();
  }, [transfers, connected]);

  // ---------- 配置 ----------
  const refreshProfiles = useCallback(async () => {
    setProfiles(await loadProfiles());
  }, []);

  const saveProfile = useCallback(
    async (input: ConnectionProfileInput) => {
      const r = await api.profile.save(input);
      if (!r.ok) {
        showError(r.error);
        return false;
      }
      setProfiles(await loadProfiles());
      return true;
    },
    [showError],
  );

  const deleteProfile = useCallback(async (id: string) => {
    const r = await api.profile.remove(id);
    if (r.ok) setProfiles(await loadProfiles());
  }, []);

  // ---------- 连接 ----------
  const connect = useCallback(
    async (req: ConnectRequest) => {
      setBusy(true);
      try {
        const r = await api.ssh.connect(req);
        if (!r.ok) {
          showError(r.error);
          return false;
        }
        setConnected(true);
        setHost(r.data.hostFingerprint);
        setProfiles(await loadProfiles());

        // 连接后跳到配置的初始目录
        const profile = (await loadProfiles()).find((p) => p.id === req.profileId);
        const remoteStart = profile?.remotePath || r.data.homeDirectory || '/';
        const [rl, ll] = await Promise.all([
          api.fs.listRemote(remoteStart),
          profile?.localPath ? api.fs.listLocal(profile.localPath) : Promise.resolve(null),
        ]);
        if (rl.ok) setRemote(rl.data);
        else showError(rl.error);
        if (ll && ll.ok) setLocal(ll.data);
        return true;
      } finally {
        setBusy(false);
      }
    },
    [showError],
  );

  const disconnect = useCallback(async () => {
    await api.ssh.disconnect();
    setConnected(false);
    setHost(undefined);
    setRemote(null);
  }, []);

  /** 外部（如双击连接）已完成连接时，同步本地 UI 状态 */
  const refreshConnection = useCallback(async () => {
    const status = await api.ssh.status();
    if (!status.ok) return;
    setConnected(status.data.connected);
    setHost(status.data.host);
    const list = await loadProfiles();
    setProfiles(list);
    if (!status.data.connected) {
      setRemote(null);
      return;
    }
    const profile = list.find((p) => p.host === status.data.host);
    const startRemote = remoteRef.current?.path ?? profile?.remotePath ?? null;
    const r = await api.fs.listRemote(startRemote);
    if (r.ok) setRemote(r.data);
    else showError(r.error);
  }, [showError]);

  // ---------- 目录导航 ----------
  const navigateLocal = useCallback(
    async (dir: string | null) => {
      const target = dir ?? localRef.current?.parent ?? null;
      const r = await api.fs.listLocal(target);
      if (r.ok) setLocal(r.data);
      else showError(r.error);
    },
    [showError],
  );

  const navigateRemote = useCallback(
    async (dir: string | null) => {
      if (!connected) return;
      const target = dir ?? remoteRef.current?.parent ?? null;
      const r = await api.fs.listRemote(target);
      if (r.ok) setRemote(r.data);
      else showError(r.error);
    },
    [connected, showError],
  );

  const refreshBoth = useCallback(async () => {
    const tasks: Promise<void>[] = [];
    if (localRef.current) {
      tasks.push(
        api.fs.listLocal(localRef.current.path).then((r) => {
          if (r.ok) setLocal(r.data);
        }),
      );
    }
    if (remoteRef.current && connected) {
      tasks.push(
        api.fs.listRemote(remoteRef.current.path).then((r) => {
          if (r.ok) setRemote(r.data);
        }),
      );
    }
    await Promise.all(tasks);
  }, [connected]);

  // ---------- 传输入队 ----------
  const enqueueUpload = useCallback(
    async (localPaths: string[]) => {
      const target = remoteRef.current?.path;
      if (!target) {
        showError('err.NOT_CONNECTED');
        return;
      }
      if (localPaths.length === 0) return;

      const requests = await Promise.all(
        localPaths.map(async (p) => {
          const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
          // 通过列出父目录判断类型与大小
          const parent = p.replace(/[\\/][^\\/]+$/, '') || p;
          const listing = await api.fs.listLocal(parent);
          const entry = listing.ok
            ? listing.data.entries.find((e) => e.path === p)
            : undefined;
          return {
            direction: 'upload' as const,
            localPath: p,
            remotePath: posixJoin(target, name),
            name,
            isDirectory: entry?.type === 'd',
            size: entry?.size ?? 0,
          };
        }),
      );

      const r = await api.transfer.enqueue(requests);
      if (!r.ok) showError(r.error);
    },
    [showError],
  );

  const enqueueDownload = useCallback(
    async (remoteNames: string[]) => {
      const remoteDir = remoteRef.current;
      const localDir = localRef.current;
      if (!remoteDir || !connected) {
        showError('err.NOT_CONNECTED');
        return;
      }
      if (!localDir) {
        showError('err.LOCAL_IO');
        return;
      }
      if (remoteNames.length === 0) return;

      const requests = remoteNames.map((name) => {
        const entry = remoteDir.entries.find((e) => e.name === name);
        return {
          direction: 'download' as const,
          localPath: joinLocal(localDir.path, name),
          remotePath: posixJoin(remoteDir.path, name),
          name,
          isDirectory: entry?.type === 'd',
          size: entry?.size ?? 0,
        };
      });

      const r = await api.transfer.enqueue(requests);
      if (!r.ok) showError(r.error);
    },
    [connected, showError],
  );

  const enqueueDrop = useCallback(
    async (from: Side, items: DropItem[]) => {
      if (items.length === 0) return;
      const targetDir = from === 'local' ? remoteRef.current?.path : localRef.current?.path;
      if (!targetDir) {
        showError(from === 'local' ? 'err.NOT_CONNECTED' : 'err.LOCAL_IO');
        return;
      }

      const requests = items.map((it) => ({
        direction: from === 'local' ? ('upload' as const) : ('download' as const),
        localPath: from === 'local' ? it.path : joinLocal(targetDir, it.name),
        remotePath: from === 'local' ? posixJoin(targetDir, it.name) : it.path,
        name: it.name,
        isDirectory: it.isDirectory,
        size: it.size,
      }));

      const r = await api.transfer.enqueue(requests);
      if (!r.ok) showError(r.error);
    },
    [showError],
  );

  const makeCtl = (fn: (id: string) => Promise<IpcResult<void>>) =>
    async (id: string) => {
      const r = await fn(id);
      if (!r.ok) showError(r.error);
    };

  const pauseTransfer = useCallback(makeCtl(api.transfer.pause), [showError]);
  const resumeTransfer = useCallback(makeCtl(api.transfer.resume), [showError]);
  const cancelTransfer = useCallback(makeCtl(api.transfer.cancel), [showError]);
  const retryTransfer = useCallback(makeCtl(api.transfer.retry), [showError]);
  const removeTransfer = useCallback(
    async (id: string) => {
      await api.transfer.remove(id);
      setTransfers((prev) => prev.filter((t) => t.id !== id));
    },
    [],
  );
  const clearFinished = useCallback(async () => {
    await api.transfer.clearFinished();
    setTransfers((prev) =>
      prev.filter(
        (t) => t.state !== 'completed' && t.state !== 'canceled' && t.state !== 'error',
      ),
    );
  }, []);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const res = await api.settings.update(patch);
    if (res.ok) setSettings(res.data);
  }, []);

  const state = useMemo<AppState>(
    () => ({ connected, host, profiles, settings, local, remote, transfers, busy, toast }),
    [connected, host, profiles, settings, local, remote, transfers, busy, toast],
  );

  const actions = useMemo<AppActions>(
    () => ({
      refreshProfiles,
      saveProfile,
      deleteProfile,
      connect,
      disconnect,
      refreshConnection,
      navigateLocal,
      navigateRemote,
      refreshBoth,
      enqueueUpload,
      enqueueDownload,
      enqueueDrop,
      pauseTransfer,
      resumeTransfer,
      cancelTransfer,
      retryTransfer,
      removeTransfer,
      clearFinished,
      updateSettings,
      showError,
      showInfo,
      clearToast,
    }),
    [
      refreshProfiles,
      saveProfile,
      deleteProfile,
      connect,
      disconnect,
      refreshConnection,
      navigateLocal,
      navigateRemote,
      refreshBoth,
      enqueueUpload,
      enqueueDownload,
      enqueueDrop,
      pauseTransfer,
      resumeTransfer,
      cancelTransfer,
      retryTransfer,
      removeTransfer,
      clearFinished,
      updateSettings,
      showError,
      showInfo,
      clearToast,
    ],
  );

  return (
    <AppStateContext.Provider value={state}>
      <AppActionsContext.Provider value={actions}>{children}</AppActionsContext.Provider>
    </AppStateContext.Provider>
  );
}

/** 本地路径拼接：Windows 用反斜杠 */
function joinLocal(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  // 更稳妥的做法：由 Windows 盘符判断
  const isWin = /^[A-Za-z]:/.test(dir);
  const s = isWin ? '\\' : sep;
  return dir.endsWith(s) ? `${dir}${name}` : `${dir}${s}${name}`;
}

/** 供其他组件复用：从本地绝对路径取文件名 */
export function localBasename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** 供其他组件复用：从远程路径取文件名 */
export const remoteBasename = posixBasename;
