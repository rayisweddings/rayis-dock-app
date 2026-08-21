'use strict';

// The palette's whole job: show what this person can reach, and open it.
// Every question about who-may-see-what is answered by the website — the app
// list arrives already filtered, and a search answers with the sections this
// login's grants open. Nothing here decides access; it only draws the answer.

const card = document.getElementById('card');

let state = { signedIn: false, who: {}, apps: [], favorites: [], hotkey: '\\', error: null };
let hits = { couples: [], leads: [], galleries: [], staff: [], planning: [], sections: [] };
let items = [];          // the flat, keyboard-ordered list on screen
let sel = 0;
let query = '';
let searching = false;
let seq = 0;
let busy = false;
let formError = null;

const MAG = '<svg viewBox="0 0 20 20" fill="none" stroke="#f7f5f2" stroke-width="1.7">'
  + '<circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.8 12.8 17 17" stroke-linecap="round"/></svg>';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* --------------------------------------------------------------- app search */

// Every typed word must appear somewhere in the app's name, path or keywords;
// a word that starts the name wins over one buried in the keywords, so typing
// "gal" lands on Gallery rather than on whatever mentions galleries.
function searchApps(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const rank = (a) => {
    const words = a.name.toLowerCase().split(/\s+/);
    if (terms.every((t) => words.some((w) => w.startsWith(t)))) return 0;
    if (terms.every((t) => a.name.toLowerCase().includes(t))) return 1;
    return 2;
  };
  return state.apps
    .filter((a) => {
      const hay = `${a.name} ${a.path} ${a.keywords || ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .sort((x, y) => (rank(x) - rank(y)) || x.name.localeCompare(y.name));
}

/* ------------------------------------------------------------- what to show */

function buildItems() {
  const out = [];
  const q = query.trim();

  if (!q) {
    const favs = state.favorites
      .map((p) => state.apps.find((a) => a.path === p))
      .filter(Boolean);
    const list = favs.length ? favs : state.apps.slice(0, 7);
    if (list.length) out.push({ head: 'FAVOURITES' });
    list.slice(0, 7).forEach((a) => out.push({ kind: 'app', app: a }));
    return out;
  }

  const apps = searchApps(q).slice(0, 6);
  if (apps.length) out.push({ head: 'APPS' });
  apps.forEach((a) => out.push({ kind: 'app', app: a }));

  const section = (key, label, rows) => {
    if (!rows || !rows.length) return;
    out.push({ head: label });
    rows.forEach((h) => out.push({ kind: key, hit: h }));
  };
  section('planning', 'PLANNING FORMS', hits.planning);
  section('couple', 'COUPLES', hits.couples);
  section('lead', 'LEADS', hits.leads);
  section('gallery', 'GALLERIES', hits.galleries);
  section('staff', 'CREW', hits.staff);
  return out;
}

const ICONS = { couple: '💍', lead: '⚡️', gallery: '📷', staff: '👤', planning: '📝' };

/* -------------------------------------------------------------------- draw */

function render() {
  if (!state.signedIn) { renderSignIn(); return; }

  items = buildItems();
  const rows = items.filter((i) => !i.head);
  if (sel >= rows.length) sel = Math.max(0, rows.length - 1);

  let n = -1;
  const body = items.map((i) => {
    if (i.head) return `<div class="head">${esc(i.head)}</div>`;
    n += 1;
    const on = n === sel ? ' on' : '';
    if (i.kind === 'app') {
      const a = i.app;
      const lvl = a.level === 'view' ? '<span class="lvl">view only</span>' : '';
      return `<div class="row${on}" data-i="${n}">`
        + `<div class="ico">${esc(a.emoji || '✦')}</div>`
        + `<div class="txt"><div class="name">${esc(a.name)}</div>`
        + `<div class="sub">rayisweddings.com${esc(a.path)}</div></div>`
        + `${lvl}<div class="go">↗</div></div>`;
    }
    const h = i.hit;
    const sub = [h.detail, h.sub].filter(Boolean).join('  ·  ');
    return `<div class="row${on}" data-i="${n}">`
      + `<div class="ico">${ICONS[i.kind] || '✦'}</div>`
      + `<div class="txt"><div class="name">${esc(h.label)}</div>`
      + `<div class="sub">${esc(sub)}</div></div><div class="go">↗</div></div>`;
  }).join('');

  const nothing = !rows.length && query.trim().length >= 2 && !searching;
  const hint = nothing ? 'nothing by that name  ·  esc closes'
    : (rows.length ? '↑↓ choose · ↵ open · esc close' : 'esc closes');

  card.innerHTML = `
    <div class="searchrow">
      <div class="mag">${MAG}</div>
      <input id="q" type="text" spellcheck="false" autocomplete="off"
             placeholder="search your apps, couples, galleries and crew"
             value="${esc(query)}" />
    </div>
    ${rows.length || nothing ? '<hr />' : ''}
    ${rows.length ? `<div class="list">${body}</div>`
      : (nothing ? '<div class="list"><div class="empty">Nothing by that name.</div></div>' : '')}
    <div class="foot">
      <div class="hint">${esc(hint)}</div>
      <div class="mark">${esc(state.hotkey)}&nbsp;&nbsp;SEARCH · RAYIS HQ</div>
    </div>`;

  const input = document.getElementById('q');
  input.addEventListener('input', onType);
  input.focus();
  input.setSelectionRange(query.length, query.length);

  card.querySelectorAll('.row').forEach((el) => {
    el.addEventListener('mouseenter', () => { sel = Number(el.dataset.i); paint(); });
    el.addEventListener('click', () => openAt(Number(el.dataset.i)));
  });
  fit();
}

// Moving the highlight shouldn't rebuild the list under the cursor.
function paint() {
  card.querySelectorAll('.row').forEach((el) => {
    el.classList.toggle('on', Number(el.dataset.i) === sel);
  });
  const on = card.querySelector('.row.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

function renderSignIn() {
  const err = formError || state.error;
  card.innerHTML = `
    <div class="signin">
      <div class="eyebrow">RAYIS HQ</div>
      <h1>Sign in to open the studio</h1>
      <p class="why">Your usual RAYIS HQ email and password. You’ll see the apps
        Ray has given you — and nothing else.</p>
      <div class="field"><span>✉</span>
        <input id="email" type="email" spellcheck="false" autocomplete="off"
               placeholder="email" value="${esc(state.who && state.who.email || '')}" /></div>
      <div class="field"><span>🔒</span>
        <input id="pw" type="password" placeholder="password" /></div>
      <div class="foot2">
        <div class="note${err ? ' bad' : ''}">${esc(err
          || 'Forgotten it? Ask Ray to reset your RAYIS HQ login.')}</div>
        <button class="go-btn" id="go"${busy ? ' disabled' : ''}>${busy ? 'Signing in…' : 'Sign in'}</button>
      </div>
    </div>`;
  fit();

  const email = document.getElementById('email');
  const pw = document.getElementById('pw');
  const go = document.getElementById('go');
  const submit = async () => {
    if (busy) return;
    busy = true; formError = null; renderSignIn();
    const res = await window.dock.signIn(
      document.getElementById('email') ? email.value : '',
      pw.value,
    );
    busy = false;
    if (!res.ok) { formError = res.error; renderSignIn(); }
    // A success arrives as a state push, which redraws into the search box.
  };
  const vals = { email: '', pw: '' };
  email.addEventListener('input', () => { vals.email = email.value; });
  pw.addEventListener('input', () => { vals.pw = pw.value; });
  email.addEventListener('keydown', (e) => { if (e.key === 'Enter') pw.focus(); });
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  go.addEventListener('click', submit);
  (state.who && state.who.email ? pw : email).focus();
}

// The window is exactly as tall as what's in it — no dead space under a short
// list, no scrollbar when there's room.
function fit() {
  requestAnimationFrame(() => window.dock.resize(card.offsetHeight + 28));
}

/* ------------------------------------------------------------------ typing */

let timer = null;
function onType(e) {
  query = e.target.value;
  sel = 0;
  clearTimeout(timer);
  const q = query.trim();
  if (q.length < 2) {
    hits = { couples: [], leads: [], galleries: [], staff: [], planning: [], sections: hits.sections };
    searching = false;
    render();
    return;
  }
  render();
  // Let the typing settle before asking the website — one request per pause,
  // not one per keystroke.
  timer = setTimeout(async () => {
    const mine = ++seq;
    searching = true;
    const res = await window.dock.search(q);
    if (mine !== seq) return;               // a later keystroke owns the list
    searching = false;
    hits = {
      couples: res.couples || [], leads: res.leads || [], galleries: res.galleries || [],
      staff: res.staff || [], planning: res.planning || [], sections: res.sections || [],
    };
    render();
  }, 220);
}

/* ------------------------------------------------------------------- keys */

function rowsOnly() { return items.filter((i) => !i.head); }

function openAt(i) {
  const row = rowsOnly()[i];
  if (!row) return;
  window.dock.open(row.kind === 'app' ? row.app.path : row.hit.path);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.signedIn && query) { query = ''; sel = 0; render(); }
    else window.dock.hide();
    e.preventDefault();
    return;
  }
  if (!state.signedIn) return;
  const n = rowsOnly().length;
  if (e.key === 'ArrowDown') { if (n) { sel = Math.min(sel + 1, n - 1); paint(); } e.preventDefault(); }
  else if (e.key === 'ArrowUp') { if (sel > 0) { sel -= 1; paint(); } e.preventDefault(); }
  else if (e.key === 'Enter') { openAt(sel); e.preventDefault(); }
});

window.dock.onState((s) => {
  const wasOut = !state.signedIn;
  state = s;
  if (wasOut && s.signedIn) { query = ''; sel = 0; formError = null; }
  render();
});

window.dock.onOpened(() => {
  query = ''; sel = 0; formError = null;
  hits = { couples: [], leads: [], galleries: [], staff: [], planning: [], sections: [] };
  render();
});

window.dock.getState().then((s) => { state = s; render(); });
