'use strict';

/**
 * 安装器 preload：只暴露白名单方法。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  info: () => ipcRenderer.invoke('setup:info'),
  pickDirectory: (current) => ipcRenderer.invoke('setup:pickDirectory', current),
  install: (options) => ipcRenderer.invoke('setup:install', options),
  uninstall: (options) => ipcRenderer.invoke('setup:uninstall', options),
  openExternal: (url) => ipcRenderer.invoke('setup:openExternal', url),

  win: {
    minimize: () => ipcRenderer.invoke('setup:minimize'),
    close: () => ipcRenderer.invoke('setup:close'),
  },

  onProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('setup:progress', listener);
    return () => ipcRenderer.removeListener('setup:progress', listener);
  },
});
