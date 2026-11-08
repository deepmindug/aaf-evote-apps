const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('station', {
  platform: 'windows',
  saveFile: (name, text) => ipcRenderer.invoke('save-file', name, text)
});
