'use strict';

// The Inquiries window only draws. The list, the marking and the undo all
// live in the main process; a click here just says which couple.

const card = document.getElementById('card');
const MAX_ROWS = 8;

let s = { rows: [], loaded: false, trouble: null, note: null, fresh: [], pending: null, sending: [], needed: 0 };

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function row(r) {
  const checked = s.pending === r.id || s.sending.includes(r.id);
  const needed = r.replyNeeded && !checked;
  const venue = String(r.venue || '').split(' — ')[0];
  const facts = [r.weddingDate, venue].filter(Boolean).join(' · ');
  const isNew = s.fresh.includes(r.id) ? '<span class="new">New</span>' : '';
  const status = checked
    ? `<div class="marked">${s.pending === r.id ? 'Marked replied' : 'Marking…'}${
      s.pending === r.id ? '<button class="undo" data-undo="1">Undo</button>' : ''}</div>`
    : `<div class="label">${esc(r.label)}</div>`;
  return `<div class="row${needed ? ' needed' : ''}" data-id="${esc(r.id)}"
              title="Click to write the reply · right-click to mark it replied">
      <div class="who"><span class="name">${esc(r.name)}</span>${isNew}</div>
      ${facts ? `<div class="facts">${esc(facts)}</div>` : ''}
      ${status}
    </div>`;
}

function render() {
  const shown = s.rows.slice(0, MAX_ROWS);
  const more = s.rows.length - shown.length;
  card.innerHTML = `
    <div class="top">
      <h1>Inquiries</h1>
      ${s.needed ? `<span class="count">${s.needed} reply needed</span>` : ''}
      <button class="x" id="x" title="Close — it comes back by itself when a new inquiry arrives">✕</button>
    </div>
    ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
    ${s.trouble ? `<div class="trouble">${esc(s.trouble)}</div>` : ''}
    ${s.rows.length ? '' : `<div class="empty">${s.loaded
      ? 'No new inquiries in the last two weeks.' : 'Reading the inquiries…'}</div>`}
    ${shown.map(row).join('')}
    ${more > 0 ? `<button class="more" id="more">+ ${more} more on The flow</button>` : ''}`;

  document.getElementById('x').addEventListener('click', () => window.inq.close());
  const m = document.getElementById('more');
  if (m) m.addEventListener('click', () => window.inq.flow());
  card.querySelectorAll('.row').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.undo) { window.inq.undo(); return; }
      window.inq.reply(el.dataset.id);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.inq.menu(el.dataset.id);
    });
  });
  // The window is exactly as tall as the card, anchored to the bottom.
  requestAnimationFrame(() => window.inq.resize(card.offsetHeight + 24));
}

window.inq.onState((next) => { s = next; render(); });
window.inq.getState().then((next) => { s = next; render(); });
