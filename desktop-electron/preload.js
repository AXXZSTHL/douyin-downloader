const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  get: (endpoint) => ipcRenderer.invoke('api:get', endpoint),
  post: (endpoint, body) => ipcRenderer.invoke('api:post', endpoint, body),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPlatform: () => ipcRenderer.invoke('app:getPlatform'),
  getDownloadsPath: () => ipcRenderer.invoke('app:getDownloadsPath'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  login: () => ipcRenderer.invoke('app:login'),
  isPackaged: () => ipcRenderer.invoke('app:isPackaged'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update:status', (_event, info) => callback(info));
  },
});
