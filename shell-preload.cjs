const { contextBridge, ipcRenderer } = require('electron');
let bindings = {};
ipcRenderer.on('desktop:bindings', (_event, value) => { bindings = value; });

if (process.isMainFrame && /\/(shell|navigation)\.html$/.test(location.pathname)) window.addEventListener('keydown', event => {
  if (!event.isTrusted || event.repeat || event.isComposing || event.composedPath().some(node =>
    node instanceof Element && (node.isContentEditable || node.matches('input,textarea,select,[role="textbox"],[role="searchbox"],[role="combobox"],[role="dialog"],dialog')))) return;
  const key = event.code === 'Space' || event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const binding = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+');
  const action = Object.keys(bindings).find(action => bindings[action] && bindings[action] === binding);
  if (!action) return;
  event.preventDefault(); event.stopImmediatePropagation();
  ipcRenderer.send('desktop:shortcut', action);
}, true);

contextBridge.exposeInMainWorld('desktop', {
  request: (action, value) => ipcRenderer.invoke('desktop:request', { action, value }),
  command: (action, value) => ipcRenderer.send('shell:command', { action, value }),
  onState: callback => ipcRenderer.on('shell:state', (_event, state) => callback(state)),
  onPreview: callback => ipcRenderer.on('shell:preview', (_event, images) => callback(images)),
  onEndDrag: callback => ipcRenderer.on('shell:end-drag', callback)
});
