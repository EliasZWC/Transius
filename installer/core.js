/**
 * 安装器核心逻辑。不依赖 Electron，可单独测试。
 *
 * 设计约束（Windows 按用户安装）：
 * · 目标目录默认 %LOCALAPPDATA%\Programs\Transius，**不需要管理员权限**
 * · 卸载信息写入 HKCU（控制面板「应用和功能」可见）
 * · 快捷方式用 .lnk，通过 PowerShell + WScript.Shell 生成（无需原生依赖）
 * · 静默安装：transius-setup.exe /S /D=<path>
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, execSync } = require('node:child_process');

const APP_NAME = 'Transius';
const APP_EXE = 'Transius.exe';
const PUBLISHER = 'Transius';
const REG_UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Transius';

/** 默认安装目录：按用户安装，无需 UAC */
function defaultInstallDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Programs', APP_NAME);
}

function defaultDataDir() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, APP_NAME);
}

function startMenuDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

function desktopDir() {
  // 读取真实桌面路径（可能被 OneDrive 重定向）
  try {
    const out = execSync(
      'powershell -NoProfile -NonInteractive -Command "[Environment]::GetFolderPath(\'Desktop\')"',
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    if (out) return out;
  } catch {
    /* 回退到默认路径 */
  }
  return path.join(os.homedir(), 'Desktop');
}

/** 解析命令行参数，支持 /S 静默与 /D=path 自定义目录 */
function parseArgs(argv) {
  const silent = argv.some((a) => /^\/s$/i.test(a) || /^--silent$/i.test(a));
  let dir = null;
  for (const a of argv) {
    const m = /^\/D=(.+)$/i.exec(a) || /^--dir=(.+)$/i.exec(a);
    if (m) dir = m[1].replace(/^"|"$/g, '');
  }
  return { silent, dir };
}

/** 检查是否有正在运行的实例（避免覆盖正在使用的文件） */
function isAppRunning() {
  try {
    const out = execSync(
      'tasklist /FI "IMAGENAME eq Transius.exe" /NH',
      { encoding: 'utf8', windowsHide: true },
    );
    return /Transius\.exe/i.test(out);
  } catch {
    return false;
  }
}

function killApp() {
  try {
    execSync('taskkill /IM Transius.exe /F', { stdio: 'ignore', windowsHide: true });
    // 给系统一点时间释放文件句柄
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      if (!isAppRunning()) break;
      sleep(120);
    }
  } catch {
    /* 没在运行就算了 */
  }
}

function sleep(ms) {
  // 同步睡眠，安装流程是同步串行的，用 Atomics 避免忙等
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 递归复制目录，带进度回调。
 * 用流式复制（而不是 fs.cpSync）以便汇报实时进度。
 */
function copyDir(src, dest, onProgress) {
  const entries = [];
  (function walk(rel) {
    const abs = path.join(src, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = path.join(rel, ent.name);
      const childAbs = path.join(src, childRel);
      if (ent.isDirectory()) {
        walk(childRel);
      } else {
        entries.push({ rel: childRel, abs: childAbs, size: fs.statSync(childAbs).size });
      }
    }
  })('');

  const total = entries.reduce((s, e) => s + e.size, 0);
  let done = 0;
  let lastReport = 0;

  fs.mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    const target = path.join(dest, e.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(e.abs, target);
    done += e.size;
    // 每 2MB 或 1% 汇报一次，避免过多回调拖慢安装
    if (onProgress && (done - lastReport > 2 * 1024 * 1024 || done === total)) {
      lastReport = done;
      onProgress(done, total);
    }
  }
  if (onProgress) onProgress(total, total);
  return total;
}

/** 用 PowerShell 创建 .lnk 快捷方式 */
function createShortcut(lnkPath, targetPath, args, iconPath, description) {
  fs.mkdirSync(path.dirname(lnkPath), { recursive: true });
  const ps = [
    '$WScript = New-Object -ComObject WScript.Shell;',
    `$s = $WScript.CreateShortcut(${psQuote(lnkPath)});`,
    `$s.TargetPath = ${psQuote(targetPath)};`,
    `$s.Arguments = ${psQuote(args || '')};`,
    `$s.WorkingDirectory = ${psQuote(path.dirname(targetPath))};`,
    `$s.IconLocation = ${psQuote(iconPath || targetPath)};`,
    `$s.Description = ${psQuote(description || '')};`,
    '$s.Save();',
  ].join(' ');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

/** PowerShell 单引号字符串转义：内部单引号需要双写 */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** 写注册表卸载信息 + 应用路径（控制面板可见、可卸载） */
function writeRegistry(installDir, sizeKb, uninstallerPath) {
  const icon = path.join(installDir, APP_EXE);
  // ⚠️ 卸载命令必须带 --uninstall，否则双击「卸载」会重新进入安装流程。
  //    参数要放在引号外面（Windows 的引号规则）。
  const entries = [
    ['DisplayName', 'REG_SZ', APP_NAME],
    ['DisplayVersion', 'REG_SZ', process.env.TRANSIUS_VERSION || '0.0.0'],
    ['Publisher', 'REG_SZ', PUBLISHER],
    ['DisplayIcon', 'REG_SZ', icon],
    ['InstallLocation', 'REG_SZ', installDir],
    ['UninstallString', 'REG_SZ', `"${uninstallerPath}" --uninstall`],
    ['QuietUninstallString', 'REG_SZ', `"${uninstallerPath}" --uninstall /S`],
    ['EstimatedSize', 'REG_DWORD', String(Math.max(1, Math.round(sizeKb)))],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
  ];
  for (const [name, type, value] of entries) {
    execFileSync('reg', ['add', REG_UNINSTALL_KEY, '/v', name, '/t', type, '/d', value, '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  }
}

function removeRegistry() {
  try {
    execFileSync('reg', ['delete', REG_UNINSTALL_KEY, '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    /* key 不存在 */
  }
}

/**
 * 递归删除，失败时重试（Windows 文件句柄释放有延迟）。
 * 返回是否删除成功 —— **调用方必须检查返回值**，不要假定成功。
 *
 * Windows 上目录本身的 EPERM 通常不是「没有权限」，而是：
 *   · 目录被设为当前工作目录（cwd）的进程持有
 *   · 杀软/索引服务正在扫描
 *   · 资源管理器打开了该目录
 * 对策：先把目录**改名**挪开（改名只需父目录权限），再慢慢删。
 * 改名成功即视为「逻辑上已卸载」，避免用户永远卡在失败页。
 */
function removeDirRetry(dir, attempts = 10) {
  if (!fs.existsSync(dir)) return true;

  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      if (!fs.existsSync(dir)) return true;
    } catch {
      /* 继续重试 */
    }
    try {
      makeWritable(dir);
    } catch {
      /* 忽略 */
    }
    sleep(300);
  }

  if (!fs.existsSync(dir)) return true;

  // 最后手段：改名挪开。父目录权限足够即可，不受子目录句柄影响。
  try {
    const doomed = `${dir}.old-${Date.now()}`;
    fs.renameSync(dir, doomed);
    // 后台尽量清掉，失败也无妨（下次安装会清理 *.old-*）
    setTimeout(() => {
      try {
        fs.rmSync(doomed, { recursive: true, force: true });
      } catch {
        /* 留给系统或下次清理 */
      }
    }, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 卸载时移除安装目录。
 *
 * Windows 上「进程删自己正在使用的目录」必然 EPERM —— 那是句柄语义，
 * 不是权限问题。而 **改名** 只需要父目录的写权限，不受子文件句柄阻挡。
 *
 * 策略：
 *   1. 直接删（最理想，目录已无占用时）
 *   2. 删不掉 → 改名为 `<dir>.removed-<ts>`（这一步几乎总能成功）
 *   3. 改名后再尝试删除；仍失败则登记后台清理
 *
 * 从用户视角，「改名」完成后安装目录已经不存在了，等价于卸载成功。
 */
/**
 * 委派一个**独立进程**在本进程退出后删除目录。
 *
 * 为什么必须这样：安装器（Electron）自己持有安装目录里 app.asar 的
 * 文件句柄，`rmSync` 与 `renameSync` 一律 EPERM。这是 Windows 的句柄
 * 语义，不是权限问题 —— 只要进程活着就删不掉，任何同进程内的技巧都无效
 * （重试、清只读属性、改名挪开，全部实测失败）。
 *
 * 实现：起一个 detached 的 PowerShell，先 Wait 本 pid 退出，再删除目标。
 * 脚本放在 %TEMP%，不会被打包进被删目录。
 */
function scheduleDeleteAfterExit(dir) {
  const { spawn } = require('node:child_process');
  const ps1 = path.join(os.tmpdir(), `transius-del-${Date.now()}-${process.pid}.ps1`);

  const body = [
    `$target = ${psQuote(dir)}`,
    `$targetPid = ${process.pid}`,
    'for ($i = 0; $i -lt 60; $i++) {',
    '  if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { break }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    'for ($i = 0; $i -lt 30; $i++) {',
    '  if (-not (Test-Path -LiteralPath $target)) { break }',
    '  try {',
    '    Get-ChildItem -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue |',
    '      ForEach-Object { try { $_.Attributes = "Normal" } catch {} }',
    '    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop',
    '  } catch { Start-Sleep -Milliseconds 500 }',
    '}',
    'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
  ].join('\r\n');

  try {
    fs.writeFileSync(ps1, body, 'utf8');

    // ⚠️ Electron 里 spawn(detached:true, stdio:'ignore') 启动的
    //    PowerShell 会被连带终止（实测：pid 拿到了，但进程立刻消失）。
    //    改用 `start` 让 cmd 负责创建完全独立的新进程 —— 它不继承
    //    Electron 的进程组，父进程退出后仍会继续运行。
    const child = spawn(
      'cmd',
      ['/c', 'start', '/b', '/min', 'powershell', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: os.tmpdir(),
      },
    );

    if (!child.pid) return false;
    child.unref();
    return true;
  } catch {
    return false;
  }
}
function makeWritable(dir) {
  if (!fs.existsSync(dir)) return;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        fs.chmodSync(cur, 0o777);
      } catch {
        /* 忽略 */
      }
      try {
        for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name));
      } catch {
        /* 忽略 */
      }
    } else {
      try {
        fs.chmodSync(cur, 0o666);
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 从注册表读取已安装的位置，未安装返回 null */
function readInstallLocation() {
  try {
    const out = execFileSync('reg', ['query', REG_UNINSTALL_KEY, '/v', 'InstallLocation'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // 输出形如：    InstallLocation    REG_SZ    C:\path\to\dir
    const m = /InstallLocation\s+REG_SZ\s+(.+)/i.exec(out);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** 从注册表读取已安装版本 */
function readInstalledVersion() {
  try {
    const out = execFileSync('reg', ['query', REG_UNINSTALL_KEY, '/v', 'DisplayVersion'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = /DisplayVersion\s+REG_SZ\s+(.+)/i.exec(out);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** 是否已安装（以注册表为准，而不是猜目录是否存在） */
function isInstalled() {
  return readInstallLocation() !== null;
}

module.exports = {
  APP_NAME,
  APP_EXE,
  REG_UNINSTALL_KEY,
  defaultInstallDir,
  defaultDataDir,
  startMenuDir,
  desktopDir,
  parseArgs,
  isAppRunning,
  killApp,
  copyDir,
  createShortcut,
  writeRegistry,
  removeRegistry,
  removeDirRetry,
  scheduleDeleteAfterExit,
  readInstallLocation,
  readInstalledVersion,
  isInstalled,
  sleep,
};
