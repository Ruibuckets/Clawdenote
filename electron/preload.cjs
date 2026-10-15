const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  libraryList: includeDeleted => ipcRenderer.invoke('library:list', includeDeleted),
  libraryRead: id => ipcRenderer.invoke('library:read', id),
  librarySave: (id, data, previewDataUrl) => ipcRenderer.invoke('library:save', id, data, previewDataUrl),
  libraryImport: (data, sourcePath, previewDataUrl) => ipcRenderer.invoke('library:import', data, sourcePath, previewDataUrl),
  libraryDelete: id => ipcRenderer.invoke('library:delete', id),
  libraryRestore: id => ipcRenderer.invoke('library:restore', id),
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
