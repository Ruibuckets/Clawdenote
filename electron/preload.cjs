const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  open: kind => ipcRenderer.invoke('file:open', kind),
  save: (data, options) => ipcRenderer.invoke('file:save', data, options),
  autosave: data => ipcRenderer.invoke('recovery:save', data),
  recovery: () => ipcRenderer.invoke('recovery:read'),
  print: () => ipcRenderer.invoke('document:print'),
  onClose: callback => { const listener = () => callback(); ipcRenderer.on('document:closing', listener); return () => ipcRenderer.removeListener('document:closing', listener); },
  closeReady: () => ipcRenderer.send('document:close-ready'),
  confirmClose: () => ipcRenderer.invoke('document:confirm-close'),
  version: () => ipcRenderer.invoke('app:version')
});
