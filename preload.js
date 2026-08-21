// The only bridge between the palette and the machine. Nothing else is exposed:
// no filesystem, no shell, no arbitrary fetch — the renderer can ask the main
// process to sign in, search, and open a rayisweddings.com path, and that is
// the whole surface.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dock', {
  signIn: (email, password) => ipcRenderer.invoke('dock:signIn', { email, password }),
  signOut: () => ipcRenderer.invoke('dock:signOut'),
  getState: () => ipcRenderer.invoke('dock:state'),
  search: (q) => ipcRenderer.invoke('dock:search', q),
  open: (p) => ipcRenderer.invoke('dock:open', p),
  hide: () => ipcRenderer.invoke('dock:hide'),
  resize: (h) => ipcRenderer.invoke('dock:resize', h),
  setHotkey: (accel) => ipcRenderer.invoke('dock:setHotkey', accel),
  closeRecorder: () => ipcRenderer.invoke('dock:closeRecorder'),
  setFavorites: (favs) => ipcRenderer.invoke('dock:favorites', favs),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onOpened: (fn) => ipcRenderer.on('opened', () => fn()),
});
