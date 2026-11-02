// The only bridge between the palette and the machine. Nothing else is exposed:
// no filesystem, no shell, no arbitrary fetch — the renderer can ask the main
// process to sign in, search, open a rayisweddings.com path, install the
// update the main process has already found, and work the Inquiries window —
// and that is the whole surface.
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
  installUpdate: () => ipcRenderer.invoke('dock:installUpdate'),
  openInquiries: () => ipcRenderer.invoke('dock:openInquiries'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onOpened: (fn) => ipcRenderer.on('opened', () => fn()),
});

// The Inquiries window's half: read the list, and ask the main process to
// open a reply, a menu, an undo — the fetching and the marking happen there.
contextBridge.exposeInMainWorld('inq', {
  getState: () => ipcRenderer.invoke('inq:state'),
  reply: (id) => ipcRenderer.invoke('inq:reply', id),
  menu: (id) => ipcRenderer.invoke('inq:menu', id),
  undo: () => ipcRenderer.invoke('inq:undo'),
  flow: () => ipcRenderer.invoke('inq:flow'),
  close: () => ipcRenderer.invoke('inq:close'),
  resize: (h) => ipcRenderer.invoke('inq:resize', h),
  onState: (fn) => ipcRenderer.on('inq', (_e, s) => fn(s)),
});
