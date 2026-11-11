/**
 * 主进程 / 预加载 / 渲染进程共用的类型契约。
 * 这里是唯一的接口定义来源，任何一侧改动都必须在此同步。
 */

export type SshAuthMethod = 'password' | 'privateKey';

export interface SshAuth {
  method: SshAuthMethod;
  /** 密码认证使用 */
  password?: string;
  /** 私钥认证使用：私钥内容（PEM/OpenSSH） */
  privateKey?: string;
  /** 私钥口令（可选） */
  passphrase?: string;
}

/** 保存在磁盘上的连接配置（不含敏感信息） */
export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  /** 私钥认证时，已保存到磁盘的私钥文件路径 */
  privateKeyPath?: string;
  /** 远程默认目录 */
  remotePath: string;
  /** 本地默认目录 */
  localPath?: string;
  lastConnectedAt?: number;
}

/** 保存/更新配置时传给主进程的载荷（可能含秘密，仅在内存中传递） */
export interface ConnectionProfileInput extends Omit<ConnectionProfile, 'id' | 'lastConnectedAt'> {
  id?: string;
  /** 本次输入的密码；为空表示沿用已保存的密码 */
  password?: string;
  /** 本次输入的私钥内容；为空表示沿用已保存的私钥 */
  privateKey?: string;
  passphrase?: string;
  /** 是否记住密码/口令 */
  rememberSecret?: boolean;
}

export interface ConnectRequest {
  profileId: string;
  /** 覆盖配置中的临时密码（用户重新输入时使用） */
  password?: string;
  passphrase?: string;
}

export interface RemoteEntry {
  name: string;
  path: string;
  /** 'd' 目录 / '-' 文件 / 'l' 符号链接 / 'o' 其他 */
  type: 'd' | '-' | 'l' | 'o';
  size: number;
  /** unix 秒级时间戳 */
  mtime: number;
  /** 权限位，如 0o644 */
  mode: number;
  /** 权限描述，如 rwxr-xr-x */
  modeText: string;
  owner?: string;
  group?: string;
  /** 符号链接目标 */
  linkTarget?: string;
}

export interface LocalEntry {
  name: string;
  path: string;
  type: 'd' | '-' | 'l' | 'o';
  size: number;
  mtime: number;
}

export interface DirectoryListing {
  path: string;
  entries: (RemoteEntry | LocalEntry)[];
  /** 父目录路径，根目录为 null */
  parent: string | null;
}

export type TransferDirection = 'upload' | 'download';

export type TransferState =
  | 'queued'
  | 'scanning'
  | 'active'
  | 'paused'
  | 'completed'
  | 'error'
  | 'canceled';

export interface TransferItem {
  id: string;
  direction: TransferDirection;
  /** 本地绝对路径 */
  localPath: string;
  /** 远程绝对路径 */
  remotePath: string;
  /** 显示名 */
  name: string;
  /** 是否为目录（目录会展开成多个文件任务，但队列里显示为一行） */
  isDirectory: boolean;
  /** 单文件大小；目录为累计总大小 */
  size: number;
  /** 已完成字节数 */
  transferred: number;
  state: TransferState;
  /** 字节/秒，仅 active 时有意义 */
  speed: number;
  error?: string;
  /** 该目录任务下的文件数 */
  fileCount?: number;
  /** 已完成文件数 */
  filesDone?: number;
  createdAt: number;
  finishedAt?: number;
}

export interface TransferProgressEvent {
  id: string;
  transferred: number;
  size: number;
  speed: number;
  filesDone?: number;
  fileCount?: number;
}

export interface TransferStateEvent {
  id: string;
  state: TransferState;
  error?: string;
  transferred?: number;
  size?: number;
  speed?: number;
}

export interface TransferQueueSnapshot {
  items: TransferItem[];
}

export interface RemoteStat {
  size: number;
  mtime: number;
  mode: number;
  modeText: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface AppSettings {
  language: 'zh' | 'en';
  concurrency: number;
  confirmBeforeOverwrite: boolean;
  showHiddenFiles: boolean;
}

/** 自绘标题栏需要的窗口状态 */
export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
}

export interface ConnectResult {
  ok: boolean;
  hostFingerprint?: string;
  error?: string;
  homeDirectory?: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** preload 暴露给渲染进程的 API 形状 */
export interface TransiusApi {
  platform: string;
  profile: {
    list(): Promise<IpcResult<ConnectionProfile[]>>;
    save(input: ConnectionProfileInput): Promise<IpcResult<ConnectionProfile>>;
    remove(id: string): Promise<IpcResult<void>>;
    pickPrivateKey(): Promise<IpcResult<{ path: string; content: string } | null>>;
  };
  ssh: {
    connect(req: ConnectRequest): Promise<IpcResult<ConnectResult>>;
    disconnect(): Promise<IpcResult<void>>;
    status(): Promise<IpcResult<{ connected: boolean; host?: string }>>;
  };
  fs: {
    listLocal(dir?: string | null): Promise<IpcResult<DirectoryListing>>;
    listRemote(dir?: string | null): Promise<IpcResult<DirectoryListing>>;
    homeLocal(): Promise<IpcResult<string>>;
    mkdirRemote(dir: string): Promise<IpcResult<void>>;
    removeRemote(paths: string[]): Promise<IpcResult<void>>;
    renameRemote(from: string, to: string): Promise<IpcResult<void>>;
    chmodRemote(path: string, mode: number): Promise<IpcResult<void>>;
    pathExistsLocal(path: string): Promise<boolean>;
  };
  dialog: {
    pickLocalFiles(): Promise<string[]>;
    pickLocalDirectory(): Promise<string | null>;
    pickSaveDirectory(): Promise<string | null>;
    openPathInShell(path: string): Promise<void>;
    revealInShell(path: string): Promise<void>;
  };
  transfer: {
    enqueue(items: EnqueueRequest[]): Promise<IpcResult<string[]>>;
    pause(id: string): Promise<IpcResult<void>>;
    resume(id: string): Promise<IpcResult<void>>;
    cancel(id: string): Promise<IpcResult<void>>;
    retry(id: string): Promise<IpcResult<void>>;
    remove(id: string): Promise<IpcResult<void>>;
    clearFinished(): Promise<IpcResult<void>>;
    snapshot(): Promise<IpcResult<TransferQueueSnapshot>>;
    onProgress(cb: (e: TransferProgressEvent) => void): () => void;
    onState(cb: (e: TransferStateEvent) => void): () => void;
  };
  settings: {
    get(): Promise<IpcResult<AppSettings>>;
    update(patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>>;
  };
  /** 自绘标题栏窗口控制 */
  win: {
    minimize(): Promise<IpcResult<void>>;
    toggleMaximize(): Promise<IpcResult<void>>;
    close(): Promise<IpcResult<void>>;
    queryState(): Promise<IpcResult<WindowState>>;
    onState(cb: (s: WindowState) => void): () => void;
  };
}

export interface EnqueueRequest {
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  name: string;
  isDirectory: boolean;
  size: number;
}
