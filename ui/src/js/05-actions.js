'use strict';
/* 05-actions.js : Standard-mode in-app actions (Jarvis feel). The engine only plans; the phone executes.
   Safe steps run immediately, sensitive ones wait for a tap. Nothing here talks to a model. */
const Actions = (() => {
  const N = () => window.AdarshNative;
  const native = () => !!(N() && N().runActions);
  const LABEL = {
    'reminder.add': ['Reminder', 'bell'], 'alarm.add': ['Alarm', 'bell'], 'timer.start': ['Timer', 'target'],
    'note.add': ['Note', 'file'], 'note.clear': ['Notes', 'trash'], 'app.open': ['App', 'sliders'],
    'web.search': ['Search', 'search'], 'phone.status': ['Phone', 'server'], 'calendar.add': ['Calendar', 'cal'],
    'voice.open': ['Voice', 'voice'], 'message.draft': ['Message', 'send'], 'call.dial': ['Call', 'chat'],
    'panel.open': ['Settings', 'sliders'], 'dnd.set': ['DND', 'shield'], 'torch.set': ['Torch', 'bolt']
  };
  const RISK = { confirm: 'Poochh ke karunga', destructive: 'Pakka? Ye delete karega' };

  /* ---------- HUD: the little orb that shows while Jarvis is working ---------- */
  let hudEl = null, hudTimer = 0;
  function hud(text, busy) {
    if (S.settings.jarvis === false) return;
    if (!hudEl) {
      hudEl = h('div', { class: 'hud', role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'hud-orb' }, h('i'), h('i'), h('i')), h('span', { class: 'hud-t' }));
      document.body.append(hudEl);
    }
    hudEl.querySelector('.hud-t').textContent = text || 'Kaam kar raha hoon…';
    hudEl.classList.toggle('busy', !!busy);
    hudEl.classList.add('on');
    clearTimeout(hudTimer);
    if (!busy) hudTimer = setTimeout(() => hudEl.classList.remove('on'), 2600);
  }

  /* ---------- browser fallback (no native bridge): notes, timer, reminder, search ---------- */
  const LS = 'adarsh.notes.v1';
  const notes = () => { try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch (e) { return []; } };
  const saveNotes = (a) => { try { localStorage.setItem(LS, JSON.stringify(a)); } catch (e) {} };

  function webStep(step) {
    const a = step.args || {};
    switch (step.action) {
      case 'note.add': {
        const list = notes(); list.unshift({ id: uid('n'), text: a.text, ts: Date.now() }); saveNotes(list);
        return { ok: true, message: 'Note save ho gaya' };
      }
      case 'note.clear': saveNotes([]); return { ok: true, message: 'Saare notes hata diye' };
      case 'timer.start': case 'reminder.add': case 'alarm.add': {
        const at = a.at || (Date.now() + (a.seconds || 60) * 1000);
        const ms = Math.max(1000, at - Date.now());
        setTimeout(() => {
          try { if ('Notification' in window && Notification.permission === 'granted') new Notification(a.text || 'Reminder', { body: 'Adarsh reminder' }); } catch (e) {}
          toast((a.text || 'Reminder') + ' — time ho gaya');
        }, ms);
        return { ok: true, message: 'Set ho gaya (is tab mein)' };
      }
      case 'app.open': case 'web.search': {
        const url = step.action === 'web.search' ? 'https://www.google.com/search?q=' + encodeURIComponent(a.query) : 'https://' + (a.app || 'google') + '.com';
        try { window.open(url, '_blank', 'noopener'); } catch (e) {}
        return { ok: true, message: 'Khol diya' };
      }
      case 'voice.open': try { Voice.open(); } catch (e) {} return { ok: true, message: 'Voice mode' };
      case 'phone.status': return { ok: true, message: (navigator.onLine ? 'Online' : 'Offline') + ' · ' + (navigator.deviceMemory || '?') + ' GB RAM' };
      default: return { ok: false, message: 'Ye kaam sirf app mein chalta hai' };
    }
  }

  function runNative(steps, confirmed) {
    try {
      const out = JSON.parse(N().runActions(JSON.stringify({ steps, confirmed: !!confirmed })));
      return (out && out.results) || [];
    } catch (e) { return []; }
  }

  /* ---------- execution ---------- */
  async function execute(d, confirmed, redraw) {
    if (d.run && d.run.state === 'running') return;
    d.run = { state: 'running', results: {} };
    const steps = d.steps || [];
    const risky = steps.filter(s => s.risk !== 'safe');
    hud('Ji Sir, ' + (steps[0].pending || 'kaam kar raha hoon'), true);
    if (redraw) redraw();
    const results = native() ? runNative(steps, confirmed) : steps.map(webStep);
    const byId = {};
    results.forEach(r => { if (r && r.id) byId[r.id] = r; });
    steps.forEach((s, i) => {
      const r = byId[s.id] || results[i] || { ok: false, message: 'Koi jawab nahi mila' };
      d.run.results[s.id] = r;
      if (r.detail === 'voice' && s.action === 'voice.open') { try { Voice.open(); } catch (e) {} }
    });
    const done = steps.filter(s => (d.run.results[s.id] || {}).ok).length;
    const failed = steps.length - done;
    d.run.state = 'done';
    const msgs = steps.map(s => (d.run.results[s.id] || {}).message).filter(Boolean);
    d.text = 'Ji Sir, ' + (msgs.length ? msgs.join('. ') : 'kaam nahi ho paya') + (failed ? '' : '.');
    d.done = done; d.failed = failed;
    hud(failed ? 'Sir, ' + failed + ' kaam fail hua' : 'Ho gaya Sir', false);
    try { save(); } catch (e) {}
    if (redraw) redraw();
    if (S.settings.speak && TTS.ok() && !(window.Voice && Voice.isOpen)) TTS.speak(msgs.join('. ') || 'Kaam nahi ho paya');
    if (risky.length && !confirmed) return;   // handled by the confirm sheet
    return d.run;
  }

  function confirm(d, ctx) {
    const steps = d.steps.filter(s => s.risk !== 'safe');
    sheet({ title: 'Confirm karo, Sir', build(b, close) {
      b.append(h('p', { class: 'muted' }, 'Ye kaam aapke liye sensitive hain:'));
      steps.forEach(s => b.append(h('div', { class: 'kvr' }, h('b', {}, (LABEL[s.action] || ['Kaam'])[0]), h('span', {}, s.detail || s.pending))));
      b.append(h('div', { class: 'card-btns' },
        h('button', { class: 'btn ghost', style: 'flex:1', on: { click: () => { close(); d.run = { state: 'cancel', results: {} }; d.text = 'Ji Sir, cancel kar diya.'; save(); ctx.redraw(); } } }, 'Nahi'),
        h('button', { class: 'btn pri', style: 'flex:1', on: { click: () => { close(); execute(d, true, ctx.redraw); } } }, 'Haan, karo')));
    } });
  }

  function stepRow(d, s) {
    const r = (d.run && d.run.results && d.run.results[s.id]) || null;
    const state = r ? (r.ok ? 'ok' : 'fail') : (d.run && d.run.state === 'running' ? 'run' : 'wait');
    const ic = (LABEL[s.action] || ['Kaam', 'sparkle'])[1];
    return h('div', { class: 'act-step', 'data-state': state },
      h('span', { class: 'as-ic' }, icon(ic, 's')),
      h('span', { class: 'as-t' }, h('b', {}, (LABEL[s.action] || ['Kaam'])[0] + (s.detail ? ' · ' + s.detail : '')),
        h('small', {}, r ? r.message : (s.risk !== 'safe' ? RISK[s.risk] || 'Confirm chahiye' : s.pending))),
      h('span', { class: 'as-s' }, state === 'ok' ? icon('check', 's') : state === 'fail' ? icon('x', 's') : state === 'run' ? '…' : ''));
  }

  /* ---------- the card inside a chat message ---------- */
  function card(d, ctx) {
    const wrap = h('div', { class: 'card act' });
    wrap.append(h('div', { class: 'act-h' }, h('span', { class: 'act-badge' }, 'JARVIS'), h('b', {}, d.text || 'Kaam kar raha hoon')));
    wrap.append(h('div', { class: 'act-steps' }, (d.steps || []).map(s => stepRow(d, s))));
    const need = (d.steps || []).some(s => s.risk !== 'safe');
    const st = d.run && d.run.state;
    if (!st && need) {
      wrap.append(h('div', { class: 'card-btns' },
        h('button', { class: 'btn ghost', style: 'flex:1', on: { click: () => { d.run = { state: 'cancel', results: {} }; d.text = 'Ji Sir, cancel kar diya.'; save(); ctx.redraw(); } } }, 'Nahi'),
        h('button', { class: 'btn pri', style: 'flex:1', on: { click: () => confirm(d, ctx) } }, 'Haan, karo')));
    } else if (st === 'done' && d.failed) {
      wrap.append(h('p', { class: 'muted' }, d.failed + ' kaam fail hua. Dobara bolo, main try karunga.'));
    } else if (st === 'cancel') {
      wrap.append(h('p', { class: 'muted' }, 'Cancel kar diya.'));
    }
    if (!st) setTimeout(() => { if (!d.run) execute(d, !need, ctx.redraw); }, 60);
    return wrap;
  }

  /* ---------- notes (Settings > Notes) ---------- */
  function notesSheet() {
    const list = native() ? (() => { try { return JSON.parse(N().listNotes()).notes || []; } catch (e) { return []; } })() : notes();
    sheet({ title: 'Notes', tall: true, build(b, close) {
      if (!list.length) { b.append(h('p', { class: 'muted' }, 'Koi note nahi. Bolo: "note banao ki kal exam hai".')); return; }
      list.forEach(n => b.append(h('div', { class: 'kvr' },
        h('span', {}, n.text || ''),
        h('button', { class: 'link', on: { click: () => {
          if (native()) { try { N().deleteNote(n.id); } catch (e) {} }
          else { saveNotes(notes().filter(x => x.id !== n.id)); }
          close(); notesSheet(); toast('Note hata diya');
        } } }, 'Delete'))));
    } });
  }

  function info() {
    if (!native()) return null;
    try { return JSON.parse(N().actionInfo()); } catch (e) { return null; }
  }

  /* permission status, so nothing fails silently later */
  function infoSheet() {
    const i = info();
    sheet({ title: 'Reminders and alarms', build(b, close) {
      if (!i) { b.append(h('p', { class: 'muted' }, 'Ye feature app ke andar chalta hai. Browser mein reminders sirf is tab ke liye set hote hain.')); return; }
      const row = (ok, t, sub) => h('div', { class: 'kvr' }, h('b', {}, t), h('span', { class: 'muted' }, (ok ? 'On · ' : 'Off · ') + sub));
      b.append(row(i.notify, 'Notifications', 'reminder ka alert dikhne ke liye zaroori'),
        row(i.exact, 'Exact alarms', i.exact ? 'theek time par bajega' : 'Android ne exact alarm band kiya hai — thoda late ho sakta hai'),
        row(i.dnd, 'DND access', 'sirf "DND on/off" command ke liye'));
      if (!i.notify) b.append(h('button', { class: 'btn pri', on: { click: () => { try { N().setNotify(true); } catch (e) {} close(); toast('Allow karo, phir reminder bajega'); } } }, 'Allow notifications'));
      b.append(h('p', { class: 'muted' }, 'Wi-Fi/Bluetooth ko app khud band nahi kar sakti (Android rule) — wo sirf settings panel kholti hai.'));
    } });
  }

  return { card, execute, notesSheet, info, infoSheet, hud, webStep, notes };
})();

RENDER.actions = (d, ctx) => Actions.card(d, ctx);
