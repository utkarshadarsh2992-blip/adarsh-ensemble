'use strict';
/* 01-core.js : helpers, icons, state store, event bus, toast, sheet, markdown-lite */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SVGNS = 'http://www.w3.org/2000/svg';

const IC = {
  menu: 'M4 7h16M4 12h16M4 17h16', plus: 'M12 5v14M5 12h14', x: 'M6 6l12 12M18 6L6 18',
  send: 'M12 19V5M6 11l6-6 6 6', mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4',
  voice: 'M5 10v4M9 7v10M13 4v16M17 8v8M21 11v2', check: 'M5 12.5l4.5 4.5L19 7.5', chev: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6', copy: 'M9 9h10v11H9zM5 15V4h10', refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  brain: 'M12 3a4 4 0 0 0-4 4 3 3 0 0 0-2 5 3 3 0 0 0 2 5 4 4 0 0 0 8 0 3 3 0 0 0 2-5 3 3 0 0 0-2-5 4 4 0 0 0-4-4zM12 3v18',
  flag: 'M5 21V4M5 4h12l-2 4 2 4H5', book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z', sliders: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M8 15v4',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13', chat: 'M5 5h14v10H9l-4 4z', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3', attach: 'M20 11l-8 8a5 5 0 0 1-7-7l8-8a3 3 0 0 1 4 4l-8 8a1 1 0 0 1-2-2l7-7',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4', image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01', star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4', shield: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z',
  ask: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 17v.2',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  speaker: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6', stop: 'M7 7h10v10H7z', dot: 'M12 12h.01',
  pin: 'M12 3l4 6-2 2 1 5-3-2-3 2 1-5-2-2zM12 16v5', edit: 'M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3',
  cal: 'M5 6h14v14H5zM5 10h14M9 4v4M15 4v4', globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  kbd: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8', warn: 'M12 4l9 16H3zM12 10v4M12 17v.1',
  up: 'M7 11l5-5 5 5M12 6v13', thumbup: 'M7 11v9H4v-9zM7 11l4-8c2 0 3 1 3 3l-.5 3H19a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 18 19H7',
  thumbdn: 'M7 13V4H4v9zM7 13l4 8c2 0 3-1 3-3l-.5-3H19a2 2 0 0 0 2-2.3l-1-6A2 2 0 0 0 18 5H7',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0', server: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14', upload: 'M12 16V5M7 9l5-5 5 5M5 20h14', target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  search2: 'M3 12h4l3-8 4 16 3-8h4'
};
function icon(n, cls = '') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i ' + cls); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', IC[n] || IC.dot); s.appendChild(p); return s;
}
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [e, f] of Object.entries(v)) el.addEventListener(e, f);
    else if (k === 'value' || k === 'disabled' || k === 'hidden' || k === 'checked') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}
const ibtn = (name, label, fn, cls = '') => h('button', { class: 'ib ' + cls, 'aria-label': label, on: { click: fn } }, icon(name));
const uid = (p = 'x') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function vibe(ms = 8) { try { if (S.settings.haptics && navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

/* ---------- event bus ---------- */
const Bus = (() => {
  const m = {};
  return {
    on(e, f) { (m[e] = m[e] || []).push(f); return () => { m[e] = (m[e] || []).filter(x => x !== f); }; },
    emit(e, d) { (m[e] || []).slice().forEach(f => { try { f(d); } catch (err) { console.error(e, err); } }); }
  };
})();

/* ---------- state ---------- */
const KEY = 'adarsh.ui.v3';
const DEFAULTS = () => ({
  chats: [], cur: null, memories: [], tasks: [], missions: [],
  settings: { theme: 'system', font: 'sans', name: 'Adarsh', speak: false, lang: 'hi-IN', rate: 1, haptics: true, notif: false, lockOnHide: true, lockAfter: 30 },
  lock: null, abilities: {}, conn: { url: '', token: '' }
});
const S = DEFAULTS();
function load() {
  try {
    const raw = localStorage.getItem(KEY); if (!raw) return;
    const d = JSON.parse(raw); const base = DEFAULTS();
    Object.assign(S, base, d, { settings: { ...base.settings, ...(d.settings || {}) }, conn: { ...base.conn, ...(d.conn || {}) } });
  } catch (e) { console.warn('load failed', e); }
}
let _st = 0;
function save() { clearTimeout(_st); _st = setTimeout(saveNow, 250); }
function saveNow() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S, (k, v) => (k === 'thumb' || k === 'dataUrl' ? undefined : v)));
  } catch (e) { console.warn('save failed', e); }
}
window.addEventListener('pagehide', saveNow);

/* ---------- toast / banner ---------- */
function toast(msg, o = {}) {
  const box = $('#toasts');
  const t = h('div', { class: 'toast', role: 'status' }, h('span', {}, msg));
  const kill = () => t.remove();
  if (o.action) t.appendChild(h('button', { class: 'tbtn', on: { click: () => { o.action(); kill(); } } }, o.label || 'Undo'));
  box.appendChild(t);
  setTimeout(kill, o.ms || 3600);
}
function banner({ title, text, label = 'Open', onOpen, ms = 9000 }) {
  const b = h('div', { class: 'banner', role: 'alert' }, icon('bell'),
    h('div', { class: 'bt' }, h('b', {}, title), text ? h('small', {}, text) : null),
    onOpen ? h('button', { class: 'sbtn', on: { click: () => { onOpen(); b.remove(); } } }, label) : null,
    h('button', { class: 'ib', style: 'width:36px;height:36px', 'aria-label': 'Dismiss', on: { click: () => b.remove() } }, icon('x', 's')));
  $('#banners').appendChild(b);
  if (ms) setTimeout(() => b.remove(), ms);
}

/* ---------- sheet ---------- */
function sheet({ title, tall = false, top = false, build }) {
  const shade = h('div', { class: 'shade' + (top ? ' top' : ''), on: { click: (e) => { if (e.target === shade) close(); } } });
  const body = h('div', { class: 'body pad' });
  const sh = h('div', { class: 'sheet' + (tall ? ' tall' : ''), role: 'dialog', 'aria-label': title },
    h('div', { class: 'grab' }),
    h('div', { class: 'sh-h pad' }, h('h3', {}, title), h('button', { class: 'ib', 'aria-label': 'Close', on: { click: () => close() } }, icon('x'))),
    body);
  shade.appendChild(sh);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); shade.remove(); }
  build(body, close);
  $('#phone').appendChild(shade);
  return close;
}
function confirmSheet({ title, text, label = 'Confirm', danger = false, top = false, onYes }) {
  sheet({
    title, top, build(b, close) {
      b.append(h('p', {}, text), h('div', { class: 'frow' },
        h('button', { class: 'btn ghost', style: 'flex:1', on: { click: close } }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'pri'), style: 'flex:1', on: { click: () => { close(); onYes(); } } }, label)));
    }
  });
}

/* ---------- markdown-lite (safe: builds nodes, never innerHTML) ---------- */
function inline(text) {
  const out = []; const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t[0] === '`') out.push(h('code', {}, t.slice(1, -1)));
    else if (t.startsWith('**')) out.push(h('strong', {}, t.slice(2, -2)));
    else if (t[0] === '*') out.push(h('em', {}, t.slice(1, -1)));
    else { const mm = /\[([^\]]+)\]\((.+)\)/.exec(t); out.push(h('a', { href: mm[2], target: '_blank', rel: 'noopener noreferrer', style: 'color:var(--sel)' }, mm[1])); }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function md(src) {
  const root = h('div', { class: 'prose' }); const lines = String(src || '').replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; root.appendChild(h('pre', {}, h('code', {}, buf.join('\n')))); continue;
    }
    if (/^#{1,4}\s/.test(ln)) { root.appendChild(h('h4', {}, inline(ln.replace(/^#+\s*/, '')))); i++; continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(ln)) {
      const ord = /^\s*\d+[.)]/.test(ln); const list = h(ord ? 'ol' : 'ul');
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) { list.appendChild(h('li', {}, inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, '')))); i++; }
      root.appendChild(list); continue;
    }
    if (!ln.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*•]|\d+[.)])\s+)/.test(lines[i])) buf.push(lines[i++]);
    const p = h('p'); buf.forEach((b, k) => { if (k) p.appendChild(document.createElement('br')); inline(b).forEach(n => p.append(n)); });
    root.appendChild(p);
  }
  return root;
}
const stripMd = (s) => String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();

/* ---------- time ---------- */
function fmtDue(ts) {
  if (!ts) return { t: '', c: '' };
  const d = new Date(ts), now = new Date(); const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 864e5);
  const tm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const lbl = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return { t: lbl + ', ' + tm, c: ts < Date.now() ? 'bad' : diff === 0 ? 'warn' : '' };
}
function greeting() { const hr = new Date().getHours(); return hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : hr < 21 ? 'Good evening' : 'Good night'; }
