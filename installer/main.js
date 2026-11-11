'use strict';

/**
 * 安装器主进程。
 *
 * 打包形式：electron-builder 把「安装器自身」打包成一个独立应用，
 * 生成 Transius-Setup-0.0.2.exe。它内部携带应用负载（payload.zip），
 * 运行时解压到目标目录。
 *
 * 命令行：
 *   Transius-Setup.exe                 GUI 安装
 *   Transius-Setup.exe /S              静默安装
 *   Transius-Setup.exe /S /D=C:\path   静默安装到指定目录
 *   Transius-Setup.exe --uninstall     以卸载模式启动（由 UninstallString 调用）
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const core = require('./core');

const isSilent = process.argv.some((a) => /^\/s$/i.test(a) || /^--silent$/i.test(a));
const isUninstallMode = process.argv.some((a) => /^--uninstall$/i.test(a));
const parsed = core.parseArgs(process.argv);

/**
 * 卸载成功后延时退出。
 * 必须给「独立清理进程」留出启动时间：PowerShell 冷启动约 1–2 秒，
 * 太短会导致它还没起来就被连带终止（实测 2.5s 不够）。
 */
const DELEGATED_EXIT_DELAY_MS = 6000;

/** 负载包路径：打包后位于 resources/payload.zip */
function payloadPath() {
  return path.join(process.resourcesPath, 'payload', 'payload.zip');
}

/** 版本号由构建脚本写入 resources/version.txt */
function appVersion() {
  try {
    return fs
      .readFileSync(path.join(process.resourcesPath, 'version.txt'), 'utf8')
      .trim();
  } catch {
    return app.getVersion();
  }
}

function payloadSize() {
  try {
    return fs.statSync(payloadPath()).size;
  } catch {
    return 0;
  }
}

let win = null;
let progressSink = null;

/**
 * 安装失败时把上下文写进日志，便于排查。
 * 错误信息写到 %TEMP%\transius-setup.log —— 用户看不见控制台，
 * 但支持时可以让他把这个文件发过来。
 */
function logError(context, err) {
  try {
    const line = `[${new Date().toISOString()}] ${context}\n  code: ${err && err.code}\n  message: ${err && err.message}\n  stack: ${err && err.stack}\n\n`;
    fs.appendFileSync(path.join(os.tmpdir(), 'transius-setup.log'), line, 'utf8');
  } catch {
    /* 日志写不了就算了 */
  }
}

function sendProgress(payload) {
  if (progressSink && !progressSink.isDestroyed()) {
    progressSink.send('setup:progress', payload);
  } else if (isSilent) {
    // 静默模式输出到控制台，便于 CI 排查
    if (payload.stage) process.stdout.write(`${payload.stage}\n`);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 470,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: '#1e1e1e',
    title: 'Transius Setup',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    progressSink = win.webContents;
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

/* ── 安装 ─────────────────────────────────────────────────────────────── */

async function runInstall(options) {
  const installDir =
    parsed.dir || options.installDir || core.defaultInstallDir();

  if (core.isAppRunning()) {
    sendProgress({ stage: '正在关闭已运行的 Transius…', done: 0, total: 1 });
    core.killApp();
    if (core.isAppRunning()) {
      throw new Error('Transius 正在运行，请先退出后重试。');
    }
  }

  const src = payloadPath();
  if (!fs.existsSync(src)) {
    throw new Error(`安装负载缺失：${src}`);
  }

  // 目标已存在则先清空（升级安装）
  if (fs.existsSync(installDir)) {
    const ok = core.removeDirRetry(installDir);
    if (!ok && fs.existsSync(installDir)) {
      throw new Error(
        `无法清理旧版本目录：${installDir}\n\n` +
          `请确认 Transius 已退出，或手动删除该目录后重试。`,
      );
    }
  }
  fs.mkdirSync(installDir, { recursive: true });

  // 直接解压到目标目录 —— 不做「先解到临时目录再复制」。
  //
  // ⚠️ 为什么改掉了两步方案（本项目实测踩坑）：
  //    在 Windows 上把 Electron 的应用目录从 A 复制到 B 时，
  //    `fs.cpSync` 会因为 resources/ 下的 junction 与长路径抛 ENOTDIR；
  //    逐文件 `copyFileSync` 则会因句柄竞争报 ENOENT。
  //    tar 是从头解压，没有这些中间态问题，而且更快。
  sendProgress({ stage: '正在解压文件…', done: 0, total: 100 });
  await extractZip(src, installDir, (done, total) => {
    sendProgress({
      stage: '正在解压文件…',
      done: Math.round((done / Math.max(1, total)) * 95),
      total: 100,
      detail: `${(done / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB`,
    });
  });

  sendProgress({ stage: '正在完成安装…', done: 95, total: 100 });

  const exe = path.join(installDir, core.APP_EXE);
  if (!fs.existsSync(exe)) {
    const listing = fs.existsSync(installDir) ? fs.readdirSync(installDir) : [];
    throw new Error(
      `解压后未找到 ${core.APP_EXE}。目录内容：${listing.slice(0, 12).join(', ') || '(空)'}`,
    );
  }

  // 快捷方式
  sendProgress({ stage: '正在创建快捷方式…', done: 95, total: 100 });
  if (options.startMenuShortcut) {
    const lnk = path.join(core.startMenuDir(), `${core.APP_NAME}.lnk`);
    core.createShortcut(lnk, exe, '', exe, 'Transius SSH 文件传输客户端');
  }
  if (options.desktopShortcut) {
    const lnk = path.join(core.desktopDir(), `${core.APP_NAME}.lnk`);
    core.createShortcut(lnk, exe, '', exe, 'Transius SSH 文件传输客户端');
  }

  // 注册表（卸载入口用自身的 --uninstall 模式）
  sendProgress({ stage: '正在写入注册表…', done: 97, total: 100 });
  const selfDir = path.dirname(process.execPath);
  let uninstaller = process.execPath;
  const bundledUninstaller = path.join(selfDir, 'Transius-Uninstall.exe');
  if (fs.existsSync(bundledUninstaller)) uninstaller = bundledUninstaller;

  process.env.TRANSIUS_VERSION = appVersion();
  const sizeKb = dirSizeKb(installDir);
  core.writeRegistry(installDir, sizeKb, uninstaller);

  sendProgress({ stage: '安装完成', done: 100, total: 100 });

  if (options.launchAfter) {
    try {
      spawnDetached(exe, [], installDir);
    } catch {
      /* 启动失败不影响安装结果 */
    }
  }

  return { ok: true, dir: installDir };
}

/**
 * 解压 zip。
 *
 * 用 tar 而非 PowerShell 的 Expand-Archive：Windows 10 1803+ 自带
 * bsdtar，解压 100MB 级别的包比 Expand-Archive 快一个数量级。
 *
 * ⚠️ 关键：必须显式指定 cwd，且**不能**是解压目标目录。
 *    tar 子进程会继承父进程 cwd；若 cwd 落在安装目录内，
 *    子进程退出后目录会被延迟占用，导致卸载时 EPERM 删不掉。
 */
function extractZip(zipPath, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('node:child_process');
    const child = spawn('tar', ['-xf', zipPath, '-C', dest], {
      windowsHide: true,
      cwd: os.tmpdir(), // 固定到临时目录，绝不落在安装目录里
    });

    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));

    const total = payloadSize();
    const timer = setInterval(() => {
      if (onProgress) onProgress(Math.min(dirSizeRaw(dest), total), total);
    }, 200);

    child.on('close', (code) => {
      clearInterval(timer);
      if (code === 0) {
        if (onProgress) onProgress(total, total);
        resolve();
      } else {
        reject(new Error(`解压失败 (code ${code}): ${err.trim() || '未知错误'}`));
      }
    });
    child.on('error', (e) => {
      clearInterval(timer);
      reject(e);
    });
  });
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function dirSizeRaw(dir) {
  let total = 0;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      total += ent.isDirectory() ? dirSizeRaw(p) : fs.statSync(p).size;
    }
  } catch {
    /* 目录可能正在变化 */
  }
  return total;
}

function dirSizeKb(dir) {
  return Math.round(dirSizeRaw(dir) / 1024);
}

function spawnDetached(exe, args, cwd) {
  const { spawn } = require('node:child_process');
  const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore' });
  child.unref();
}

/* ── 卸载 ─────────────────────────────────────────────────────────────── */

/**
 * 决定如何删除安装目录。
 *
 * 返回 { removed, fatal }：
 *   removed - 目录是否已经不在原位（已删除，或已委派外部进程处理）
 *   fatal   - 彻底失败，需要向用户报错
 */
function scheduleDeletion(installDir) {
  if (!fs.existsSync(installDir)) return { removed: true, fatal: false };

  // 先试同步删除：目录里没有被本进程占用的文件时，这一步就够了
  if (core.removeDirRetry(installDir, 2)) {
    return { removed: true, fatal: false };
  }

  // 删不掉 → 委派给独立进程，它等本进程退出后再删
  const ok = core.scheduleDeleteAfterExit(installDir);
  return { removed: ok, fatal: !ok };
}

async function runUninstall(options) {
  const installDir = options.installDir || core.defaultInstallDir();
  const dataDir = options.dataDir || core.defaultDataDir();

  if (core.isAppRunning()) {
    sendProgress({ stage: '正在关闭 Transius…', done: 5, total: 100 });
    core.killApp();
    if (core.isAppRunning()) {
      throw new Error('Transius 正在运行，请先退出后重试。');
    }
  }

  sendProgress({ stage: '正在删除快捷方式…', done: 15, total: 100 });
  for (const lnk of [
    path.join(core.startMenuDir(), `${core.APP_NAME}.lnk`),
    path.join(core.desktopDir(), `${core.APP_NAME}.lnk`),
  ]) {
    try {
      fs.rmSync(lnk, { force: true });
    } catch {
      /* 不存在 */
    }
  }

  sendProgress({ stage: '正在移除注册表项…', done: 30, total: 100 });
  core.removeRegistry();

  sendProgress({ stage: '正在删除程序文件…', done: 45, total: 100 });

  // ⚠️ 核心问题：安装器进程（Electron）持有安装目录里 resources/app.asar
  //    的文件句柄，`rmSync` / `renameSync` 都会 EPERM。
  //    这不是权限问题，是句柄语义 —— 只要本进程活着就删不掉。
  //
  //    唯一可靠的解法：把删除交给一个**独立进程**，它先等本进程退出，
  //    再执行删除。本进程随后立刻退出。
  const del = scheduleDeletion(installDir);
  const removed = del.removed;

  let note = 'Transius 已从本机移除。';
  if (!options.keepData) {
    sendProgress({ stage: '正在删除个人数据…', done: 75, total: 100 });
    core.removeDirRetry(dataDir);
    note = 'Transius 及个人数据均已删除。';
  } else {
    note = `Transius 已移除。个人数据保留在：\n${dataDir}`;
  }

  // ⚠️ 删除失败必须上报，不能静默成功。
  if (!removed) {
    throw new Error(
      `无法删除安装目录：\n${installDir}\n\n` +
        `常见原因：Transius 仍在运行，或目录被资源管理器占用。\n` +
        `请关闭相关程序后手动删除该目录。`,
    );
  }

  sendProgress({ stage: '卸载完成', done: 100, total: 100 });
  return { ok: true, note };
}

/* ── IPC ──────────────────────────────────────────────────────────────── */

function registerIpc() {
  ipcMain.handle('setup:info', () => {
    const installedDir = core.readInstallLocation();
    // 未带 --uninstall 但系统里已装过 → 走「更新」流程，默认装到原位置
    const mode = isUninstallMode ? 'uninstall' : installedDir ? 'update' : 'install';
    return {
      mode,
      version: appVersion(),
      installedVersion: core.readInstalledVersion(),
      installDir: parsed.dir || installedDir || core.defaultInstallDir(),
      dataDir: core.defaultDataDir(),
      payloadSize: payloadSize(),
      silent: isSilent,
    };
  });

  ipcMain.handle('setup:pickDirectory', async (_e, current) => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: '选择安装位置',
      defaultPath: current || core.defaultInstallDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

  ipcMain.handle('setup:install', async (_e, options) => {
    try {
      return await runInstall(options);
    } catch (err) {
      logError('install', err);
      if (isSilent) process.stderr.write(`install failed: ${err.message}\n`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('setup:uninstall', async (_e, options) => {
    try {
      const result = await runUninstall(options);
      // ⚠️ 卸载成功后必须让**整个进程**退出，且要给后台清理脚本留出启动时间。
      //    安装器进程会持有安装目录里的 app.asar 句柄，进程不退，
      //    延迟删除脚本永远拿不到删除权（实测会卡住 forever）。
      if (result.ok) {
        setTimeout(() => app.exit(0), DELEGATED_EXIT_DELAY_MS);
      }
      return result;
    } catch (err) {
      logError('uninstall', err);
      if (isSilent) process.stderr.write(`uninstall failed: ${err.message}\n`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('setup:minimize', () => win && win.minimize());
  ipcMain.handle('setup:close', () => {
    if (win) win.close();
    else app.quit();
  });
  ipcMain.handle('setup:openExternal', (_e, url) => shell.openExternal(url));
}

/* ── 启动 ─────────────────────────────────────────────────────────────── */

app.whenReady().then(async () => {
  registerIpc();

  // ⚠️ 把自身 cwd 移出安装目录：安装器可能从安装目录里被启动（例如
  //    用户双击了安装目录里的 setup），此时 cwd 会锁住该目录，
  //    导致后续卸载删不掉。这是 Windows 上 EPERM 的常见来源。
  try {
    process.chdir(os.tmpdir());
  } catch {
    /* 失败也不影响主流程 */
  }

  // 静默模式：不建窗口，直接跑流程
  if (isSilent) {
    try {
      const result = isUninstallMode
        ? await runUninstall({ installDir: parsed.dir, keepData: true })
        : await runInstall({
            installDir: parsed.dir || core.defaultInstallDir(),
            desktopShortcut: true,
            startMenuShortcut: true,
            launchAfter: false,
          });
      app.exit(result.ok ? 0 : 1);
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      app.exit(1);
    }
    return;
  }

  createWindow();
});

app.on('window-all-closed', () => app.quit());

// 安装器不要单实例锁：允许用户在 App 运行时重新运行安装程序
