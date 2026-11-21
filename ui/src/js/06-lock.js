'use strict';
/* 06-lock.js : local PIN lock. A convenience screen lock for this device only.
   The real protection is the backend token + allow-list; a PIN stored in the browser cannot protect against someone with devtools. */

const Lock = (() => {
  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const unhex = (s) => new Uint8Array(s.match(/../g).map(x => parseInt(x, 16)));
  async function derive(pin, saltHex, alg) {
    if (alg !== 'weak' && window.crypto && crypto.subtle) {
      const k = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
      return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(saltHex), iterations: 150000, hash: 'SHA-256' }, k, 256));
    }
    let x = 5381; const s = saltHex + pin; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0; return x.toString(16);
  }
  async function make(pin) {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16))); const alg = window.crypto && crypto.subtle ? 'pbkdf2' : 'weak';
    return { salt, alg, hash: await derive(pin, salt, alg), len: pin.length };
  }
  const verify = async (pin) => S.lock && (await derive(pin, S.lock.salt, S.lock.alg)) === S.lock.hash;

  let activePad = null, fails = 0, until = 0, hiddenAt = 0;
  document.addEventListener('keydown', (e) => {
    if (!activePad) return;
    if (/^\d$/.test(e.key)) activePad.press(e.key); else if (e.key === 'Backspace') activePad.press('b');
  });

  function pinPad(len, onDone) {
    let v = '', busy = false;
    const dots = h('div', { class: 'pin-dots', role: 'img', 'aria-label': len + ' digit PIN' }, Array.from({ length: len }, () => h('i')));
    const draw = () => $$('i', dots).forEach((d, i) => d.classList.toggle('on', i < v.length));
    const press = async (k) => {
      if (busy) return;
      if (k === 'b') v = v.slice(0, -1); else if (v.length < len) v += k; else return;
      vibe(); draw();
      if (v.length === len) { busy = true; const pin = v; try { await onDone(pin, pad); } finally { busy = false; v = ''; draw(); } }
    };
    const key = (k, label) => h('button', { class: 'key', 'aria-label': k === 'b' ? 'Delete' : k, on: { click: () => press(k) } }, label || k);
    const el = h('div', { class: 'pinhost' }, dots, h('div', { class: 'keypad' }, '123456789'.split('').map(k => key(k)), h('span', { class: 'key blank' }), key('0'), key('b', icon('back'))));
    const pad = { el, press, shake() { dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake'); } };
    return pad;
  }

  /* ----- full-screen lock ----- */
  function lockNow() {
    if (!S.lock) return; Voice.close(); const root = $('#lock'); root.textContent = ''; root.hidden = false;
    const msg = h('p', { class: 'lk-msg', role: 'status' }, 'Enter your PIN');
    const pad = pinPad(S.lock.len || 4, async (pin, p) => {
      if (Date.now() < until) { p.shake(); msg.textContent = 'Too many tries. Wait ' + Math.ceil((until - Date.now()) / 1000) + 's.'; return; }
      if (await verify(pin)) { fails = 0; activePad = null; root.hidden = true; root.textContent = ''; return; }
      fails++; p.shake(); vibe(30);
      if (fails >= 5) { until = Date.now() + 30000; fails = 0; msg.textContent = 'Too many tries. Locked for 30 s.'; } else msg.textContent = 'Wrong PIN. ' + (5 - fails) + ' tries left.';
    });
    activePad = pad;
    root.append(h('div', { class: 'mark' }, 'A'), h('h2', {}, 'ADARSH'), msg, pad.el,
      h('button', { class: 'link', on: { click: forgot } }, 'Forgot PIN?'));
  }
  function forgot() {
    confirmSheet({ title: 'Reset this device?', top: true, text: 'The PIN can’t be recovered. Resetting removes the PIN and ALL chats, memory and tasks stored on this device. Your backend data is not touched.', label: 'Erase and reset', danger: true,
      onYes: () => { Object.assign(S, DEFAULTS()); saveNow(); activePad = null; const r = $('#lock'); r.hidden = true; r.textContent = ''; App.applyTheme(); App.buildDrawer(); App.drawerList(); Chat.renderThread(); toast('Device reset'); } });
  }

  /* ----- setup / change / remove (inside sheets) ----- */
  function pinSheet(title, prompt, check) {
    return new Promise((resolve) => {
      let done = false;
      const close = sheet({ title, build(b, closeFn) {
        const msg = h('p', { class: 'center', role: 'status' }, prompt);
        const pad = pinPad(4, async (pin, p) => {
          const r = await check(pin);
          if (r === false) { p.shake(); msg.textContent = 'Not right, try again.'; return; }
          done = true; activePad = null; closeFn(); resolve(pin);
        });
        activePad = pad; b.append(msg, h('div', { style: 'display:flex;justify-content:center;padding:6px 0 10px' }, pad.el));
      } });
      const mo = new MutationObserver(() => { if (!document.querySelector('.shade [role=dialog][aria-label="' + title + '"]')) { mo.disconnect(); activePad = null; if (!done) resolve(null); } });
      mo.observe($('#phone'), { childList: true });
    });
  }
  async function setup(after) {
    const first = await pinSheet('Set a PIN', 'Choose a 4-digit PIN', () => true); if (!first) return;
    const again = await pinSheet('Confirm PIN', 'Enter it once more', (p) => p === first ? true : false); if (!again) return;
    S.lock = await make(first); save(); toast('PIN lock is on'); if (after) after();
  }
  async function manage(after) {
    if (!S.lock) return setup(after);
    sheet({ title: 'App lock', build(b, close) {
      const row = (ic, t, s, fn) => h('button', { class: 'opt-row', on: { click: () => { close(); fn(); } } }, icon(ic), h('span', { class: 't' }, h('b', {}, t), h('small', {}, s)));
      b.append(row('lock', 'Change PIN', 'Enter current PIN first', async () => { const ok = await pinSheet('Current PIN', 'Enter your current PIN', verify); if (ok) { const old = S.lock; S.lock = null; await setup(after); if (!S.lock) S.lock = old; } }),
        row('x', 'Remove PIN', 'Turn the lock off', async () => { const ok = await pinSheet('Current PIN', 'Enter your current PIN', verify); if (ok) { S.lock = null; save(); toast('PIN lock is off'); if (after) after(); } }),
        h('p', {}, 'This lock only hides the app on this device. Real protection is your backend token and allow-list.'));
    } });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (S.lock && S.settings.lockOnHide && hiddenAt && Date.now() - hiddenAt > (S.settings.lockAfter || 30) * 1000) lockNow();
  });
  return { lockNow, manage, setup };
})();
