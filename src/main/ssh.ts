import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type {
  ConnectionProfile,
  DirectoryListing,
  LocalEntry,
  RemoteEntry,
  RemoteStat,
  SshAuth,
} from '../shared/types';
import { modeToText, normalizePosix, posixDirname, posixJoin } from '../shared/paths';

export interface ConnectedSession {
  client: Client;
  sftp: SFTPWrapper;
  host: string;
  home: string;
}

export type SshErrorCode =
  | 'NO_PROFILE'
  | 'AUTH_FAILED'
  | 'NETWORK'
  | 'HANDSHAKE'
  | 'NOT_CONNECTED'
  | 'SFTP'
  | 'LOCAL_IO'
  | 'UNKNOWN';

/** 带错误码的异常，便于 UI 做多语言提示 */
export class SshError extends Error {
  constructor(
    public code: SshErrorCode,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = 'SshError';
  }
}

/** 把 ssh2 的错误映射为可读的错误码，避免把底层英文报文直接抛给 UI */
function mapError(err: unknown): SshError {
  const e = err as NodeJS.ErrnoException & { level?: string };
  const msg = e?.message ?? String(err);
  const level = e?.level ?? '';

  if (/authentication/i.test(msg) || level === 'client-authentication') {
    return new SshError('AUTH_FAILED', msg);
  }
  if (/handshake/i.test(msg) || level === 'client-timeout') {
    return new SshError('HANDSHAKE', msg);
  }
  if (
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET/i.test(msg) ||
    e?.code === 'ECONNREFUSED' ||
    e?.code === 'ENOTFOUND'
  ) {
    return new SshError('NETWORK', msg);
  }
  if (level === 'sftp') {
    return new SshError('SFTP', msg);
  }
  return new SshError('UNKNOWN', msg);
}

export class SshSession {
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  private host = '';
  private home = '/';
  private connectSeq = 0;

  get isConnected(): boolean {
    return this.client !== null && this.sftp !== null;
  }

  get currentHost(): string | undefined {
    return this.isConnected ? this.host : undefined;
  }

  get homeDirectory(): string {
    return this.home;
  }

  /** 建立连接。会先清理已有连接，保证同一时刻只有一个会话。 */
  async connect(profile: ConnectionProfile, auth: SshAuth): Promise<ConnectedSession> {
    await this.disconnect();
    const seq = ++this.connectSeq;

    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port || 22,
      username: profile.username,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
    };

    if (auth.method === 'privateKey') {
      if (!auth.privateKey) {
        throw new SshError('AUTH_FAILED', 'Private key is empty');
      }
      config.privateKey = auth.privateKey;
      if (auth.passphrase) config.passphrase = auth.passphrase;
    } else {
      if (auth.password === undefined) {
        throw new SshError('AUTH_FAILED', 'Password is empty');
      }
      config.password = auth.password;
    }

    const client = new Client();

    // 部分服务器（如老版本 OpenSSH + PAM）仍走 keyboard-interactive
    client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => config.password ?? ''));
    });

    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        client.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        client.removeListener('ready', onReady);
        reject(mapError(err));
      };
      client.once('ready', onReady);
      client.once('error', onError);
      try {
        client.connect(config);
      } catch (err) {
        reject(mapError(err));
      }
    });

    // 连接过程中用户可能已发起新的连接 / 断开，此时代数不匹配说明本次已作废
    if (seq !== this.connectSeq) {
      client.end();
      throw new SshError('UNKNOWN', 'Connection superseded');
    }

    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, wrapper) => (err ? reject(mapError(err)) : resolve(wrapper)));
    });

    this.client = client;
    this.sftp = sftp;
    this.host = profile.host;

    client.on('close', () => {
      // 服务端主动断开或网络中断
      if (this.client === client) {
        this.client = null;
        this.sftp = null;
      }
    });
    client.on('error', () => {
      // 未捕获的 error 会导致进程崩溃，这里统一兜底
    });

    this.home = await this.detectHome(profile.username);
    return { client, sftp, host: this.host, home: this.home };
  }

  /** 通过 sftp realpath('.') 获取真实 home，比拼接 /home/user 可靠 */
  private detectHome(username: string): Promise<string> {
    return new Promise((resolve) => {
      const sftp = this.sftp;
      if (!sftp) return resolve('/');
      sftp.realpath('.', (err, abs) => {
        if (err || !abs) {
          resolve(username === 'root' ? '/root' : posixJoin('/home', username || ''));
          return;
        }
        resolve(abs);
      });
    });
  }

  async disconnect(): Promise<void> {
    this.connectSeq++;
    const client = this.client;
    this.client = null;
    this.sftp = null;
    this.host = '';
    this.home = '/';
    if (!client) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      client.once('close', done);
      try {
        client.end();
      } catch {
        done();
      }
      // 兜底：某些情况下 close 事件不会触发
      setTimeout(done, 2000).unref();
    });
  }

  private requireSftp(): SFTPWrapper {
    if (!this.sftp) throw new SshError('NOT_CONNECTED', 'Not connected');
    return this.sftp;
  }

  async listRemote(dir: string): Promise<DirectoryListing> {
    const sftp = this.requireSftp();
    const target = normalizePosix(dir);

    const names = await new Promise<string[]>((resolve, reject) => {
      sftp.readdir(target, (err, list) =>
        err ? reject(mapError(err)) : resolve(list.map((l) => l.filename)),
      );
    });

    const entries: RemoteEntry[] = [];
    // 并发获取 stat，限流避免触发服务端连接数限制
    const CONCURRENCY = 16;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, names.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= names.length) return;
        const name = names[i];
        if (name === '.' || name === '..') continue;
        const full = posixJoin(target, name);
        try {
          // 用 lstat 语义读取：不跟随符号链接，避免悬空链接报错
          const st = await this.statRaw(full, true);
          entries.push({
            name,
            path: full,
            type: st.isDirectory ? 'd' : st.isSymlink ? 'l' : '-',
            size: st.size,
            mtime: st.mtime,
            mode: st.mode,
            modeText: st.modeText,
          });
        } catch {
          // 单个条目读取失败不应让整个目录列表失败
        }
      }
    });
    await Promise.all(workers);

    entries.sort((a, b) => {
      if (a.type === 'd' && b.type !== 'd') return -1;
      if (a.type !== 'd' && b.type === 'd') return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    const parent = target === '/' ? null : posixDirname(target);
    return { path: target, entries, parent };
  }

  private statRaw(fullPath: string, followSymlink: boolean): Promise<RemoteStat> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      const cb = (
        err: Error | undefined,
        stats?: {
          size: number;
          mtime: number;
          mode: number;
          isDirectory(): boolean;
          isSymbolicLink(): boolean;
        },
      ) => {
        if (err || !stats) return reject(mapError(err));
        resolve({
          size: stats.size,
          mtime: stats.mtime,
          mode: stats.mode & 0o7777,
          modeText: modeToText(stats.mode),
          isDirectory: stats.isDirectory(),
          isSymlink: stats.isSymbolicLink(),
        });
      };
      if (followSymlink) sftp.stat(fullPath, cb);
      else sftp.lstat(fullPath, cb);
    });
  }

  async stat(fullPath: string, followSymlink = true): Promise<RemoteStat> {
    return this.statRaw(normalizePosix(fullPath), followSymlink);
  }

  async mkdir(dir: string): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(dir, (err) => (err ? reject(mapError(err)) : resolve()));
    });
  }

  /** 递归创建目录（类似 mkdir -p） */
  async mkdirp(dir: string): Promise<void> {
    const target = normalizePosix(dir);
    const st = await this.statRaw(target, true).catch(() => null);
    if (st?.isDirectory) return;
    if (target === '/') return;
    const parent = posixDirname(target);
    if (parent !== target) await this.mkdirp(parent);
    try {
      await this.mkdir(target);
    } catch (err) {
      // 并发/已存在时忽略
      const again = await this.statRaw(target, true).catch(() => null);
      if (!again?.isDirectory) throw err;
    }
  }

  async remove(fullPath: string, isDirectory: boolean): Promise<void> {
    const sftp = this.requireSftp();
    if (!isDirectory) {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(fullPath, (err) => (err ? reject(mapError(err)) : resolve()));
      });
      return;
    }
    // 递归删除目录
    const st = await this.statRaw(fullPath, false).catch(() => null);
    if (!st) return;
    if (st.isSymlink) {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(fullPath, (err) => (err ? reject(mapError(err)) : resolve()));
      });
      return;
    }
    const listing = await this.listRemote(fullPath).catch(() => null);
    for (const entry of listing?.entries ?? []) {
      await this.remove(entry.path, entry.type === 'd');
    }
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(fullPath, (err) => (err ? reject(mapError(err)) : resolve()));
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(mapError(err)) : resolve()));
    });
  }

  async chmod(fullPath: string, mode: number): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.chmod(fullPath, mode, (err) => (err ? reject(mapError(err)) : resolve()));
    });
  }

  /**
   * 创建远程写流。
   * @param appendTo 是否为「续传」模式（从指定偏移写入已有文件）
   */
  createRemoteWriteStream(
    remotePath: string,
    appendTo: boolean,
    start: number,
    mode = 0o644,
  ): Writable {
    const sftp = this.requireSftp();
    // ssh2 的 WriteStream 支持 flags/start；用 'r+' 才能从中间写
    return sftp.createWriteStream(remotePath, {
      flags: appendTo ? 'r+' : 'w',
      start,
      mode,
      autoClose: true,
    }) as unknown as Writable;
  }

  createRemoteReadStream(remotePath: string, start: number, highWaterMark: number): Readable {
    const sftp = this.requireSftp();
    return sftp.createReadStream(remotePath, {
      start,
      highWaterMark,
      autoClose: true,
    }) as unknown as Readable;
  }
}

/** 本地文件系统读取（只在主进程执行，渲染进程不允许直接访问 fs） */
export async function listLocalDirectory(dir: string | null): Promise<DirectoryListing> {
  const target = dir && dir.trim() ? path.resolve(dir) : process.cwd();
  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    throw new SshError('LOCAL_IO', (err as Error).message);
  }

  const entries: LocalEntry[] = [];
  const CONCURRENCY = 32;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, dirents.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= dirents.length) return;
      const d = dirents[i];
      const full = path.join(target, d.name);
      try {
        const st = await fs.lstat(full);
        entries.push({
          name: d.name,
          path: full,
          type: d.isDirectory() ? 'd' : d.isSymbolicLink() ? 'l' : '-',
          size: st.size,
          mtime: Math.floor(st.mtimeMs / 1000),
        });
      } catch {
        // 跳过无法访问的条目
      }
    }
  });
  await Promise.all(workers);

  entries.sort((a, b) => {
    if (a.type === 'd' && b.type !== 'd') return -1;
    if (a.type !== 'd' && b.type === 'd') return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  const parent = path.dirname(target);
  return {
    path: target,
    entries,
    parent: parent === target ? null : parent,
  };
}
