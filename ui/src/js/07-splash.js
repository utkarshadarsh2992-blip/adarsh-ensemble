'use strict';
/* 07-splash.js : the startup animation (dark "tech HUD") over the app while it boots.
   The #boot layer is static markup in index.html (styles in css/boot.css), so it is the first paint and the chat
   never flashes before it. This module runs the timed part: the name decodes letter by letter, a short boot log
   that reflects the real settings (mode, Wikipedia / web search, key storage), a progress bar and a clock, then the
   HUD zooms into the app. About 2.5 s in total; a tap skips it.
   S.settings.bootAnim=false (AI command) turns it off (the layer is then removed before it is seen).
   prefers-reduced-motion gets a short fade only. If anything here fails, the layer is removed at once, and CSS
   hides it after a few seconds even if this script never runs. On Android the system bars go dark with it
   (AdarshNative.bootBars); MainActivity also turns them back on its own after 9 s or a load error. */
const Splash = (() => {
  const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&*+<>/=';
  const NAME = 'ADARSH';
  // ms after the HUD starts: name letters lock, log lines appear, progress fills, ready, hand-over
  const T = { nameLock: 330, letterGap: 85, firstLine: 420, lineGap: 210, status: 150, ready: 1700, out: 2000, fade: 460, skipFade: 240 };
  const A_HEIGHT = 138.7;   // px height of the "A" in the 288 px logo box (52 of 108 viewport units)
  let el = null, tpl = null, t0 = 0, done = true, readyShown = false, timers = [], lastScramble = 0;
  let nameSpans = [], lineEls = [], lines = [], fill = null, pct = null, state = null, clock = null;

  const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };
  /* Android: the status and navigation bars take the dark ground while the layer is up (a cold start begins dark) */
  function bars(dark) { try { if (window.AdarshNative && AdarshNative.bootBars) AdarshNative.bootBars(!!dark); } catch (e) {} }
  /* requestAnimationFrame, but never re-entrant (a synchronous rAF, e.g. in tests, falls back to a timer) */
  function frame(fn) {
    let sync = true;
    requestAnimationFrame(ts => { if (sync) setTimeout(() => fn(performance.now()), 16); else fn(ts); });
    sync = false;
  }
  function bootLines() {
    const mode = String(S.settings.mode || 'standard').toUpperCase();
    const web = S.settings.webSearch !== false;
    const native = !!window.AdarshNative;
    return [
      ['INIT', 'adarsh core', 'OK', ''],
      ['LOAD', 'chats · memory · notes', 'OK', ''],
      ['MODE', mode, 'SET', ''],
      ['NET', web ? 'wikipedia + web search' : 'wikipedia research', 'ON', ''],
      ['SEC', native ? 'keystore · encrypted keys' : 'local storage', native ? 'SECURE' : 'LOCAL', 'boot-hot'],
    ];
  }
  function scramble() { return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]; }
  function hhmmss() { const d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); }

  function tick(now) {
    if (done || !el) return;
    const t = now - t0;
    // name: random glyphs that lock into A-D-A-R-S-H from left to right
    const reshuffle = now - lastScramble > 45;
    if (reshuffle) lastScramble = now;
    nameSpans.forEach((sp, i) => {
      if (t >= T.nameLock + i * T.letterGap) { if (sp.textContent !== NAME[i]) sp.textContent = NAME[i]; }
      else if (reshuffle) sp.textContent = scramble();
    });
    // boot log: each line types in, then shows its status
    lines.forEach((ln, k) => {
      const at = T.firstLine + k * T.lineGap;
      if (t < at) return;
      if (!lineEls[k]) {
        const v = h('span', { class: 'v' }), b = h('b', { class: ln[3] });
        lineEls[k] = { v, b, row: h('div', { class: 'boot-ln' }, h('span', { class: 'k' }, ln[0]), v, b) };
        $('#boot-log', el).append(lineEls[k].row);
      }
      const r = lineEls[k], typed = Math.min(ln[1].length, Math.ceil((t - at) / 9));
      if (r.v.textContent.length !== typed) r.v.textContent = ln[1].slice(0, typed);
      if (t >= at + T.status && !r.b.textContent) r.b.textContent = ln[2];
    });
    const p = Math.min(1, t / T.ready), eased = 1 - Math.pow(1 - p, 2.2);
    fill.style.transform = 'scaleX(' + eased.toFixed(3) + ')';
    pct.textContent = Math.round(eased * 100) + '%';
    if (t > T.firstLine && !readyShown) state.textContent = 'LINKING';
    const c = hhmmss(); if (clock.textContent !== c) clock.textContent = c;
    if (t >= T.ready && !readyShown) {
      readyShown = true;
      el.classList.add('ready');
      state.textContent = 'SYSTEM READY';
      vibe(14);   // Settings > Haptics decides
    }
    if (t >= T.out) return out(false);
    frame(tick);
  }

  function begin() {
    if (!el) return;
    const ring = $('.boot-ring', el), hud = ring ? ring.offsetWidth : 0;
    el.style.setProperty('--ls', hud ? (hud * 0.34 / A_HEIGHT).toFixed(3) : '0.62');
    nameSpans = [...NAME].map(() => h('span', {}, scramble()));
    const nm = $('#boot-name', el); nm.textContent = ''; nm.append(...nameSpans);
    lines = bootLines(); lineEls = [];
    fill = $('#boot-fill', el); pct = $('#boot-pct', el); state = $('#boot-state', el); clock = $('#boot-clock', el);
    clock.textContent = hhmmss();
    el.classList.add('go');
    t0 = performance.now(); lastScramble = 0;
    frame(tick);
    later(() => out(false), T.out + 900);   // a WebView that pauses rAF can not keep the layer up
  }

  function out(skipped) {
    if (done || !el) return;
    done = true;
    el.classList.add('out');
    if (skipped) el.classList.add('skip');
    later(() => bars(false), skipped ? 60 : 180);   // mid-fade, as the app shows through
    const node = el;
    later(() => remove(node), skipped ? T.skipFade : T.fade);
  }
  function skip(e) { if (e) { e.preventDefault(); e.stopPropagation(); } out(true); }
  function remove(node) {
    const n = node || el;
    if (n && n === el) { timers.forEach(clearTimeout); timers = []; el = null; done = true; bars(false); }
    if (n && n.parentNode) n.remove();
  }

  /* app start: called by 08-boot.js right after the saved settings are loaded */
  function start(opts = {}) {
    el = document.getElementById('boot');
    if (!el) return false;
    if (!tpl) tpl = el.cloneNode(true);
    try {
      if (!opts.force && (S.settings.bootAnim === false || document.hidden)) { remove(); return false; }
      done = false; readyShown = false;
      bars(true);
      el.addEventListener('pointerdown', skip);
      el.addEventListener('click', skip);
      const calm = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
      if (calm) { el.classList.add('calm'); later(() => out(false), 450); return true; }
      // two frames: the dark first paint is on screen before the HUD (and the "A") starts
      frame(() => frame(begin));
      return true;
    } catch (e) { remove(); return false; }
  }
  /* Settings preview: play it again now */
  function replay() {
    if (el || !tpl) return false;
    const node = tpl.cloneNode(true);
    document.body.append(node);
    void node.offsetWidth;   // apply the static state first so the HUD animates from it
    return start({ force: true });
  }
  return { start, replay, skip: () => out(true), active: () => !!el && !done };
})();
