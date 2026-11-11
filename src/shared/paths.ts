/**
 * 跨进程共用的小工具：路径分隔符无关的拼接/解析、大小格式化。
 * 远程侧永远是 POSIX 风格，因此不能直接用 node:path。
 */

export function posixJoin(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
  if (joined.length > 1 && joined.endsWith('/')) return joined.slice(0, -1);
  return joined || '/';
}

export function posixDirname(p: string): string {
  if (!p || p === '/') return '/';
  const cleaned = p.replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  if (idx < 0) return '/';
  if (idx === 0) return '/';
  return cleaned.slice(0, idx);
}

export function posixBasename(p: string): string {
  if (!p || p === '/') return '/';
  const cleaned = p.replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx < 0 ? cleaned : cleaned.slice(idx + 1);
}

/** 判断是否为绝对 POSIX 路径 */
export function isAbsolutePosix(p: string): boolean {
  return p.startsWith('/');
}

/**
 * 将用户输入的 ~ 或相对路径解析成绝对路径。
 * 注意：~ 的展开需要 home 目录，由调用方传入。
 */
export function resolveRemotePath(input: string, cwd: string, home: string): string {
  let p = input.trim();
  if (!p) return cwd;
  if (p === '~') return home;
  if (p.startsWith('~/')) return posixJoin(home, p.slice(2));
  if (isAbsolutePosix(p)) {
    // 规范化多余的 ./ 和 ..
    return normalizePosix(p);
  }
  return normalizePosix(posixJoin(cwd, p));
}

export function normalizePosix(p: string): string {
  const isAbs = p.startsWith('/');
  const segments: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (!isAbs) segments.push('..');
      continue;
    }
    segments.push(seg);
  }
  const out = (isAbs ? '/' : '') + segments.join('/');
  return out || (isAbs ? '/' : '.');
}

const MODE_CHARS = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];

export function modeToText(mode: number): string {
  const bits = mode & 0o777;
  return (
    MODE_CHARS[(bits >> 6) & 7] + MODE_CHARS[(bits >> 3) & 7] + MODE_CHARS[bits & 7]
  );
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '-';
  return `${formatSize(bytesPerSecond)}/s`;
}

export function formatTime(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
