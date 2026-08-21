// RAYIS Dock for Windows.
//
// The same idea as the Mac dock: press one key, anywhere, and search everything
// your RAYIS HQ login opens. Not a second set of permissions — the person signs
// in with their own RAYIS HQ email and password and the website answers with
// the apps their grants already open. Take Gallery away from somebody in the
// Login Center and the tile is gone from their dock within the quarter-hour.
//
// The Mac version is a native SwiftUI app (~/rayis-dock). This is Electron,
// matching RAYIS Chat Desktop's build so the studio has one Windows pipeline
// rather than two. Everything it knows comes from three endpoints:
//
//   POST /hq/api/dock-session            sign in  -> a session token
//   GET  /downloads/dock-catalog.json?me=1        this person's apps
//   GET  /hq/api/dock-search?q=          couples / leads / galleries / crew,
//                                        already scoped to their grants
//
// Nothing about who-may-see-what is decided here. That is the point.

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell,
  nativeImage, safeStorage, screen, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');

const SITE = 'https://rayisweddings.com';
const DEFAULT_HOTKEY = '\\';               // the key the dock has always used
const CATALOG_INTERVAL = 15 * 60 * 1000;   // Ray ships tools all week
const STALE_MS = 2 * 60 * 1000;

let tray = null;
let palette = null;
let recorder = null;
let catalogTimer = null;
let lastCatalogFetch = 0;

/* --------------------------------------------------------------- stored state */

const userDir = () => app.getPath('userData');
const configPath = () => path.join(userDir(), 'config.json');
const sessionPath = () => path.join(userDir(), 'session.dat');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  } catch { /* a read-only profile shouldn't take the app down */ }
  return next;
}

// The session token is a key to this person's whole RAYIS HQ, so it is
// encrypted with the OS keystore (DPAPI on Windows, the keychain on a Mac)
// rather than left readable in a file next to it. If the OS can't do that —
// some locked-down profiles can't — we keep nothing rather than keep it plain,
// and the person signs in again next launch.
function readToken() {
  try {
    const raw = fs.readFileSync(sessionPath());
    if (!safeStorage.isEncryptionAvailable()) return null;
    const s = safeStorage.decryptString(raw);
    return s && s.trim() ? s.trim() : null;
  } catch {
    return null;
  }
}

function writeToken(token) {
  try {
    if (!token) {
      fs.rmSync(sessionPath(), { force: true });
      return true;
    }
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.mkdirSync(userDir(), { recursive: true });
    fs.writeFileSync(sessionPath(), safeStorage.encryptString(token));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ the state */

const state = {
  signedIn: false,
  who: { name: '', email: '', role: '' },
  apps: [],
  favorites: [],
  hotkey: DEFAULT_HOTKEY,
  hotkeyOK: true,
  updateVersion: null,
  error: null,
};

function tell(win, channel, payload) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch { /* the window is going away — nothing to tell */ }
}

function pushState() {
  tell(palette, 'state', state);
  tell(recorder, 'state', state);
  buildTray();
}

/* ----------------------------------------------------------------- the website */

function cookieHeader() {
  const t = readToken();
  return t ? { Cookie: `rayis_hq_u=${t}` } : null;
}

function isNewer(a, b) {
  const x = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const y = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const l = x[i] || 0; const r = y[i] || 0;
    if (l !== r) return l > r;
  }
  return false;
}

// The app list, fresh. Anything the team registered for the HQ login is here
// within minutes of shipping, and so is any grant Ray changed — in both
// directions. This is why the list is fetched rather than shipped.
async function refreshCatalog() {
  const headers = cookieHeader();
  if (!headers) return;
  try {
    const res = await fetch(`${SITE}/downloads/dock-catalog.json?me=1`, {
      headers, cache: 'no-store',
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.dockVersion && isNewer(data.dockVersion, app.getVersion())) {
      state.updateVersion = data.dockVersion;
    } else {
      state.updateVersion = null;
    }
    // The website is the authority on whether this session is still good.
    // "Not signed in" empties the dock rather than leaving yesterday's tiles
    // behind a login that has been switched off.
    if (data.signedIn !== true) {
      signOut({ silent: true, reason: 'Your RAYIS HQ session ended — sign in again.' });
      return;
    }
    lastCatalogFetch = Date.now();
    state.signedIn = true;
    if (data.you) state.who = data.you;
    state.apps = Array.isArray(data.apps) ? data.apps : [];

    // A favourite pointing at an app they no longer hold stops existing; a
    // brand-new dock fills itself with the first few apps they DO have, so
    // nobody opens an empty card on day one.
    const live = new Set(state.apps.map((a) => a.path));
    let favs = (state.favorites || []).filter((p) => live.has(p));
    if (!favs.length) {
      favs = state.apps
        .filter((a) => a.path !== '/hq' && !a.path.endsWith('.html'))
        .slice(0, 6)
        .map((a) => a.path);
    }
    state.favorites = favs;
    writeConfig({ favorites: favs, who: state.who });
    pushState();
  } catch { /* offline — the cached list keeps working */ }
}

function refreshCatalogIfStale() {
  if (Date.now() - lastCatalogFetch > STALE_MS) refreshCatalog();
}

/* -------------------------------------------------------------------- sign in */

async function signIn(email, password) {
  try {
    const res = await fetch(`${SITE}/hq/api/dock-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.token) {
      return { ok: false, error: data.error || 'Wrong email or password.' };
    }
    if (!writeToken(data.token)) {
      return { ok: false, error: 'Windows wouldn’t let the app store your sign-in. Ask Ray.' };
    }
    state.signedIn = true;
    state.error = null;
    state.who = { name: data.name || '', email: data.email || email, role: data.role || 'member' };
    state.apps = Array.isArray(data.apps) ? data.apps : [];
    lastCatalogFetch = Date.now();
    writeConfig({ who: state.who });
    await refreshCatalog();
    pushState();
    return { ok: true };
  } catch {
    return { ok: false, error: 'Couldn’t reach rayisweddings.com — check the internet.' };
  }
}

function signOut({ silent = false, reason = null } = {}) {
  const headers = cookieHeader();
  // Tell the website to forget the session too, so a lost laptop is one click
  // away from being locked out rather than good for another thirty days.
  if (headers && !silent) {
    fetch(`${SITE}/hq/api/dock-session`, { method: 'DELETE', headers }).catch(() => {});
  }
  writeToken(null);
  state.signedIn = false;
  state.apps = [];
  state.favorites = [];
  state.error = reason;
  writeConfig({ favorites: [] });
  pushState();
}

/* --------------------------------------------------------------------- search */

async function search(q) {
  const headers = cookieHeader();
  if (!headers || !q || q.trim().length < 2) return { sections: [] };
  try {
    const res = await fetch(`${SITE}/hq/api/dock-search?q=${encodeURIComponent(q.trim())}`, {
      headers, cache: 'no-store',
    });
    if (res.status === 403 || res.status === 401) return { sections: [] };
    if (!res.ok) return { sections: [] };
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      // The gate answered with its login page — this session is finished.
      signOut({ silent: true, reason: 'Your RAYIS HQ session ended — sign in again.' });
      return { sections: [] };
    }
    return await res.json();
  } catch {
    return { sections: [] };
  }
}

/* ------------------------------------------------------------------- the key */

function registerHotkey(accel) {
  globalShortcut.unregisterAll();
  let ok = false;
  try { ok = globalShortcut.register(accel, togglePalette); } catch { ok = false; }
  if (!ok && accel !== DEFAULT_HOTKEY) {
    // Somebody else already owns that combination. Fall back rather than leave
    // the dock with no key at all, and say so instead of failing silently.
    try { ok = globalShortcut.register(DEFAULT_HOTKEY, togglePalette); } catch { ok = false; }
    state.hotkey = DEFAULT_HOTKEY;
    writeConfig({ hotkey: DEFAULT_HOTKEY });
    state.error = `That shortcut is taken — kept ${DEFAULT_HOTKEY}`;
  } else {
    state.hotkey = accel;
  }
  state.hotkeyOK = ok;
  pushState();
  return ok;
}

/* ------------------------------------------------------------------ the windows */

function createPalette() {
  palette = new BrowserWindow({
    width: 680,
    height: 460,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  palette.setAlwaysOnTop(true, 'screen-saver');
  palette.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  palette.loadFile(path.join(__dirname, 'renderer', 'palette.html'));
  palette.on('blur', () => palette.hide());   // clicking elsewhere dismisses — Spotlight manners
  palette.on('close', (e) => { e.preventDefault(); palette.hide(); });
  palette.webContents.on('did-finish-load', () => pushState());
}

// Centred on the display the cursor is on, a little above middle — the place
// the eye is already looking, and it follows a person between monitors.
function positionPalette() {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const [w, h] = palette.getSize();
  palette.setPosition(
    Math.round(workArea.x + (workArea.width - w) / 2),
    Math.round(workArea.y + Math.max(40, workArea.height * 0.16)),
  );
}

function showPalette() {
  if (!palette || palette.isDestroyed()) createPalette();
  positionPalette();
  palette.show();
  palette.focus();
  // Same debug hook the Mac dock has: open the palette at launch and print
  // where it landed, so a build can be looked at without a keystroke.
  if (process.env.RAYIS_DEBUG_SEARCH) console.log('[dock] bounds', JSON.stringify(palette.getBounds()));
  tell(palette, 'opened');
  refreshCatalogIfStale();
}

function togglePalette() {
  if (palette && palette.isVisible()) palette.hide();
  else showPalette();
}

// "Press the key you want." A small window rather than a menu, because the
// answer is a keystroke and a menu can't take one.
function openRecorder() {
  if (recorder && !recorder.isDestroyed()) { recorder.focus(); return; }
  recorder = new BrowserWindow({
    width: 420, height: 260, show: false, frame: false, transparent: true,
    resizable: false, skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  recorder.loadFile(path.join(__dirname, 'renderer', 'shortcut.html'));
  recorder.once('ready-to-show', () => {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    recorder.setPosition(
      Math.round(workArea.x + (workArea.width - 420) / 2),
      Math.round(workArea.y + (workArea.height - 260) / 2),
    );
    recorder.show();
    tell(recorder, 'state', state);
  });
  recorder.on('closed', () => { recorder = null; });
}

/* ---------------------------------------------------------------------- tray */

function trayImage() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function buildTray() {
  if (!tray) {
    tray = new Tray(trayImage());
    tray.on('click', showPalette);
  }
  const favApps = state.favorites
    .map((p) => state.apps.find((a) => a.path === p))
    .filter(Boolean);

  const items = [];
  if (state.signedIn && state.who.name) {
    items.push({ label: `Signed in as ${state.who.name}`, enabled: false });
    items.push({ type: 'separator' });
  }
  items.push({ label: `Search RAYIS  (${state.hotkey})`, click: showPalette });
  items.push({ label: 'Change the search key…', click: openRecorder });
  if (state.updateVersion) {
    items.push({ type: 'separator' });
    items.push({
      label: `Update available — version ${state.updateVersion}`,
      click: () => shell.openExternal(`${SITE}/dock-setup`),
    });
  }
  if (favApps.length) {
    items.push({ type: 'separator' });
    for (const a of favApps) {
      items.push({
        label: `${a.emoji || ''}  ${a.name}`.trim(),
        click: () => shell.openExternal(SITE + a.path),
      });
    }
  }
  items.push({ type: 'separator' });
  items.push({
    label: 'Start when Windows starts',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
  });
  if (state.signedIn) items.push({ label: 'Sign out of RAYIS HQ', click: () => signOut() });
  items.push({ label: 'Quit RAYIS Dock', click: () => { app.isQuitting = true; app.quit(); } });

  tray.setToolTip(state.signedIn
    ? `RAYIS Dock — ${state.who.name || 'signed in'} · press ${state.hotkey}`
    : 'RAYIS Dock — sign in to get started');
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/* ------------------------------------------------------------------- plumbing */

ipcMain.handle('dock:signIn', (_e, { email, password }) => signIn(email, password));
ipcMain.handle('dock:signOut', () => { signOut(); return true; });
ipcMain.handle('dock:state', () => state);
ipcMain.handle('dock:search', (_e, q) => search(q));
ipcMain.handle('dock:open', (_e, p) => {
  shell.openExternal(p.startsWith('http') ? p : SITE + p);
  if (palette) palette.hide();
  return true;
});
ipcMain.handle('dock:hide', () => { if (palette) palette.hide(); return true; });
ipcMain.handle('dock:resize', (_e, h) => {
  if (palette && !palette.isDestroyed()) {
    palette.setSize(680, Math.max(120, Math.min(700, Math.round(h))));
  }
  return true;
});
ipcMain.handle('dock:setHotkey', (_e, accel) => {
  const ok = registerHotkey(accel || DEFAULT_HOTKEY);
  if (ok) writeConfig({ hotkey: state.hotkey });
  return { ok, hotkey: state.hotkey };
});
ipcMain.handle('dock:closeRecorder', () => { if (recorder) recorder.close(); return true; });
ipcMain.handle('dock:favorites', (_e, favs) => {
  state.favorites = Array.isArray(favs) ? favs : [];
  writeConfig({ favorites: state.favorites });
  pushState();
  return true;
});

// One dock per machine. A second launch just opens the palette on the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showPalette);

  app.whenReady().then(() => {
    // Tray-only. On a Mac this app is a fallback (the real Mac dock is the
    // native one in ~/rayis-dock), so it should never take a Dock slot either.
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

    const cfg = readConfig();
    state.favorites = Array.isArray(cfg.favorites) ? cfg.favorites : [];
    state.who = cfg.who || state.who;
    state.signedIn = Boolean(readToken());

    createPalette();
    registerHotkey(cfg.hotkey || DEFAULT_HOTKEY);
    buildTray();

    // The whole point of a dock is that it's already there.
    if (cfg.openAtLogin !== false) app.setLoginItemSettings({ openAtLogin: true });

    refreshCatalog();
    catalogTimer = setInterval(refreshCatalog, CATALOG_INTERVAL);
    powerMonitor.on('resume', refreshCatalog);   // a sleeping laptop misses ticks

    // Nobody signed in yet: show them the way in rather than a silent tray icon.
    if (!state.signedIn || process.env.RAYIS_DEBUG_SEARCH) setTimeout(showPalette, 900);
  });

  app.on('window-all-closed', (e) => e.preventDefault());  // it lives in the tray
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (catalogTimer) clearInterval(catalogTimer);
  });
}
