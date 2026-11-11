import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type {
  EnqueueRequest,
  TransferDirection,
  TransferItem,
  TransferProgressEvent,
  TransferState,
  TransferStateEvent,
} from '../shared/types';
import type { SshSession } from './ssh';
import { posixDirname, posixJoin } from '../shared/paths';

/** 队列内部的任务：一个 TransferItem 可能展开为多个文件子任务 */
interface InternalTask {
  id: string;
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  name: string;
  isDirectory: boolean;
  size: number;
  transferred: number;
  state: TransferState;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  /** 目录任务展开出的文件列表；单文件任务为空 */
  files?: FileSubTask[];
  fileCount?: number;
  filesDone?: number;
  /** 当前活跃流的取消句柄 */
  cancelCurrent?: () => void;
  speed: number;
  lastSampleBytes: number;
  lastSampleTime: number;
  /** 当前文件已续传的起点偏移 */
  resumeOffset: number;
  /** 当前文件本次已完成的字节（不含 resumeOffset） */
  currentFileDone: number;
}

interface FileSubTask {
  localPath: string;
  remotePath: string;
  size: number;
  done: boolean;
  resumeOffset: number;
}

type ProgressListener = (e: TransferProgressEvent) => void;
type StateListener = (e: TransferStateEvent) => void;

const CHUNK_SIZE = 64 * 1024;
/** 每传输多少字节上报一次，降低 IPC 压力 */
const REPORT_STEP = 256 * 1024;

export class TransferQueue {
  private tasks = new Map<string, InternalTask>();
  private order: string[] = [];
  private running = 0;
  private disposed = false;
  private progressListeners: ProgressListener[] = [];
  private stateListeners: StateListener[] = [];
  private lastEmit = new Map<string, number>();

  constructor(
    private getSession: () => SshSession | null,
    private getConcurrency: () => number,
  ) {}

  onProgress(cb: ProgressListener): void {
    this.progressListeners.push(cb);
  }

  onState(cb: StateListener): void {
    this.stateListeners.push(cb);
  }

  snapshot(): TransferItem[] {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((t): t is InternalTask => Boolean(t))
      .map((t) => this.toPublic(t));
  }

  private toPublic(t: InternalTask): TransferItem {
    return {
      id: t.id,
      direction: t.direction,
      localPath: t.localPath,
      remotePath: t.remotePath,
      name: t.name,
      isDirectory: t.isDirectory,
      size: t.size,
      transferred: t.transferred,
      state: t.state,
      speed: t.state === 'active' ? t.speed : 0,
      error: t.error,
      fileCount: t.fileCount,
      filesDone: t.filesDone,
      createdAt: t.createdAt,
      finishedAt: t.finishedAt,
    };
  }

  private emitProgress(t: InternalTask, force = false): void {
    const now = Date.now();
    const last = this.lastEmit.get(t.id) ?? 0;
    if (!force && now - last < 200) return;
    this.lastEmit.set(t.id, now);
    const evt: TransferProgressEvent = {
      id: t.id,
      transferred: t.transferred,
      size: t.size,
      speed: t.speed,
      filesDone: t.filesDone,
      fileCount: t.fileCount,
    };
    for (const cb of this.progressListeners) cb(evt);
  }

  private setState(t: InternalTask, state: TransferState, error?: string): void {
    t.state = state;
    t.error = error;
    if (state === 'completed' || state === 'error' || state === 'canceled') {
      t.finishedAt = Date.now();
      t.speed = 0;
    }
    const evt: TransferStateEvent = {
      id: t.id,
      state: t.state,
      error: t.error,
      transferred: t.transferred,
      size: t.size,
      speed: t.speed,
    };
    for (const cb of this.stateListeners) cb(evt);
  }

  async enqueue(requests: EnqueueRequest[]): Promise<string[]> {
    const ids: string[] = [];
    for (const req of requests) {
      const id = randomUUID();
      const task: InternalTask = {
        id,
        direction: req.direction,
        localPath: req.localPath,
        remotePath: req.remotePath,
        name: req.name,
        isDirectory: req.isDirectory,
        size: req.size,
        transferred: 0,
        state: 'queued',
        createdAt: Date.now(),
        speed: 0,
        lastSampleBytes: 0,
        lastSampleTime: Date.now(),
        resumeOffset: 0,
        currentFileDone: 0,
      };
      this.tasks.set(id, task);
      this.order.push(id);
      ids.push(id);
      this.setState(task, 'queued');
    }
    this.pump();
    return ids;
  }

  pause(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    if (t.state === 'active' || t.state === 'scanning') {
      this.setState(t, 'paused');
      t.cancelCurrent?.();
    } else if (t.state === 'queued') {
      this.setState(t, 'paused');
    }
  }

  resume(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    if (t.state === 'paused' || t.state === 'error') {
      t.error = undefined;
      this.setState(t, 'queued');
      this.pump();
    }
  }

  cancel(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    if (t.state === 'completed' || t.state === 'canceled') return;
    this.setState(t, 'canceled');
    t.cancelCurrent?.();
  }

  retry(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    if (t.state !== 'error' && t.state !== 'canceled') return;
    t.error = undefined;
    t.transferred = 0;
    t.filesDone = 0;
    t.resumeOffset = 0;
    t.currentFileDone = 0;
    if (t.files) {
      for (const f of t.files) {
        f.done = false;
        f.resumeOffset = 0;
      }
    }
    this.setState(t, 'queued');
    this.pump();
  }

  remove(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    if (t.state === 'active' || t.state === 'scanning') t.cancelCurrent?.();
    this.tasks.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.lastEmit.delete(id);
  }

  clearFinished(): void {
    for (const id of [...this.order]) {
      const t = this.tasks.get(id);
      if (!t) continue;
      if (t.state === 'completed' || t.state === 'canceled' || t.state === 'error') {
        this.tasks.delete(id);
        this.order = this.order.filter((x) => x !== id);
        this.lastEmit.delete(id);
      }
    }
  }

  /** 应用退出时调用：中止所有活跃流 */
  dispose(): void {
    this.disposed = true;
    for (const t of this.tasks.values()) t.cancelCurrent?.();
  }

  /** 连接建立后恢复调度 */
  revive(): void {
    this.disposed = false;
    this.pump();
  }

  private pump(): void {
    if (this.disposed) return;
    const limit = Math.max(1, this.getConcurrency());
    for (const id of this.order) {
      if (this.running >= limit) break;
      const t = this.tasks.get(id);
      if (!t || t.state !== 'queued') continue;
      this.running++;
      void this.runTask(t).finally(() => {
        this.running--;
        queueMicrotask(() => this.pump());
      });
    }
  }

  private async runTask(t: InternalTask): Promise<void> {
    const session = this.getSession();
    if (!session || !session.isConnected) {
      this.setState(t, 'error', 'NOT_CONNECTED');
      return;
    }

    try {
      if (t.isDirectory && !t.files) {
        this.setState(t, 'scanning');
        await this.expandDirectory(t);
      }
      if (this.isStopped(t)) return;

      this.setState(t, 'active');
      if (t.files && t.files.length > 0) {
        await this.runDirectory(t);
      } else if (!t.isDirectory) {
        await this.runSingleFile(t);
      } else if (t.direction === 'upload') {
        // 空目录：只需在远端创建
        await session.mkdirp(t.remotePath);
      } else {
        await fs.mkdir(t.localPath, { recursive: true });
      }

      if (this.isStopped(t)) return;
      t.transferred = t.size;
      t.speed = 0;
      this.emitProgress(t, true);
      this.setState(t, 'completed');
    } catch (err) {
      if (this.isStopped(t)) return;
      if ((err as Error)?.name === 'AbortError') return;
      this.setState(t, 'error', this.humanizeError((err as Error)?.message ?? String(err)));
    }
  }

  /**
   * 判断任务是否已被暂停/取消。
   * 注意：不能内联写 `t.state === 'paused'`，因为 setState 前的字面量类型收窄
   * 会让 TS 误判「两个类型没有重叠」。用方法边界打断收窄。
   */
  private isStopped(t: InternalTask): boolean {
    const s: TransferState = t.state;
    return s === 'paused' || s === 'canceled';
  }

  private humanizeError(msg: string): string {
    if (/ENOENT|no such file/i.test(msg)) return 'ENOENT';
    if (/EACCES|permission denied/i.test(msg)) return 'EACCES';
    if (/ENOSPC/i.test(msg)) return 'ENOSPC';
    if (/ETIMEDOUT|ECONNRESET|No response from server/i.test(msg)) return 'NETWORK';
    return msg;
  }

  private async expandDirectory(t: InternalTask): Promise<void> {
    const session = this.getSession();
    if (!session) throw new Error('NOT_CONNECTED');
    const files: FileSubTask[] = [];

    if (t.direction === 'upload') {
      await this.walkLocal(t.localPath, (absPath, size, base) => {
        const rel = path.relative(base, absPath).split(path.sep).join('/');
        files.push({
          localPath: absPath,
          remotePath: posixJoin(t.remotePath, rel),
          size,
          done: false,
          resumeOffset: 0,
        });
      });
      await session.mkdirp(t.remotePath);
      const dirs = new Set<string>();
      for (const f of files) dirs.add(posixDirname(f.remotePath));
      const sorted = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
      for (const d of sorted) {
        if (this.isStopped(t)) return;
        await session.mkdirp(d);
      }
    } else {
      await this.walkRemote(t.remotePath, (remoteAbs, size) => {
        let rel = remoteAbs.slice(t.remotePath.length);
        if (rel.startsWith('/')) rel = rel.slice(1);
        files.push({
          localPath: path.join(t.localPath, rel.split('/').join(path.sep)),
          remotePath: remoteAbs,
          size,
          done: false,
          resumeOffset: 0,
        });
      });
      await fs.mkdir(t.localPath, { recursive: true });
      const dirs = new Set<string>();
      for (const f of files) dirs.add(path.dirname(f.localPath));
      for (const d of dirs) {
        if (this.isStopped(t)) return;
        await fs.mkdir(d, { recursive: true });
      }
    }

    t.files = files;
    t.fileCount = files.length;
    t.filesDone = 0;
    t.size = files.reduce((sum, f) => sum + f.size, 0);
    t.transferred = 0;
  }

  private async walkLocal(
    root: string,
    onFile: (absPath: string, size: number, base: string) => void,
  ): Promise<void> {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(abs);
        } else if (e.isFile()) {
          try {
            const st = await fs.stat(abs);
            onFile(abs, st.size, root);
          } catch {
            // 跳过无法读取的文件
          }
        }
        // 符号链接不跟随，避免循环引用
      }
    }
  }

  private async walkRemote(
    root: string,
    onFile: (remoteAbs: string, size: number) => void,
  ): Promise<void> {
    const session = this.getSession();
    if (!session) throw new Error('NOT_CONNECTED');
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let listing;
      try {
        listing = await session.listRemote(dir);
      } catch {
        continue;
      }
      for (const e of listing.entries) {
        if (e.type === 'd') stack.push(e.path);
        else if (e.type === '-') onFile(e.path, e.size);
      }
    }
  }

  private async runDirectory(t: InternalTask): Promise<void> {
    for (const f of t.files!) {
      if (this.isStopped(t)) return;
      if (f.done) continue;
      t.resumeOffset = f.resumeOffset;
      t.currentFileDone = 0;
      await this.transferFile(t, f.localPath, f.remotePath, f.size);
      f.done = true;
      f.resumeOffset = 0;
      t.filesDone = (t.filesDone ?? 0) + 1;
      t.resumeOffset = 0;
      t.currentFileDone = 0;
      this.emitProgress(t, true);
    }
  }

  private async runSingleFile(t: InternalTask): Promise<void> {
    t.currentFileDone = 0;
    await this.transferFile(t, t.localPath, t.remotePath, t.size);
    t.resumeOffset = 0;
    t.currentFileDone = 0;
  }

  private tickSpeed(t: InternalTask): void {
    const now = Date.now();
    const dt = now - t.lastSampleTime;
    if (dt < 500) return;
    const db = t.transferred - t.lastSampleBytes;
    t.speed = (db / dt) * 1000;
    t.lastSampleBytes = t.transferred;
    t.lastSampleTime = now;
  }

  /**
   * 统一的单文件传输实现（上传/下载共用）。
   * - 支持从 t.resumeOffset 续传
   * - 支持随时取消并保留断点
   */
  private transferFile(
    t: InternalTask,
    localPath: string,
    remotePath: string,
    size: number,
  ): Promise<void> {
    const session = this.getSession();
    if (!session || !session.isConnected) return Promise.reject(new Error('NOT_CONNECTED'));

    const startOffset = t.resumeOffset || 0;

    // 空文件：直接创建，避免流处理边界问题
    if (size === 0) {
      return new Promise<void>((resolve, reject) => {
        if (t.direction === 'upload') {
          const ws = session.createRemoteWriteStream(remotePath, false, 0, 0o644);
          ws.on('error', reject);
          ws.on('finish', () => resolve());
          ws.end();
        } else {
          fs.writeFile(localPath, '')
            .then(() => resolve())
            .catch(reject);
        }
      });
    }

    // 目标端已有完整文件（上次传完但未标记）
    if (startOffset >= size) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let lastReported = 0;
      // 本次会话已传输字节（不含 startOffset）
      let sessionBytes = 0;

      const rs: Readable =
        t.direction === 'upload'
          ? createReadStream(localPath, { start: startOffset, highWaterMark: CHUNK_SIZE })
          : session.createRemoteReadStream(remotePath, startOffset, CHUNK_SIZE);

      const ws: Writable =
        t.direction === 'upload'
          ? session.createRemoteWriteStream(remotePath, startOffset > 0, startOffset, 0o644)
          : createWriteStream(localPath, {
              flags: startOffset > 0 ? 'r+' : 'w',
              start: startOffset,
            });

      const finalize = (err?: Error) => {
        if (settled) return;
        settled = true;
        t.cancelCurrent = undefined;
        rs.destroy();
        ws.destroy();
        if (err) reject(err);
        else resolve();
      };

      t.cancelCurrent = () => {
        if (settled) return;
        settled = true;
        t.cancelCurrent = undefined;
        rs.destroy();
        ws.destroy();
        // 记录断点，便于 resume 续传
        const completed = startOffset + sessionBytes;
        t.resumeOffset = completed;
        if (t.files) {
          const current = t.files.find((f) => !f.done);
          if (current) current.resumeOffset = completed;
        }
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };

      rs.on('data', (chunk: Buffer) => {
        sessionBytes += chunk.length;
        t.currentFileDone = sessionBytes;
        if (sessionBytes - lastReported >= REPORT_STEP) {
          const delta = sessionBytes - lastReported;
          lastReported = sessionBytes;
          t.transferred += delta;
          this.tickSpeed(t);
          this.emitProgress(t);
        }
      });

      rs.on('error', (err) => finalize(err as Error));
      ws.on('error', (err) => finalize(err as Error));
      ws.on('finish', () => {
        // 补报最后不足一个 REPORT_STEP 的字节
        const remain = sessionBytes - lastReported;
        if (remain > 0) t.transferred += remain;
        this.emitProgress(t, true);
        finalize();
      });

      rs.pipe(ws);
    });
  }
}
