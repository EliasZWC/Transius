'use strict';

/**
 * 安装器渲染进程脚本。
 * 只通过 preload 暴露的 window.setup API 与主进程通信，不直接碰 Node。
 */

const api = window.setup;

const $ = (id) => document.getElementById(id);
const el = {
  tbTitle: $('tbTitle'),
  headTitle: $('headTitle'),
  headSub: $('headSub'),
  stepInstall: $('stepInstall'),
  stepProgress: $('stepProgress'),
  stepDone: $('stepDone'),
  stepError: $('stepError'),
  installPath: $('installPath'),
  btnBrowse: $('btnBrowse'),
  optDesktop: $('optDesktop'),
  optStartMenu: $('optStartMenu'),
  optLaunch: $('optLaunch'),
  spaceInfo: $('spaceInfo'),
  progFill: $('progFill'),
  progPercent: $('progPercent'),
  progStage: $('progStage'),
  progDetail: $('progDetail'),
  doneTitle: $('doneTitle'),
  doneSub: $('doneSub'),
  errTitle: $('errTitle'),
  errDetail: $('errDetail'),
  btnCancel: $('btnCancel'),
  btnMain: $('btnMain'),
  btnMin: $('btnMin'),
  btnClose: $('btnClose'),
};

let mode = 'install'; // 'install' | 'uninstall'
let busy = false;
let installed = { dir: '', dataDir: '' };

const t = {
  install: '安装',
  installing: '正在安装…',
  uninstall: '卸载',
  uninstalling: '正在卸载…',
  cancel: '取消',
  close: '关闭',
  finish: '完成',
  done: '安装完成',
  doneUninstall: '卸载完成',
};

/* ── 窗口控制 ─────────────────────────────────────────────────────────── */

el.btnMin.addEventListener('click', () => api.win.minimize());
el.btnClose.addEventListener('click', () => api.win.close());

/* ── 初始化 ───────────────────────────────────────────────────────────── */

async function init() {
  const info = await api.info();
  mode = info.mode || 'install';
  installed = { dir: info.installDir, dataDir: info.dataDir };

  el.installPath.value = info.installDir;

  if (mode === 'uninstall') {
    el.tbTitle.textContent = 'Transius Uninstall';
    setupUninstallUi(info);
  } else if (mode === 'update') {
    el.tbTitle.textContent = 'Transius Update';
    setupUpdateUi(info);
  } else {
    el.tbTitle.textContent = 'Transius Setup';
    setupInstallUi(info);
  }
}

function setupUpdateUi(info) {
  el.headTitle.textContent = '更新 Transius';
  el.headSub.textContent =
    `已安装 ${info.installedVersion || '旧版本'} → 新版本 ${info.version}`;
  // 更新时快捷方式已存在，无需再问
  for (const input of [el.optDesktop, el.optStartMenu]) {
    const row = input.closest('.option');
    if (row) row.hidden = true;
  }
  el.btnMain.textContent = '更新';

  const mb = (info.payloadSize / (1024 * 1024)).toFixed(0);
  el.spaceInfo.innerHTML =
    `将覆盖安装到现有位置：<br /><code>${info.installDir}</code><br /><br />` +
    `需要约 <code>${mb} MB</code> 空间，个人设置与已保存的连接不受影响。`;
}

function setupInstallUi(info) {
  el.headTitle.textContent = '安装 Transius';
  el.headSub.textContent = `版本 ${info.version} · SSH 文件传输客户端`;
  el.optDesktop.checked = true;
  el.btnMain.textContent = t.install;

  const mb = (info.payloadSize / (1024 * 1024)).toFixed(0);
  el.spaceInfo.innerHTML =
    `安装需要约 <code>${mb} MB</code> 磁盘空间<br />` +
    `按用户安装，<code>无需管理员权限</code><br />` +
    `卸载信息将写入当前用户注册表`;

  el.installPath.addEventListener('input', () => {
    el.installPath.dataset.edited = '1';
  });
}

/** 隐藏三个与安装相关的选项行（卸载模式不需要） */
function hideInstallOptions() {
  for (const input of [el.optDesktop, el.optStartMenu, el.optLaunch]) {
    const row = input.closest('.option');
    if (row) row.hidden = true;
  }
}

function setupUninstallUi(info) {
  el.headTitle.textContent = '卸载 Transius';
  el.headSub.textContent = `版本 ${info.installedVersion || info.version}`;
  hideInstallOptions();
  el.installPath.readOnly = true;
  el.btnBrowse.hidden = true;
  el.btnMain.textContent = t.uninstall;

  el.spaceInfo.innerHTML =
    `将从以下位置移除程序文件：<br /><code>${info.installDir}</code><br /><br />` +
    `<label class="option" style="padding:0">` +
    `<input type="checkbox" id="optKeepData" checked />` +
    `<span>保留个人设置与已保存的连接</span></label>` +
    `<div style="color:#6e6e6c;font-size:11px;margin-top:6px">` +
    `数据目录：${info.dataDir}</div>`;
}

/* ── 浏览目录 ─────────────────────────────────────────────────────────── */

el.btnBrowse.addEventListener('click', async () => {
  const picked = await api.pickDirectory(el.installPath.value);
  if (picked) {
    el.installPath.value = picked;
    el.installPath.dataset.edited = '1';
  }
});

/* ── 主按钮 ───────────────────────────────────────────────────────────── */

el.btnMain.addEventListener('click', async () => {
  if (busy) return;
  if (mode === 'uninstall') await doUninstall();
  else await doInstall();
});

el.btnCancel.addEventListener('click', () => api.win.close());

/* ── 安装流程 ─────────────────────────────────────────────────────────── */

async function doInstall() {
  busy = true;
  el.btnMain.disabled = true;
  el.btnCancel.disabled = true;
  el.btnBrowse.disabled = true;

  el.stepInstall.hidden = true;
  el.stepProgress.hidden = false;
  el.stepError.hidden = true;
  el.btnMain.textContent = t.installing;

  const keepData = document.getElementById('optKeepData');
  const options = {
    installDir: el.installPath.value.trim(),
    desktopShortcut: el.optDesktop.checked,
    startMenuShortcut: el.optStartMenu.checked,
    launchAfter: el.optLaunch.checked,
    keepData: keepData ? keepData.checked : true,
  };

  const off = api.onProgress((e) => {
    const pct = e.total > 0 ? Math.min(100, (e.done / e.total) * 100) : 0;
    el.progFill.style.width = `${pct}%`;
    el.progPercent.textContent = `${pct.toFixed(0)}%`;
    el.progStage.textContent = e.stage || '正在安装…';
    if (e.detail) el.progDetail.textContent = e.detail;
  });

  try {
    const result = await api.install(options);
    off();
    if (!result.ok) throw new Error(result.error || '未知错误');
    showDone(result.dir, options.launchAfter);
  } catch (err) {
    off();
    showError('安装失败', err && err.message ? err.message : String(err));
  }
}

async function doUninstall() {
  busy = true;
  el.btnMain.disabled = true;
  el.btnCancel.disabled = true;

  el.stepInstall.hidden = true;
  el.stepProgress.hidden = false;
  el.stepError.hidden = true;
  el.btnMain.textContent = t.uninstalling;

  const keepData = document.getElementById('optKeepData');

  const off = api.onProgress((e) => {
    const pct = e.total > 0 ? Math.min(100, (e.done / e.total) * 100) : 0;
    el.progFill.style.width = `${pct}%`;
    el.progPercent.textContent = `${pct.toFixed(0)}%`;
    el.progStage.textContent = e.stage || '正在卸载…';
    if (e.detail) el.progDetail.textContent = e.detail;
  });

  try {
    const result = await api.uninstall({
      installDir: installed.dir,
      dataDir: installed.dataDir,
      keepData: keepData ? keepData.checked : true,
    });
    off();
    if (!result.ok) throw new Error(result.error || '未知错误');
    showUninstallDone(result.note);
  } catch (err) {
    off();
    showError('卸载失败', err && err.message ? err.message : String(err));
  }
}

/* ── 结果页 ───────────────────────────────────────────────────────────── */

function showDone(dir, launched) {
  el.stepProgress.hidden = true;
  el.stepDone.hidden = false;
  el.doneTitle.textContent = t.done;
  el.doneSub.innerHTML =
    `Transius 已安装到<br /><code style="color:#ECECEA">${dir}</code>` +
    (launched ? '<br /><br />正在启动…' : '');
  el.btnMain.textContent = t.finish;
  el.btnMain.disabled = false;
  el.btnCancel.hidden = true;
  el.btnMain.onclick = () => api.win.close();
  if (launched) setTimeout(() => api.win.close(), 1600);
}

function showUninstallDone(note) {
  el.stepProgress.hidden = true;
  el.stepDone.hidden = false;
  el.doneTitle.textContent = t.doneUninstall;
  el.doneSub.textContent = note || 'Transius 已从本机移除。';
  el.btnMain.textContent = t.close;
  el.btnMain.disabled = false;
  el.btnCancel.hidden = true;
  el.btnMain.onclick = () => api.win.close();

  // ⚠️ 卸载后必须自动退出：安装器进程会持有安装目录里的文件句柄，
  //    进程不退出，后台清理脚本永远删不掉那个目录。
  //    给用户留 2.5 秒看结果，然后自动关闭。
  setTimeout(() => api.win.close(), 2500);
}

function showError(title, detail) {
  el.stepProgress.hidden = true;
  el.stepError.hidden = false;
  el.errTitle.textContent = title;
  el.errDetail.textContent = detail;
  el.btnMain.textContent = t.close;
  el.btnMain.disabled = false;
  el.btnCancel.hidden = true;
  el.btnMain.onclick = () => api.win.close();
}

init().catch((e) => {
  showError('初始化失败', String(e && e.message ? e.message : e));
});
