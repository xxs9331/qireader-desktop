const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  command: (action, value) => ipcRenderer.send('shell:command', { action, value }),
  onState: callback => ipcRenderer.on('shell:state', (_event, state) => callback(state)),
  onPreview: callback => ipcRenderer.on('shell:preview', (_event, images) => callback(images)),
  onEndDrag: callback => ipcRenderer.on('shell:end-drag', callback)
});
