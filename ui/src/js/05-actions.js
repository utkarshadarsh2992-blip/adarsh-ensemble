'use strict';
/* Local-rule action plans only. Safe completed steps are never replayed during confirmation. */
const Actions = (() => {
  const N = () => window.AdarshNative;
  const LABEL = { 'task.add': ['Task', 'tasks'], 'task.edit': ['Task edit', 'edit'], 'task.done': ['Task status', 'check'], 'task.list': ['Tasks', 'tasks'],
    'reminder.add': ['Reminder', 'bell'], 'reminder.edit': ['Reminder edit', 'edit'], 'reminder.list': ['Reminders', 'bell'],
    'alarm.add': ['Alarm', 'bell'], 'alarm.edit': ['Alarm edit', 'edit'], 'alarm.list': ['Alarms', 'bell'], 'timer.start': ['Timer', 'target'],
    'note.add': ['Note', 'file'], 'note.edit': ['Note edit', 'edit'], 'note.list': ['Notes', 'file'],
    'work.add': ['Work project', 'book'], 'work.edit': ['Work edit', 'edit'], 'work.log': ['Work log', 'book'], 'work.list': ['Work', 'book'],
    'memory.add': ['Memory', 'brain'], 'memory.edit': ['Memory edit', 'edit'], 'memory.list': ['Memory', 'brain'], 'settings.update': ['Setting', 'sliders'],
    'app.open': ['App', 'sliders'], 'web.search': ['Search', 'search'], 'phone.status': ['Phone', 'server'], 'calendar.add': ['Calendar', 'cal'],
    'voice.open': ['Voice', 'voice'], 'message.draft': ['Message', 'send'], 'call.dial': ['Call', 'chat'], 'torch.set': ['Torch', 'bolt'] };
  const contexts = new WeakMap();
  const ctx = d => contexts.get(d);
  let hudEl = null, hudTimer = 0;
  function hud(text, busy) {
    if (S.settings.jarvis === false) return;
    if (!hudEl) { hudEl = h('div', { class: 'hud', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'hud-orb' }, h('i'), h('i'), h('i')), h('span', { class: 'hud-t' })); document.body.append(hudEl); }
    hudEl.querySelector('.hud-t').textContent = text || 'Kaam kar raha hoon…';
    hudEl.classList.toggle('busy', !!busy); hudEl.classList.add('on'); clearTimeout(hudTimer);
    if (!busy) hudTimer = setTimeout(() => hudEl.classList.remove('on'), 2600);
  }
  function webStep(s) {
    const a = s.args || {};
    if (s.action === 'web.search') { window.open('https://www.google.com/search?q=' + encodeURIComponent(a.query), '_blank', 'noopener'); return { ok: true, message: 'Search khol diya' }; }
    const sites = { youtube: 'youtube.com', whatsapp: 'web.whatsapp.com', instagram: 'instagram.com', gmail: 'mail.google.com', maps: 'maps.google.com', telegram: 'web.telegram.org', spotify: 'open.spotify.com', drive: 'drive.google.com', facebook: 'facebook.com', twitter: 'x.com', netflix: 'netflix.com' };
    if (s.action === 'app.open' && sites[a.app]) { window.open('https://' + sites[a.app], '_blank', 'noopener'); return { ok: true, message: 'App website khol di' }; }
    if (s.action === 'phone.status') return { ok: true, message: navigator.onLine ? 'Browser online hai' : 'Browser offline hai' };
    if (s.action === 'voice.open') { Voice.open(); return { ok: true, message: 'Voice mode khul gaya' }; }
    return { ok: false, message: 'Ye operation sirf Android app mein chalta hai' };
  }
  async function step(s, confirmed, mode) {
    if (!LABEL[s.action]) return { ok: false, message: 'Sir, ye action AI ke liye allowed nahi hai.' };
    const sensitive = ['message.draft', 'call.dial'].includes(s.action);
    if (sensitive && !confirmed) return { ok: false, pending: true, message: 'Sir, confirmation chahiye.' };
    if (!Productivity.native() && /^(app|web|phone|voice)\./.test(s.action)) {
      if (mode !== 'standard' || !Productivity.access().localEdit || (s.action === 'app.open' && s.args.app === 'settings')) return { ok: false, message: 'Ye action disabled hai.' };
      try { return webStep(s); } catch (e) { return { ok: false, message: 'App/search nahi khul paya.' }; }
    }
    return Productivity.run(s, confirmed, false, mode);
  }
  async function execute(d, confirmed = false, redraw) {
    if (d.origin !== 'local-rule' || d.mode !== 'standard') { d.text = 'Sir, untrusted action plan execute nahi kiya.'; return; }
    if (d.run && ['running', 'done', 'cancel'].includes(d.run.state)) return d.run;
    const steps = d.steps || [];
    if (!steps.length) return;
    d.run = { state: 'running', results: (d.run && d.run.results) || {} };
    const pendingSteps = steps.filter(s => !(d.run.results[s.id] && !d.run.results[s.id].pending));
    if (Productivity.native() && pendingSteps.some(s => /^(task|reminder|alarm|timer)\./.test(s.action) && (s.args.at || s.args.seconds))) {
      const i = info(); if (i && !i.notify) { try { N().setNotify(true); } catch (e) {} }
    }
    hud('Ji Sir, ' + (steps[0].pending || 'kaam kar raha hoon'), true);
    if (redraw) redraw();
    for (const s of pendingSteps) {
      let r;
      try { r = await step(s, confirmed, d.mode); } catch (e) { r = { ok: false, message: 'Kaam fail: ' + e.message }; }
      d.run.results[s.id] = { ...r, id: s.id };
      if (r.ok && s.action === 'voice.open') { try { Voice.open(); } catch (e) {} }
    }
    const values = steps.map(s => d.run.results[s.id] || {});
    d.done = values.filter(r => r.ok).length;
    d.failed = values.filter(r => !r.ok && !r.pending).length;
    const pending = values.some(r => r.pending);
    d.run.state = pending ? 'pending' : 'done';
    d.text = 'Ji Sir, ' + values.map(r => r.message).filter(Boolean).join('. ');
    hud(pending ? 'Sir, confirmation ka wait hai' : d.failed ? 'Sir, kuch kaam nahi ho paye' : 'Ho gaya Sir', false);
    saveNow(); if (redraw) redraw();
    // Voice.say owns spoken results while its overlay is open. Avoid duplicate/racing speech.
    if (redraw && S.settings.speak && TTS.ok() && !Voice.isOpen && !pending) TTS.speak(d.text);
    return d.run;
  }
  function cancel(d, redraw) {
    const values = Object.values((d.run && d.run.results) || {}).filter(r => r.ok);
    d.run = { state: 'cancel', results: (d.run && d.run.results) || {} };
    d.text = 'Ji Sir, confirm wale kaam cancel kar diye.' + (values.length ? ' Pehle ke ' + values.length + ' safe kaam ho chuke hain.' : '');
    saveNow(); if (redraw) redraw();
  }
  function confirm(d, c) {
    const sensitive = (d.steps || []).filter(s => ['message.draft', 'call.dial'].includes(s.action));
    if (!sensitive.length) return;
    sheet({ title: 'Confirm karo, Sir', build(b, close) {
      b.append(h('p', { class: 'muted' }, 'Composer/dialer khulega; final Send/Call aap dabayenge.'));
      sensitive.forEach(s => b.append(h('div', { class: 'kvr' }, h('b', {}, LABEL[s.action][0]), h('span', {}, s.detail || s.pending))));
      b.append(h('div', { class: 'card-btns' }, h('button', { class: 'btn ghost', on: { click: () => { close(); cancel(d, c.redraw); } } }, 'Nahi'), h('button', { class: 'btn pri', on: { click: () => { close(); execute(d, true, c.redraw); } } }, 'Haan, karo')));
    } });
  }
  function stepRow(d, s) {
    const r = d.run && d.run.results && d.run.results[s.id];
    const state = r ? r.pending ? 'wait' : r.ok ? 'ok' : 'fail' : d.run && d.run.state === 'running' ? 'run' : 'wait';
    return h('div', { class: 'act-step', 'data-state': state }, h('span', { class: 'as-ic' }, icon((LABEL[s.action] || ['Kaam', 'sparkle'])[1], 's')),
      h('span', { class: 'as-t' }, h('b', {}, (LABEL[s.action] || ['Kaam'])[0] + (s.detail ? ' · ' + s.detail : '')), h('small', {}, r ? r.message : s.pending)),
      h('span', { class: 'as-s' }, state === 'ok' ? icon('check', 's') : state === 'fail' ? icon('x', 's') : state === 'run' ? '…' : ''));
  }
  function card(d, c) {
    contexts.set(d, c);
    // Older builds stored a circular context on the reply. Remove it before any persistence.
    delete d._ctx;
    const wrap = h('div', { class: 'card act' }, h('div', { class: 'act-h' }, h('span', { class: 'act-badge' }, 'JARVIS'), h('b', {}, d.text || 'Kaam kar raha hoon')),
      h('div', { class: 'act-steps' }, (d.steps || []).map(s => stepRow(d, s))));
    const state = d.run && d.run.state;
    const need = (d.steps || []).some(s => ['message.draft', 'call.dial'].includes(s.action));
    if (need && (!state || state === 'pending')) wrap.append(h('div', { class: 'card-btns' }, h('button', { class: 'btn ghost', on: { click: () => cancel(d, c.redraw) } }, 'Nahi'), h('button', { class: 'btn pri', on: { click: () => confirm(d, c) } }, 'Haan, karo')));
    const results = Object.values((d.run && d.run.results) || {});
    results.filter(r => Array.isArray(r.records)).forEach(r => wrap.append(h('details', {}, h('summary', {}, 'Records (' + r.records.length + ')'), r.records.slice(0, 20).map(x => h('p', {}, x.title || x.text || x.id)))));
    if (d.failed) wrap.append(h('p', { class: 'muted' }, 'Sir, failed step ka sahi naam/time bata kar dobara bolo.'));
    // Execution is awaited by Chat.runBackend, never triggered by merely viewing/reloading a card.
    return wrap;
  }
  function info() { try { return N() && N().actionInfo ? JSON.parse(N().actionInfo()) : null; } catch (e) { return null; } }
  function infoSheet() {
    const i = info();
    sheet({ title: 'Notification permissions', build(b, close) {
      if (!i) { b.append(h('p', {}, 'Browser alerts sirf tab khula rehne par chalenge. Background reminders ke liye Android app use karo.')); return; }
      b.append(h('p', {}, 'Notifications: ' + (i.notify ? 'On' : 'Off')), h('p', {}, 'Exact alarms: ' + (i.exact ? 'Allowed' : 'Not allowed — Android alert late kar sakta hai.')));
      if (!i.notify) b.append(h('button', { class: 'btn pri', on: { click: () => { N().setNotify(true); close(); toast('Android permission mein Allow karo.'); } } }, 'Allow notifications'));
      b.append(h('p', { class: 'muted' }, 'App screen band ho tab scheduled notifications chal sakte hain. Android Force stop/battery restrictions delivery rok sakti hain.'));
    } });
  }
  function notesSheet() { App.show('notes'); }
  return { card, execute, cancel, ctx, notesSheet, info, infoSheet, hud, webStep, notes: () => Productivity.list('note') };
})();
RENDER.actions = (d, ctx) => Actions.card(d, ctx);
