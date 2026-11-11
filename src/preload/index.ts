import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type {
  AppSettings,
  ConnectRequest,
  ConnectResult,
  ConnectionProfile,
  ConnectionProfileInput,
  DirectoryListing,
  EnqueueRequest,
  IpcResult,
  TransferProgressEvent,
  TransferQueueSnapshot,
  TransferStateEvent,
  TransiusApi,
  WindowState,
} from '../shared/types';

/**
 * 只暴露白名单方法，渲染进程无法直接访问 node/electron 能力。
 */
const api: TransiusApi = {
  platform: process.platform,

  profile: {
    list: () =>
      ipcRenderer.invoke(IPC.profileList) as Promise<IpcResult<ConnectionProfile[]>>,
    save: (input: ConnectionProfileInput) =>
      ipcRenderer.invoke(IPC.profileSave, input) as Promise<IpcResult<ConnectionProfile>>,
    remove: (id: string) =>
      ipcRenderer.invoke(IPC.profileRemove, id) as Promise<IpcResult<void>>,
    pickPrivateKey: () =>
      ipcRenderer.invoke(IPC.profilePickKey) as Promise<
        IpcResult<{ path: string; content: string } | null>
      >,
  },

  ssh: {
    connect: (req: ConnectRequest) =>
      ipcRenderer.invoke(IPC.sshConnect, req) as Promise<IpcResult<ConnectResult>>,
    disconnect: () => ipcRenderer.invoke(IPC.sshDisconnect) as Promise<IpcResult<void>>,
    status: () =>
      ipcRenderer.invoke(IPC.sshStatus) as Promise<
        IpcResult<{ connected: boolean; host?: string }>
      >,
  },

  fs: {
    listLocal: (dir?: string | null) =>
      ipcRenderer.invoke(IPC.fsListLocal, dir ?? null) as Promise<IpcResult<DirectoryListing>>,
    listRemote: (dir?: string | null) =>
      ipcRenderer.invoke(IPC.fsListRemote, dir ?? null) as Promise<IpcResult<DirectoryListing>>,
    homeLocal: () =>
      ipcRenderer.invoke(IPC.fsHomeLocal) as Promise<IpcResult<string>>,
    mkdirRemote: (dir: string) =>
      ipcRenderer.invoke(IPC.fsMkdirRemote, dir) as Promise<IpcResult<void>>,
    removeRemote: (paths: string[]) =>
      ipcRenderer.invoke(IPC.fsRemoveRemote, paths) as Promise<IpcResult<void>>,
    renameRemote: (from: string, to: string) =>
      ipcRenderer.invoke(IPC.fsRenameRemote, from, to) as Promise<IpcResult<void>>,
    chmodRemote: (path: string, mode: number) =>
      ipcRenderer.invoke(IPC.fsChmodRemote, path, mode) as Promise<IpcResult<void>>,
    pathExistsLocal: (path: string) =>
      ipcRenderer.invoke(IPC.fsPathExistsLocal, path) as Promise<boolean>,
  },

  dialog: {
    pickLocalFiles: () => ipcRenderer.invoke(IPC.dialogPickFiles) as Promise<string[]>,
    pickLocalDirectory: () =>
      ipcRenderer.invoke(IPC.dialogPickDirectory) as Promise<string | null>,
    pickSaveDirectory: () =>
      ipcRenderer.invoke(IPC.dialogPickSaveDirectory) as Promise<string | null>,
    openPathInShell: (path: string) =>
      ipcRenderer.invoke(IPC.dialogOpenPath, path) as Promise<void>,
    revealInShell: (path: string) =>
      ipcRenderer.invoke(IPC.dialogRevealPath, path) as Promise<void>,
  },

  transfer: {
    enqueue: (items: EnqueueRequest[]) =>
      ipcRenderer.invoke(IPC.transferEnqueue, items) as Promise<IpcResult<string[]>>,
    pause: (id: string) => ipcRenderer.invoke(IPC.transferPause, id) as Promise<IpcResult<void>>,
    resume: (id: string) =>
      ipcRenderer.invoke(IPC.transferResume, id) as Promise<IpcResult<void>>,
    cancel: (id: string) =>
      ipcRenderer.invoke(IPC.transferCancel, id) as Promise<IpcResult<void>>,
    retry: (id: string) => ipcRenderer.invoke(IPC.transferRetry, id) as Promise<IpcResult<void>>,
    remove: (id: string) =>
      ipcRenderer.invoke(IPC.transferRemove, id) as Promise<IpcResult<void>>,
    clearFinished: () =>
      ipcRenderer.invoke(IPC.transferClearFinished) as Promise<IpcResult<void>>,
    snapshot: () =>
      ipcRenderer.invoke(IPC.transferSnapshot) as Promise<IpcResult<TransferQueueSnapshot>>,
    onProgress: (cb: (e: TransferProgressEvent) => void) => {
      const listener = (_e: unknown, payload: TransferProgressEvent) => cb(payload);
      ipcRenderer.on(IPC.transferProgress, listener);
      return () => ipcRenderer.removeListener(IPC.transferProgress, listener);
    },
    onState: (cb: (e: TransferStateEvent) => void) => {
      const listener = (_e: unknown, payload: TransferStateEvent) => cb(payload);
      ipcRenderer.on(IPC.transferState, listener);
      return () => ipcRenderer.removeListener(IPC.transferState, listener);
    },
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<IpcResult<AppSettings>>,
    update: (patch: Partial<AppSettings>) =>
      ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<IpcResult<AppSettings>>,
  },

  win: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize) as Promise<IpcResult<void>>,
    toggleMaximize: () =>
      ipcRenderer.invoke(IPC.windowMaximizeToggle) as Promise<IpcResult<void>>,
    close: () => ipcRenderer.invoke(IPC.windowClose) as Promise<IpcResult<void>>,
    queryState: () =>
      ipcRenderer.invoke(IPC.windowQueryState) as Promise<IpcResult<WindowState>>,
    onState: (cb: (s: WindowState) => void) => {
      const listener = (_e: unknown, s: WindowState) => cb(s);
      ipcRenderer.on(IPC.windowState, listener);
      return () => ipcRenderer.removeListener(IPC.windowState, listener);
    },
  },
};

contextBridge.exposeInMainWorld('transius', api);
