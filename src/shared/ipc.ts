/** 主进程与预加载共享的 IPC 通道名常量（避免字符串拼写错误） */
export const IPC = {
  profileList: 'profile:list',
  profileSave: 'profile:save',
  profileRemove: 'profile:remove',
  profilePickKey: 'profile:pickKey',

  sshConnect: 'ssh:connect',
  sshDisconnect: 'ssh:disconnect',
  sshStatus: 'ssh:status',

  fsListLocal: 'fs:listLocal',
  fsListRemote: 'fs:listRemote',
  fsHomeLocal: 'fs:homeLocal',
  fsMkdirRemote: 'fs:mkdirRemote',
  fsRemoveRemote: 'fs:removeRemote',
  fsRenameRemote: 'fs:renameRemote',
  fsChmodRemote: 'fs:chmodRemote',
  fsPathExistsLocal: 'fs:pathExistsLocal',

  dialogPickFiles: 'dialog:pickFiles',
  dialogPickDirectory: 'dialog:pickDirectory',
  dialogPickSaveDirectory: 'dialog:pickSaveDirectory',
  dialogOpenPath: 'dialog:openPath',
  dialogRevealPath: 'dialog:revealPath',

  transferEnqueue: 'transfer:enqueue',
  transferPause: 'transfer:pause',
  transferResume: 'transfer:resume',
  transferCancel: 'transfer:cancel',
  transferRetry: 'transfer:retry',
  transferRemove: 'transfer:remove',
  transferClearFinished: 'transfer:clearFinished',
  transferSnapshot: 'transfer:snapshot',
  /** 主进程 → 渲染进程：进度推送 */
  transferProgress: 'transfer:progress',
  /** 主进程 → 渲染进程：状态变化推送 */
  transferState: 'transfer:state',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  // 自绘标题栏的窗口控制
  windowMinimize: 'window:minimize',
  windowMaximizeToggle: 'window:maximizeToggle',
  windowClose: 'window:close',
  windowQueryState: 'window:queryState',
  /** 主进程 → 渲染进程：最大化 / 焦点变化推送 */
  windowState: 'window:state',
} as const;
