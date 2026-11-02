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
//
// The catalog and the sign-in also carry `dockVersionWin` — the newest Windows
// dock that has been published. When that is ahead of this build the dock says
// so, in the tray and in the palette, and one click downloads the installer
// from the GitHub release and runs it over the top of this copy.

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell,
  nativeImage, safeStorage, screen, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

// Overrides for looking at a build against a local stub. They are read
// only when the app is run from source (`electron .`), never in an installed
// copy — an installed dock always talks to the real site and only ever runs
// the installer from the real release, whatever the environment says.
const fromSource = !app.isPackaged;
const SITE = ((fromSource && process.env.RAYIS_DOCK_SITE) || 'https://rayisweddings.com')
  .replace(/\/+$/, '');
const UPDATE_URL = (fromSource && process.env.RAYIS_DOCK_UPDATE_URL)
  || 'https://github.com/rayisweddings/rayis-dock-app/releases/latest/download/RAYIS-Dock-Setup.exe';
// And a third: a scratch profile, so a test run on Ray's Mac never writes into
// ~/Library/Application Support/RAYIS Dock, which the native Mac dock owns.
if (fromSource && process.env.RAYIS_DOCK_USERDATA) app.setPath('userData', process.env.RAYIS_DOCK_USERDATA);
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
  version: app.getVersion(),   // what this copy is
  updateVersion: null,         // the newer one on offer, or null
  updating: false,             // an update is downloading / installing right now
  updateStep: null,            // one short line about where that has got to
  updateError: null,           // one plain sentence when it didn't work
  inquiries: { allowed: false, needed: 0 },   // the Inquiries window, for the palette and the tray
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

// Is there a newer Windows dock than this one? The website says which version
// is published in `dockVersionWin`. (`dockVersion` is the Mac app's number and
// means nothing here.) No field, or nothing newer, means no update. Answers
// whether anything changed, so the caller knows to redraw.
function noteVersion(data) {
  if (state.updating) return false;        // don't pull the row out from under a download
  const raw = data && data.dockVersionWin;
  const v = (typeof raw === 'string' || typeof raw === 'number') ? String(raw).trim() : '';
  const next = /^\d+(\.\d+)*$/.test(v) && isNewer(v, app.getVersion()) ? v : null;
  if (next === state.updateVersion) return false;
  state.updateVersion = next;
  state.updateStep = null;
  state.updateError = null;
  return true;
}

// The app list, fresh. Anything the team registered for the HQ login is here
// within minutes of shipping, and so is any grant Ray changed — in both
// directions. This is why the list is fetched rather than shipped.
async function refreshCatalog() {
  const headers = cookieHeader();
  try {
    const res = await fetch(`${SITE}/downloads/dock-catalog.json?me=1`, {
      headers: headers || {}, cache: 'no-store',
    });
    if (!res.ok) return;
    const data = await res.json();
    const versionChanged = noteVersion(data);
    // Nobody signed in when this was asked: the only thing the answer is good
    // for is the version. The sign-in card stays exactly as it was.
    if (!headers) {
      lastCatalogFetch = Date.now();
      if (versionChanged) pushState();
      return;
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
    noteVersion(data);
    lastCatalogFetch = Date.now();
    writeConfig({ who: state.who });
    await refreshCatalog();
    pushState();
    resetInquiries();
    refreshInquiries();
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
  resetInquiries();
  pushState();
}

/* --------------------------------------------------------------------- update */

// One click: fetch the newest installer from the release, check it really is
// one, run it silently over this copy, and step aside. The installer closes
// with the dock already reopened on the new version.
//
// Anything that goes wrong before the installer has started leaves this dock
// running exactly as it was, with one sentence saying what happened and the
// row still there to click again.

const UPDATE_STALL_MS = 60 * 1000;         // no bytes for a minute = give up

function updateFolders() {
  const tmp = app.getPath('temp');
  try {
    return fs.readdirSync(tmp)
      .filter((n) => n.startsWith('rayis-dock-update-'))
      .map((n) => path.join(tmp, n));
  } catch {
    return [];
  }
}

// The last update's installer is still sitting in the temp folder. Best effort:
// a file Windows still has open is left for the next launch.
function sweepOldUpdates() {
  for (const dir of updateFolders()) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* next time */ }
  }
}

function setUpdateStep(step) {
  if (state.updateStep === step) return;
  state.updateStep = step;
  pushState();
}

async function downloadInstaller(file) {
  const abort = new AbortController();
  let stall = null;
  const alive = () => {
    clearTimeout(stall);
    stall = setTimeout(() => abort.abort(), UPDATE_STALL_MS);
  };
  alive();
  try {
    const res = await fetch(UPDATE_URL, { redirect: 'follow', cache: 'no-store', signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    let got = 0;
    const count = new Transform({
      transform(chunk, _enc, done) {
        got += chunk.length;
        alive();
        setUpdateStep(total
          ? `Downloading… ${Math.min(100, Math.floor((got / total) * 100))}%`
          : `Downloading… ${Math.floor(got / 1048576)} MB`);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(file));
    if (total && got !== total) throw new Error('short download');
  } finally {
    clearTimeout(stall);
  }
}

// A Windows program starts with the two letters "MZ", and the dock's installer
// is tens of megabytes. An error page or a half-finished file is neither.
function looksLikeInstaller(file) {
  try {
    if (fs.statSync(file).size <= 1024 * 1024) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      return head[0] === 0x4d && head[1] === 0x5a;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

async function installUpdate() {
  if (state.updating || !state.updateVersion) return false;   // a second click does nothing
  state.updating = true;
  state.updateError = null;
  state.updateStep = 'Downloading…';
  pushState();

  let dir = null;
  const fail = (sentence) => {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swept later */ } }
    state.updating = false;
    state.updateStep = null;
    state.updateError = sentence;
    pushState();
    return false;
  };

  let file;
  try {
    dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'rayis-dock-update-'));
    file = path.join(dir, 'RAYIS-Dock-Setup.exe');
    await downloadInstaller(file);
  } catch {
    return fail('The update didn’t download. Check the internet, then click to try again.');
  }

  setUpdateStep('Checking the download…');
  if (!looksLikeInstaller(file)) {
    return fail('The download wasn’t the installer. Click to try again.');
  }

  // Only Windows can run the installer. Anywhere else this is as far as it
  // goes — enough to look at the download and the check on a Mac.
  if (process.platform !== 'win32') {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swept later */ }
    state.updating = false;
    state.updateStep = 'Downloaded. It only installs itself on Windows.';
    pushState();
    return true;
  }

  // The arguments electron-updater hands an electron-builder one-click NSIS
  // installer: --updated (this is an update — close the running app and carry
  // on), /S (no windows), --force-run (open the dock again when it's done).
  setUpdateStep('Installing… the dock will reopen by itself.');
  try {
    const child = spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' });
    // Wait until Windows has actually started it. If it refuses — antivirus,
    // a locked-down profile — the dock must still be here to say so.
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    return fail('Windows wouldn’t start the installer. Click to try again, or ask Ray.');
  }
  app.isQuitting = true;
  app.quit();
  return true;
}

/* ------------------------------------------------------------------ inquiries */

// Kaye's tab — the same one the Mac dock has (RayisDock.swift, Inquiries).
// Ray, Oct 6 2026: "create a Dock tab … for Kaye to see also, which updates
// everytime a new contact form is submitted, it shows up on her side of the
// dock" — each couple "Kaye Reply needed" or "Kaye Replied to Inquiry".
//
// GET /hq/leads/api/inquiries: the contact-form couples of the last two weeks.
// The form writes each lead the moment it's sent, so a minute's poll is "every
// time a form comes in"; a new one brings the window back up even after the ✕.
// Click = their reply desk on The flow. Right-click = mark replied (eight
// seconds to take it back), their Gmail thread, their lead page. A login
// without Leads gets a 403 and the window simply never shows.

const INQ_INTERVAL = 60 * 1000;
const INQ_UNDO_MS = 8 * 1000;
const INQ_WIDTH = 364;                     // the 340 card + room for its shadow

const inq = {
  allowed: true,       // false once the website says this login can't see leads
  open: false,
  loaded: false,
  rows: [],
  trouble: null,
  note: null,
  fresh: [],           // came in since the window was last opened — they wear "New"
  pending: null,       // marked replied, not yet told to the site
  sending: [],         // told to the site, waiting for the list to come back
};
let inqWin = null;
let inqTimer = null;
let inqCommit = null;
let inqNoteTimer = null;
let inqBusy = false;
let inqSeen = new Set();                   // every inquiry already seen, so only a new one pops it up
let inqSeenReady = false;

const neededCount = () => inq.rows
  .filter((r) => r.replyNeeded && inq.pending?.id !== r.id && !inq.sending.includes(r.id)).length;

function pushInquiries() {
  tell(inqWin, 'inq', { ...inq, pending: inq.pending ? inq.pending.id : null, needed: neededCount() });
  const was = JSON.stringify(state.inquiries);
  state.inquiries = { allowed: state.signedIn && inq.allowed, needed: neededCount() };
  if (JSON.stringify(state.inquiries) !== was) pushState();
}

function saveInquiries() {
  writeConfig({
    inquiriesOpen: inq.open,
    inquiriesSeen: Array.from(inqSeen).slice(-400),
    inquiriesRows: inq.rows,
  });
}

function sayInquiries(text, ms = 5000) {
  inq.note = text;
  clearTimeout(inqNoteTimer);
  inqNoteTimer = setTimeout(() => { inq.note = null; pushInquiries(); }, ms);
  pushInquiries();
}

function leadsFetch(p, { method = 'GET', body } = {}) {
  const headers = cookieHeader();
  if (!headers) return null;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(`${SITE}/hq/leads/api/${p}`, {
    method, headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined,
  });
}

async function refreshInquiries() {
  if (!state.signedIn || !inq.allowed || inqBusy) return;
  const req = leadsFetch('inquiries');
  if (!req) return;
  inqBusy = true;
  try {
    const res = await req;
    if (res.status === 403) {
      // This login has no Leads access: nothing to show, ever.
      inq.allowed = false;
      hideInquiries();
      pushInquiries();
      return;
    }
    const json = (res.headers.get('content-type') || '').includes('json');
    const data = json ? await res.json().catch(() => null) : null;
    if (!res.ok || !data || !data.ok || !Array.isArray(data.inquiries)) {
      inq.trouble = res.status === 401 || !json
        ? 'The sign-in on this PC stopped working — sign in again and this fills back in.'
        : 'Couldn’t reach the leads — this is the last list.';
      pushInquiries();
      if (inq.open) showInquiries();
      return;
    }
    const list = data.inquiries;
    inq.trouble = null;
    inq.loaded = true;
    inq.sending = inq.sending.filter((id) => list.find((r) => r.id === id)?.replyNeeded);
    // A form that came in since the last look: up comes the window, even
    // after the ✕ — that's the whole point of it.
    const arrived = list.filter((r) => r.replyNeeded && !inqSeen.has(r.id));
    if (inqSeenReady && arrived.length) {
      inq.fresh = Array.from(new Set([...inq.fresh, ...arrived.map((r) => r.id)]));
      inq.open = true;
      sayInquiries(arrived.length === 1 ? `New inquiry — ${arrived[0].name}` : `${arrived.length} new inquiries`, 10000);
    }
    list.forEach((r) => inqSeen.add(r.id));
    inqSeenReady = true;
    inq.rows = list;
    saveInquiries();
    pushInquiries();
    if (inq.open) showInquiries();
  } catch {
    inq.trouble = 'Couldn’t reach the leads — this is the last list.';
    pushInquiries();
  } finally {
    inqBusy = false;
  }
}

function startInquiries() {
  const cfg = readConfig();
  // The first launch that has it shows it once, so it's found.
  inq.open = cfg.inquiriesOpen !== undefined ? Boolean(cfg.inquiriesOpen) : true;
  inqSeenReady = Array.isArray(cfg.inquiriesSeen);
  inqSeen = new Set(cfg.inquiriesSeen || []);
  if (Array.isArray(cfg.inquiriesRows)) { inq.rows = cfg.inquiriesRows; inq.loaded = true; }
  refreshInquiries();
  inqTimer = setInterval(refreshInquiries, INQ_INTERVAL);
}

// The palette's "Inquiries" ↵ or the tray — up it comes, until the ✕.
function openInquiries() {
  if (!state.signedIn || !inq.allowed) return;
  inq.open = true;
  inq.fresh = [];
  saveInquiries();
  pushInquiries();
  showInquiries({ here: true });
  refreshInquiries();
}

function closeInquiries() {
  commitInquiry();
  inq.open = false;
  inq.fresh = [];
  saveInquiries();
  hideInquiries();
  pushInquiries();
}

// Signed out, or a different person signed in: nothing of the last login's stays.
function resetInquiries() {
  clearTimeout(inqCommit);
  Object.assign(inq, { allowed: true, loaded: false, rows: [], trouble: null, note: null, fresh: [], pending: null, sending: [] });
  inqSeen = new Set();
  inqSeenReady = false;
  writeConfig({ inquiriesRows: [], inquiriesSeen: undefined });
  hideInquiries();
  pushInquiries();
}

function createInquiriesWindow() {
  inqWin = new BrowserWindow({
    width: INQ_WIDTH, height: 160, show: false, frame: false, transparent: true,
    resizable: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
    minimizable: false, maximizable: false, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  inqWin.setAlwaysOnTop(true, 'floating');
  inqWin.setVisibleOnAllWorkspaces(true);
  inqWin.loadFile(path.join(__dirname, 'renderer', 'inquiries.html'));
  inqWin.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    closeInquiries();
  });
  inqWin.webContents.on('did-finish-load', pushInquiries);
}

// Bottom-right of its screen, out of the way of whatever she's working on.
// Opened from the palette, it goes to the screen she's on and stays there.
function placeInquiries(height) {
  if (!inqWin || inqWin.isDestroyed()) return;
  const want = readConfig().inquiriesDisplay;
  const display = screen.getAllDisplays().find((d) => d.id === want) || screen.getPrimaryDisplay();
  const { workArea } = display;
  const h = Math.max(100, Math.min(Math.round(height || inqWin.getSize()[1]), workArea.height - 24));
  inqWin.setBounds({
    x: Math.round(workArea.x + workArea.width - INQ_WIDTH - 4),
    y: Math.round(workArea.y + workArea.height - h - 4),
    width: INQ_WIDTH,
    height: h,
  });
}

function showInquiries({ here = false } = {}) {
  if (!state.signedIn || !inq.allowed) return;
  if (!inqWin || inqWin.isDestroyed()) createInquiriesWindow();
  if (here) {
    writeConfig({ inquiriesDisplay: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id });
  }
  placeInquiries();
  // Never takes the keyboard from what she's typing in.
  if (!inqWin.isVisible()) inqWin.showInactive();
}

function hideInquiries() {
  if (inqWin && !inqWin.isDestroyed()) inqWin.hide();
}

const findInquiry = (id) => inq.rows.find((r) => r.id === id);

function openInquiryReply(id) {
  const r = findInquiry(id);
  if (!r) return;
  inq.fresh = inq.fresh.filter((x) => x !== id);
  pushInquiries();
  shell.openExternal(SITE + r.flowUrl);
}

function gmailSearchURL(email) {
  return 'https://mail.google.com/mail/u/?authuser=hello@rayisweddings.com#search/'
    + encodeURIComponent(`from:${email} OR to:${email}`);
}

// Straight to the couple's thread in hello@ — the site finds it; a Gmail
// search for them if it can't.
async function openInquiryThread(id) {
  const r = findInquiry(id);
  if (!r) return;
  sayInquiries('Opening their Gmail thread…', 4000);
  try {
    const res = await leadsFetch(`gmail-thread?id=${encodeURIComponent(r.id)}`);
    const data = res && res.ok ? await res.json().catch(() => null) : null;
    if (data && data.ok && data.url) { shell.openExternal(data.url); return; }
  } catch { /* fall through to the search */ }
  if (r.email) shell.openExternal(gmailSearchURL(r.email));
  else sayInquiries(`No email on file for ${r.name}.`);
}

// "Kaye replied." Eight seconds to take it back, then it's logged.
function markInquiry(id) {
  const r = findInquiry(id);
  if (!r) return;
  commitInquiry();
  inq.pending = r;
  inqCommit = setTimeout(commitInquiry, INQ_UNDO_MS);
  pushInquiries();
}

function undoInquiry() {
  clearTimeout(inqCommit);
  inq.pending = null;
  pushInquiries();
}

async function commitInquiry() {
  clearTimeout(inqCommit);
  const r = inq.pending;
  if (!r) return;
  inq.pending = null;
  inq.sending.push(r.id);
  pushInquiries();
  let ok = false;
  try {
    const res = await leadsFetch('flow-sent', {
      method: 'POST', body: { id: r.id, step: 'inquiry', phase: '', from: 'mark' },
    });
    ok = Boolean(res && res.ok);
  } catch { ok = false; }
  if (ok) {
    sayInquiries(`${r.name} — marked replied.`);
  } else {
    inq.sending = inq.sending.filter((x) => x !== r.id);
    sayInquiries(`Couldn’t mark ${r.name} — try again.`);
  }
  refreshInquiries();
}

function inquiryMenu(id) {
  const r = findInquiry(id);
  if (!r || !inqWin) return;
  const items = [{ label: 'Write the reply (Ray’s tips + templates)', click: () => openInquiryReply(id) }];
  if (r.replyNeeded) {
    items.push(inq.pending?.id === id
      ? { label: 'Undo — not replied yet', click: undoInquiry }
      : { label: 'Replied from Gmail — mark it', click: () => markInquiry(id) });
  }
  items.push({ type: 'separator' });
  if (r.email) items.push({ label: 'Open their Gmail thread', click: () => openInquiryThread(id) });
  items.push({ label: 'Open their lead page', click: () => shell.openExternal(SITE + r.leadUrl) });
  items.push({ label: 'Open The flow', click: () => shell.openExternal(`${SITE}/hq/leads#flow`) });
  Menu.buildFromTemplate(items).popup({ window: inqWin });
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
  // Closing only hides it — except when the whole app is quitting (Quit in the
  // tray, or an update stepping aside for the installer), where a refused
  // close would call the quit off.
  palette.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    palette.hide();
  });
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
  if (state.inquiries.allowed) {
    const n = state.inquiries.needed;
    items.push({ label: n ? `Inquiries — ${n} reply needed` : 'Inquiries', click: openInquiries });
  }
  if (state.updateVersion) {
    items.push({ type: 'separator' });
    if (state.updating) {
      items.push({ label: `Updating the dock — ${state.updateStep || 'starting…'}`, enabled: false });
    } else {
      // The menu closes on the click, so the palette opens to show the progress.
      items.push({
        label: state.updateError
          ? 'The update didn’t work — click to try again'
          : `Update available — version ${state.updateVersion}`,
        click: () => { installUpdate(); showPalette(); },
      });
    }
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
// Answers straight away; the progress arrives as state pushes.
ipcMain.handle('dock:installUpdate', () => { installUpdate(); return true; });
ipcMain.handle('dock:openInquiries', () => {
  if (palette) palette.hide();
  openInquiries();
  return true;
});
ipcMain.handle('inq:state', () => ({ ...inq, pending: inq.pending ? inq.pending.id : null, needed: neededCount() }));
ipcMain.handle('inq:reply', (_e, id) => { openInquiryReply(id); return true; });
ipcMain.handle('inq:menu', (_e, id) => { inquiryMenu(id); return true; });
ipcMain.handle('inq:undo', () => { undoInquiry(); return true; });
ipcMain.handle('inq:flow', () => { shell.openExternal(`${SITE}/hq/leads#flow`); return true; });
ipcMain.handle('inq:close', () => { closeInquiries(); return true; });
ipcMain.handle('inq:resize', (_e, h) => { placeInquiries(h); return true; });
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

    sweepOldUpdates();
    createPalette();
    registerHotkey(cfg.hotkey || DEFAULT_HOTKEY);
    buildTray();

    // The whole point of a dock is that it's already there.
    if (cfg.openAtLogin !== false) app.setLoginItemSettings({ openAtLogin: true });

    refreshCatalog();
    catalogTimer = setInterval(refreshCatalog, CATALOG_INTERVAL);
    powerMonitor.on('resume', () => { refreshCatalog(); refreshInquiries(); });   // a sleeping laptop misses ticks
    startInquiries();
    screen.on('display-removed', () => { if (inqWin && inqWin.isVisible()) placeInquiries(); });

    // Nobody signed in yet: show them the way in rather than a silent tray icon.
    if (!state.signedIn || process.env.RAYIS_DEBUG_SEARCH) setTimeout(showPalette, 900);
  });

  app.on('window-all-closed', (e) => e.preventDefault());  // it lives in the tray
  // Quitting inside the eight seconds still marks it (three seconds at most).
  let flushed = false;
  app.on('before-quit', (e) => {
    // However the quit started — the tray, an update, Windows shutting down —
    // the windows may close now. Without this a window's ✕ handler took the
    // quit for a person closing it, refused, and called the whole quit off.
    app.isQuitting = true;
    if (flushed || !inq.pending) return;
    e.preventDefault();
    flushed = true;
    Promise.race([commitInquiry(), new Promise((r) => setTimeout(r, 3000))])
      .finally(() => { app.isQuitting = true; app.quit(); });
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (catalogTimer) clearInterval(catalogTimer);
    if (inqTimer) clearInterval(inqTimer);
  });
}
