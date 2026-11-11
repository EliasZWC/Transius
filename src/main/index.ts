import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { IPC } from '../shared/ipc';
import type {
  AppSettings,
  ConnectRequest,
  ConnectionProfileInput,
  EnqueueRequest,
  IpcResult,
  ConnectResult,
  WindowState,
} from '../shared/types';
import { ConfigStore } from './config';
import { listLocalDirectory, SshError, SshSession } from './ssh';
import { TransferQueue } from './transfer';

const isDev = process.env.NODE_ENV === 'development';
const DEV_URL = 'http://localhost:5173';

const store = new ConfigStore();
const session = new SshSession();
let queue: TransferQueue | null = null;
let mainWindow: BrowserWindow | null = null;

/** 统一包装 IPC 返回值，避免向渲染进程抛异常导致通道挂起 */
async function wrap<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    const e = err as SshError;
    // 把错误码带上，UI 可据此做多语言文案
    const code = e?.code ? `${e.code}: ` : '';
    const message = `${code}${e?.message ?? String(err)}`;
    console.error('[ipc] error:', e?.code ?? '', e?.message ?? err);
    return { ok: false, error: message };
  }
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#1e1e1e',
    title: 'Transius',
    show: false,
    autoHideMenuBar: true,
    // 自绘标题栏：隐藏系统边框，由渲染进程画 Windows 风格的控制按钮。
    // 保留 resizable/maximizable，双击标题栏与拖拽仍由系统处理（配合
    // -webkit-app-region: drag）。
    frame: false,
    // Windows 上保留系统圆角与阴影（Win11）—— 设为 false 会切成直角。
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 把最大化状态推给渲染进程，用于切换「还原/最大化」图标
  const pushWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    send(IPC.windowState, {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen(),
      focused: mainWindow.isFocused(),
    });
  };
  mainWindow.on('maximize', pushWindowState);
  mainWindow.on('unmaximize', pushWindowState);
  mainWindow.on('enter-full-screen', pushWindowState);
  mainWindow.on('leave-full-screen', pushWindowState);
  mainWindow.on('focus', pushWindowState);
  mainWindow.on('blur', pushWindowState);
  mainWindow.webContents.on('did-finish-load', pushWindowState);

  if (isDev) {
    void mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // __dirname = dist/main/main → ../../renderer = dist/renderer
    void mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }

  // 外部链接交给系统浏览器，禁止应用内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(DEV_URL) && !url.startsWith('file://')) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  // ---------- 连接配置 ----------
  ipcMain.handle(IPC.profileList, () => wrap(() => store.listProfiles()));

  ipcMain.handle(IPC.profileSave, (_e, input: ConnectionProfileInput) =>
    wrap(() => store.saveProfile(input)),
  );

  ipcMain.handle(IPC.profileRemove, (_e, id: string) =>
    wrap(async () => {
      if (session.currentHost) await session.disconnect();
      await store.removeProfile(id);
    }),
  );

  ipcMain.handle(IPC.profilePickKey, () =>
    wrap(async () => {
      const win = mainWindow;
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        title: 'Select private key',
        properties: ['openFile'],
        filters: [
          { name: 'Private keys', extensions: ['pem', 'key', 'ppk', 'rsa', 'ed25519'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const keyPath = result.filePaths[0];
      const content = await fs.readFile(keyPath, 'utf8');
      return { path: keyPath, content };
    }),
  );

  // ---------- SSH 连接 ----------
  ipcMain.handle(IPC.sshConnect, (_e, req: ConnectRequest) =>
    wrap<ConnectResult>(async () => {
      const profile = store.getProfile(req.profileId);
      if (!profile) throw new SshError('NO_PROFILE', 'Profile not found');

      const saved = store.getSecrets(profile.id);
      const auth =
        profile.authMethod === 'privateKey'
          ? {
              method: 'privateKey' as const,
              privateKey: saved.privateKey,
              passphrase: req.passphrase ?? saved.passphrase,
            }
          : {
              method: 'password' as const,
              password: req.password ?? saved.password,
            };

      const conn = await session.connect(profile, auth);
      await store.touchProfile(profile.id);
      queue?.revive();
      return { ok: true, hostFingerprint: conn.host, homeDirectory: conn.home };
    }),
  );

  ipcMain.handle(IPC.sshDisconnect, () =>
    wrap(async () => {
      queue?.dispose();
      await session.disconnect();
    }),
  );

  ipcMain.handle(IPC.sshStatus, () =>
    wrap(() => ({ connected: session.isConnected, host: session.currentHost })),
  );

  // ---------- 文件系统 ----------
  ipcMain.handle(IPC.fsListLocal, (_e, dir: unknown) =>
    wrap(() => listLocalDirectory(typeof dir === 'string' ? dir : null)),
  );

  ipcMain.handle(IPC.fsListRemote, (_e, dir: unknown) =>
    wrap(() => {
      if (!session.isConnected) throw new SshError('NOT_CONNECTED', 'Not connected');
      const target =
        typeof dir === 'string' && dir.trim() ? dir : session.homeDirectory;
      return session.listRemote(target);
    }),
  );

  ipcMain.handle(IPC.fsHomeLocal, () => wrap(() => app.getPath('home')));

  ipcMain.handle(IPC.fsMkdirRemote, (_e, dir: string) =>
    wrap(() => session.mkdirp(dir)),
  );

  ipcMain.handle(IPC.fsRemoveRemote, (_e, paths: string[]) =>
    wrap(async () => {
      for (const p of paths) {
        const st = await session.stat(p, false).catch(() => null);
        if (!st) continue;
        await session.remove(p, st.isDirectory && !st.isSymlink);
      }
    }),
  );

  ipcMain.handle(IPC.fsRenameRemote, (_e, from: string, to: string) =>
    wrap(() => session.rename(from, to)),
  );

  ipcMain.handle(IPC.fsChmodRemote, (_e, p: string, mode: number) =>
    wrap(() => session.chmod(p, mode)),
  );

  ipcMain.handle(IPC.fsPathExistsLocal, (_e, p: string) =>
    wrap(async () => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    }),
  );

  // ---------- 系统对话框 ----------
  ipcMain.handle(IPC.dialogPickFiles, () =>
    wrap(async () => {
      if (!mainWindow) return [];
      const r = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
      });
      return r.canceled ? [] : r.filePaths;
    }),
  );

  ipcMain.handle(IPC.dialogPickDirectory, () =>
    wrap(async () => {
      if (!mainWindow) return null;
      const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
    }),
  );

  ipcMain.handle(IPC.dialogPickSaveDirectory, () =>
    wrap(async () => {
      if (!mainWindow) return null;
      const r = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
      });
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
    }),
  );

  ipcMain.handle(IPC.dialogOpenPath, (_e, p: string) => wrap(() => shell.openPath(p)));
  ipcMain.handle(IPC.dialogRevealPath, (_e, p: string) =>
    wrap(() => shell.showItemInFolder(p)),
  );

  // ---------- 传输队列 ----------
  queue = new TransferQueue(
    () => (session.isConnected ? session : null),
    () => store.getSettings().concurrency,
  );
  queue.onProgress((e) => send(IPC.transferProgress, e));
  queue.onState((e) => send(IPC.transferState, e));

  ipcMain.handle(IPC.transferEnqueue, (_e, items: EnqueueRequest[]) =>
    wrap(() => queue!.enqueue(items)),
  );
  ipcMain.handle(IPC.transferPause, (_e, id: string) => wrap(() => queue!.pause(id)));
  ipcMain.handle(IPC.transferResume, (_e, id: string) => wrap(() => queue!.resume(id)));
  ipcMain.handle(IPC.transferCancel, (_e, id: string) => wrap(() => queue!.cancel(id)));
  ipcMain.handle(IPC.transferRetry, (_e, id: string) => wrap(() => queue!.retry(id)));
  ipcMain.handle(IPC.transferRemove, (_e, id: string) => wrap(() => queue!.remove(id)));
  ipcMain.handle(IPC.transferClearFinished, () => wrap(() => queue!.clearFinished()));
  ipcMain.handle(IPC.transferSnapshot, () => wrap(() => ({ items: queue!.snapshot() })));

  // ---------- 设置 ----------
  ipcMain.handle(IPC.settingsGet, () => wrap(() => store.getSettings()));
  ipcMain.handle(IPC.settingsUpdate, (_e, patch: Partial<AppSettings>) =>
    wrap(() => store.updateSettings(patch)),
  );

  // ---------- 自绘标题栏 ----------
  ipcMain.handle(IPC.windowMinimize, () =>
    wrap(() => {
      mainWindow?.minimize();
    }),
  );

  ipcMain.handle(IPC.windowMaximizeToggle, () =>
    wrap(() => {
      if (!mainWindow) return;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }),
  );

  ipcMain.handle(IPC.windowClose, () =>
    wrap(() => {
      mainWindow?.close();
    }),
  );

  ipcMain.handle(IPC.windowQueryState, () =>
    wrap<WindowState>(() => ({
      maximized: mainWindow?.isMaximized() ?? false,
      fullscreen: mainWindow?.isFullScreen() ?? false,
      focused: mainWindow?.isFocused() ?? true,
    })),
  );
}

app.whenReady().then(async () => {
  await store.load();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  queue?.dispose();
  void session.disconnect();
});

// 单实例锁：避免多开导致配置文件并发写
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
