// Safe bridge between the web UI and Node: only these three functions are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  openFiles: (accept, multiple) => ipcRenderer.invoke('open-files', accept, multiple),
  saveFile: (name, data) => ipcRenderer.invoke('save-file', name, data),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files)),
});
