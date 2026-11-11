/**
 * 构建自研 Windows 安装器。
 *
 * 流程：
 *   1. 构建主应用（renderer + main）
 *   2. electron-builder 打包出 release/win-unpacked（未压缩的应用目录）
 *   3. 把该目录压成 payload.zip
 *   4. electron-builder 把 installer/ 打成 Transius-Setup-<ver>.exe，
 *      并把 payload.zip 作为 extraResources 塞进去
 *
 * 产物：release-installer/Transius-Setup-<version>.exe
 *
 * 用法：node scripts/build-installer.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const unpacked = path.join(releaseDir, 'win-unpacked');
const payloadDir = path.join(root, 'build', 'payload');
const payloadZip = path.join(payloadDir, 'payload.zip');
const outDir = path.join(root, 'release-installer');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/* ── 1. 构建主应用 ─────────────────────────────────────────────────────── */
run('npm run build');

/* ── 2. 打包应用目录 ───────────────────────────────────────────────────── */
// --dir 只出目录，不生成安装包（我们用自研安装器）
// ⚠️ 必须显式指定 --config.directories.output，否则会复用 package.json 里的
//    release/，后续安装器构建再来一次 --win 时会把它覆盖掉。
rmrf(unpacked);
run('npx electron-builder --win dir --config.directories.output=release');

if (!fs.existsSync(path.join(unpacked, 'Transius.exe'))) {
  throw new Error('未生成 release/win-unpacked/Transius.exe');
}

// 立刻校验：确认拿到的是主应用而不是安装器
if (fs.existsSync(path.join(unpacked, 'resources', 'app.asar'))) {
  const hasMain = fs.existsSync(path.join(unpacked, 'Transius.exe'));
  if (!hasMain) throw new Error('win-unpacked 内容异常：缺少 Transius.exe');
}

/* ── 3. 压缩成 payload.zip ─────────────────────────────────────────────── */
rmrf(payloadDir);
fs.mkdirSync(payloadDir, { recursive: true });

console.log('\n正在压缩应用负载…');
// 用 tar 的 zip 模式（Windows 10+ 自带 bsdtar），绕过 PowerShell 的慢速压缩
try {
  execSync(
    `tar -a -c -f "${payloadZip}" -C "${unpacked}" .`,
    { cwd: root, stdio: 'inherit' },
  );
} catch {
  // 回退到 PowerShell
  execSync(
    `powershell -NoProfile -NonInteractive -Command "Compress-Archive -Path '${unpacked}\\*' -DestinationPath '${payloadZip}' -CompressionLevel Optimal -Force"`,
    { cwd: root, stdio: 'inherit' },
  );
}

const payloadMb = (fs.statSync(payloadZip).size / 1048576).toFixed(1);
console.log(`负载包: ${payloadMb} MB`);

/* ── 4. 打包安装器 exe ─────────────────────────────────────────────────── */

// 版本信息文件，写进 resources/ 供安装器显示
fs.writeFileSync(path.join(payloadDir, 'version.txt'), version, 'utf8');

// 安装器需要一个独立的 project 目录：它的 package.json 入口是 installer/main.js，
// 不能复用主应用的 package.json（否则会去加载主应用入口）。
const projDir = path.join(root, 'build', 'installer-project');
rmrf(projDir);
fs.mkdirSync(projDir, { recursive: true });

const installerPkg = {
  name: 'transius-setup',
  version,
  description: 'Transius Installer',
  main: 'installer/main.js',
  author: 'Transius',
  license: 'MIT',
  private: true,
};
fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify(installerPkg, null, 2));

// 把安装器源码复制进去，保持 installer/ 这一层目录结构
fs.cpSync(path.join(root, 'installer'), path.join(projDir, 'installer'), {
  recursive: true,
});

// 安装器 project 目录里没有 node_modules，必须显式告诉 electron-builder
// 用哪个 Electron 版本。注意要读**已安装的实际版本**，而不是
// package.json 里的范围（devDependencies 写的是 "^^31.2.0" 这类范围，
// 直接用会让安装器与主应用跑在不同 Electron 上）。
const installedElectron = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;

const installerBuildConfig = {
  appId: 'app.transius.installer',
  productName: 'Transius-Setup',
  copyright: 'Transius',
  electronVersion: installedElectron,
  directories: { output: outDir, buildResources: path.join(root, 'build') },
  files: ['installer/**/*', 'package.json'],
  extraResources: [
    { from: payloadDir, to: 'payload' },
    { from: path.join(payloadDir, 'version.txt'), to: 'version.txt' },
  ],
  win: {
    target: [{ target: 'portable', arch: ['x64'] }],
    artifactName: `Transius-Setup-${version}.exe`,
    signAndEditExecutable: false,
  },
  portable: {
    unicode: true,
  },
};

const cfgPath = path.join(root, 'build', 'installer-build.json');
fs.writeFileSync(cfgPath, JSON.stringify(installerBuildConfig, null, 2), 'utf8');

rmrf(outDir);
run(
  `npx electron-builder --config "${cfgPath}" --win --x64 --project "${projDir}"`,
);

const exePath = path.join(outDir, `Transius-Setup-${version}.exe`);
if (!fs.existsSync(exePath)) {
  throw new Error(`未生成安装器：${exePath}`);
}
const exeMb = (fs.statSync(exePath).size / 1048576).toFixed(1);
console.log(`\n✓ 安装器已生成: ${exePath}  (${exeMb} MB)`);
