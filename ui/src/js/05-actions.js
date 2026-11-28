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
    'app.open': ['App', 'sliders'], 'controller.read': ['Controller status', 'server'], 'controller.model.toggle': ['Controller model', 'sliders'],
    'controller.model.remove': ['Controller model removal', 'sliders'],
    'controller.model.set': ['Controller model', 'sliders'], 'controller.route.set': ['Controller routing', 'sliders'],
    'controller.news.set': ['Controller News limit', 'sliders'], 'controller.briefing.set': ['Controller briefing', 'sliders'],
    'web.search': ['Search', 'search'], 'phone.status': ['Phone', 'server'], 'calendar.add': ['Calendar', 'cal'],
    'voice.open': ['Voice', 'voice'], 'message.draft': ['Message', 'send'], 'call.dial': ['Call', 'chat'], 'torch.set': ['Torch', 'bolt'] };
  const contexts = new WeakMap();
  const ctx = d => contexts.get(d);
  let hudEl = null, hudTimer = 0;
  function hud(text, busy) {
    if (S.settings.adarshActions === false) return;
    if (!hudEl) { hudEl = h('div', { class: 'hud', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'hud-orb' }, h('i'), h('i'), h('i')), h('span', { class: 'hud-t' })); document.body.append(hudEl); }
    hudEl.querySelector('.hud-t').textContent = text || 'Kaam kar raha hoon…';
    hudEl.classList.toggle('busy', !!busy); hudEl.classList.add('on'); clearTimeout(hudTimer);
    if (!busy) hudTimer = setTimeout(() => hudEl.classList.remove('on'), 2600);
  }
  function webStep(s) {
    const a = s.args || {};
    if (s.action === 'web.search') { window.open('https://www.google.com/search?q=' + encodeURIComponent(a.query), '_blank', 'noopener'); return { ok: true, message: 'Search khol diya' }; }
    const sites = { youtube: 'youtube.com', whatsapp: 'web.whatsapp.com', instagram: 'instagram.com', gmail: 'mail.google.com', maps: 'maps.google.com', telegram: 'web.telegram.org', spotify: 'open.spotify.com', drive: 'drive.google.com', facebook: 'facebook.com', twitter: 'x.com', netflix: 'netflix.com', controller: 'adarshctl-pc68aukk.manus.space' };
    if (s.action === 'app.open' && Object.prototype.hasOwnProperty.call(sites, a.app)) {
      window.open('https://' + sites[a.app], '_blank', 'noopener');
      return { ok: true, message: a.app === 'controller' ? 'Adarsh Controller khol diya' : 'App website khol di' };
    }
    if (s.action === 'phone.status') return { ok: true, message: navigator.onLine ? 'Browser online hai' : 'Browser offline hai' };
    if (s.action === 'voice.open') { Voice.open(); return { ok: true, message: 'Voice mode khul gaya' }; }
    return { ok: false, message: 'Ye operation sirf Android app mein chalta hai' };
  }
  const NEWS_FIELDS = ['alerts_per_day', 'alert_min_score', 'list_min_score', 'groq_tokens_cap', 'groq_calls_cap', 'tavily_day_cap', 'tavily_month_cap'];
  const safeNum = (obj, key) => obj && Number.isFinite(Number(obj[key])) ? Number(obj[key]) : null;
  function safeControllerState(raw) {
    if (!raw || raw.ok !== true || !raw.config || !Array.isArray(raw.config.models) || !raw.config.routes || typeof raw.config.routes !== 'object') return null;
    const models = raw.config.models.slice(0, 100).filter(m => m && typeof m.label === 'string' && typeof m.model === 'string' && ['groq', 'openrouter', 'gemini', 'nvidia', 'cloudflare'].includes(m.provider))
      .map(m => {
        const extra = m.extra && typeof m.extra === 'object' ? m.extra : {};
        return { label: m.label.slice(0, 80), provider: m.provider, model: m.model.slice(0, 128), enabled: m.enabled === true,
          extra: { ...( ['low', 'medium', 'high'].includes(extra.reasoning_effort) ? { reasoning_effort: extra.reasoning_effort } : {}),
            ...( ['hidden', 'raw', 'parsed'].includes(extra.reasoning_format) ? { reasoning_format: extra.reasoning_format } : {}) } };
      });
    const routes = Object.fromEntries(Object.entries(raw.config.routes).slice(0, 100).filter(([k, v]) => typeof k === 'string' && Array.isArray(v))
      .map(([k, v]) => [k.slice(0, 100), v.filter(x => typeof x === 'string').slice(0, 10).map(x => x.slice(0, 80))]));
    const srcNews = raw.news && typeof raw.news === 'object' ? raw.news : {};
    const settings = {};
    NEWS_FIELDS.forEach(k => { const n = safeNum(srcNews.settings, k); if (n !== null) settings[k] = n; });
    const srcBudget = srcNews.budget && typeof srcNews.budget === 'object' ? srcNews.budget : {};
    const copyNumbers = (obj, keys) => Object.fromEntries(keys.map(k => [k, safeNum(obj, k)]).filter(([, v]) => v !== null));
    const budget = {
      groq: copyNumbers(srcBudget.groq, ['tokens_used', 'tokens_cap', 'calls_used', 'calls_cap']),
      tavily: copyNumbers(srcBudget.tavily, ['day_used', 'day_cap', 'month_used', 'month_cap']),
      alerts: copyNumbers(srcBudget.alerts, ['today', 'cap']),
    };
    const ds = raw.device_settings && typeof raw.device_settings === 'object' ? raw.device_settings : {};
    const device_settings = {
      briefingOn: ds.briefingOn === true,
      briefingTime: typeof ds.briefingTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(ds.briefingTime) ? ds.briefingTime : '',
      newsBriefing: ds.newsBriefing === true,
      briefingTelegram: ds.briefingTelegram === true,
    };
    return { revision: Number.isSafeInteger(raw.revision) ? raw.revision : 0, models, routes,
      news: { local_day: String(srcNews.local_day || '').slice(0, 10), tz: String(srcNews.tz || '').slice(0, 80), settings, budget }, device_settings };
  }
  const fmtNum = n => Number(n).toLocaleString('en-IN');
  function controllerSummary(s) {
    const models = s.models.map(m => `${m.label}=${m.provider}/${m.model} ${m.enabled ? 'ON' : 'OFF'}`);
    const routes = Object.entries(s.routes).map(([k, v]) => `${k} → ${v.join(' → ')}`);
    const n = s.news, b = n.budget;
    const limits = Object.entries(n.settings).map(([k, v]) => `${k} ${fmtNum(v)}`).join(', ') || 'unavailable';
    const usage = [`Groq tokens ${fmtNum(b.groq.tokens_used || 0)}/${fmtNum(b.groq.tokens_cap || 0)}, calls ${fmtNum(b.groq.calls_used || 0)}/${fmtNum(b.groq.calls_cap || 0)}`,
      `Tavily day ${fmtNum(b.tavily.day_used || 0)}/${fmtNum(b.tavily.day_cap || 0)}, month ${fmtNum(b.tavily.month_used || 0)}/${fmtNum(b.tavily.month_cap || 0)}`,
      `alerts ${fmtNum(b.alerts.today || 0)}/${fmtNum(b.alerts.cap || 0)}`].join('; ');
    const d = s.device_settings;
    return [`Controller revision ${s.revision}.`, `Models (${models.length}): ${models.join('; ') || 'none'}.`,
      `Routes (${routes.length} overrides): ${routes.join('; ') || 'bundled defaults'}.`, `News limits: ${limits}. Usage: ${usage}.`,
      `Briefing: ${d.briefingOn ? 'on' : 'off'}${d.briefingTime ? ' at ' + d.briefingTime : ''}; News ${d.newsBriefing ? 'on' : 'off'}; Telegram ${d.briefingTelegram ? 'on' : 'off'}.`].join(' ').slice(0, 3600);
  }
  function controllerLabel(models, label) {
    const matches = models.filter(m => m.label.toLowerCase() === String(label || '').toLowerCase());
    return matches.length === 1 ? matches[0] : null;
  }
  async function controllerStep(s) {
    const backend = window.ADARSH_BACKEND, action = s.action, a = s.args || {};
    const reading = action === 'controller.read';
    if (reading ? !Productivity.access().localRead : !Productivity.access().localEdit) return { ok: false, message: 'Controller AI access is off in Settings.' };
    if (!Productivity.native() || !backend || backend.native !== true || typeof backend.controllerAssistantRead !== 'function' || typeof backend.controllerAssistantUpdate !== 'function') return { ok: false, message: 'Controller AI access paired Android app mein hi available hai.' };
    try {
      const current = safeControllerState(await backend.controllerAssistantRead());
      if (!current) return { ok: false, message: 'Controller pair nahi hai ya safe state read nahi hui. Credentials AI ko nahi dikhaye gaye.' };
      if (reading) return { ok: true, message: controllerSummary(current), controller: current };
      let payload;
      if (action === 'controller.model.toggle' || action === 'controller.model.remove' || action === 'controller.model.set' || action === 'controller.route.set') {
        let models = current.models.map(m => ({ ...m, extra: { ...m.extra } })), routes = { ...current.routes };
        if (action === 'controller.model.remove') {
          const target = controllerLabel(models, a.label);
          if (!target) return { ok: false, message: `Model label ${String(a.label).slice(0, 80)} unique registry mein nahi mila; kuch change nahi kiya.` };
          models = models.filter(m => m.label !== target.label);
        } else if (action === 'controller.model.toggle') {
          const target = controllerLabel(models, a.label);
          if (!target) return { ok: false, message: `Model label ${String(a.label).slice(0, 80)} unique registry mein nahi mila; kuch change nahi kiya.` };
          models = models.map(m => m.label === target.label ? { ...m, enabled: a.enabled === true } : m);
        } else if (action === 'controller.model.set') {
          const existing = controllerLabel(models, a.label);
          if (!existing && models.length >= 100) return { ok: false, message: 'Model registry limit 100 hai; kuch change nahi kiya.' };
          if (!existing && models.some(m => m.label.toLowerCase() === String(a.label).toLowerCase())) return { ok: false, message: 'Model label case-insensitive duplicate hai; kuch change nahi kiya.' };
          const extra = { ...(existing ? existing.extra : {}) };
          if (a.reasoning_effort) extra.reasoning_effort = a.reasoning_effort;
          if (a.reasoning_format) extra.reasoning_format = a.reasoning_format;
          const next = { label: a.label, provider: a.provider, model: a.model, enabled: typeof a.enabled === 'boolean' ? a.enabled : (existing ? existing.enabled : true), extra };
          models = existing ? models.map(m => m.label === existing.label ? next : m) : [...models, next];
        } else routes[a.key] = a.models.slice();
        payload = { kind: 'config', values: { models, routes }, expected_revision: current.revision,
          reason: `Adarsh direct command: ${action} ${String(a.label || a.key || '').slice(0, 80)}` };
      } else if (action === 'controller.news.set') {
        payload = { kind: 'news_settings', values: { [a.field]: a.value }, reason: `Adarsh direct command: News ${a.field}=${a.value}` };
      } else if (action === 'controller.briefing.set') {
        payload = { kind: 'briefing_settings', values: { [a.field]: a.value }, reason: `Adarsh direct command: briefing ${a.field}` };
      } else return { ok: false, message: 'Controller operation allowlist mein nahi hai.' };
      const saved = await backend.controllerAssistantUpdate(payload);
      if (!saved || saved.ok !== true) return { ok: false, message: 'Controller ne update reject kiya; existing configuration unchanged rakhi.' };
      const suffix = saved.applied === false ? '; server par save hua, phone par apply pending hai' : '';
      return { ok: true, message: `Controller update apply ho gaya${Number.isSafeInteger(saved.revision) ? ` (revision ${saved.revision})` : ''}${suffix}.`, revision: saved.revision };
    } catch (e) {
      return { ok: false, message: `Controller update nahi hua: ${String(e && e.message || 'connection ya validation error').slice(0, 180)}. Existing state safe rakhi.` };
    }
  }
  async function step(s, confirmed, mode) {
    if (!LABEL[s.action]) return { ok: false, message: 'Sir, ye action AI ke liye allowed nahi hai.' };
    const sensitive = ['message.draft', 'call.dial'].includes(s.action);
    if (sensitive && !confirmed) return { ok: false, pending: true, message: 'Sir, confirmation chahiye.' };
    if (s.action.startsWith('controller.')) {
      if (mode !== 'standard') return { ok: false, message: 'Controller command ke liye Standard mode use karo.' };
      return controllerStep(s);
    }
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
    const wrap = h('div', { class: 'card act' }, h('div', { class: 'act-h' }, h('span', { class: 'act-badge' }, 'ADARSH'), h('b', {}, d.text || 'Kaam kar raha hoon')),
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
      if (!i) { b.append(h('p', {}, 'Alerts sirf app khula rehne par.')); return; }
      b.append(h('p', {}, 'Notifications: ' + (i.notify ? 'On' : 'Off')), h('p', {}, 'Exact alarms: ' + (i.exact ? 'Allowed' : 'Not allowed — Android alert late kar sakta hai.')));
      if (!i.notify) b.append(h('button', { class: 'btn pri', on: { click: () => { N().setNotify(true); close(); toast('Android permission mein Allow karo.'); } } }, 'Allow notifications'));
      b.append(h('p', { class: 'muted' }, 'App band ho to notifications Android par chalte hain. Force stop/battery restrictions delivery rok sakti hain.'));
    } });
  }
  function notesSheet() { App.show('notes'); }
  return { card, execute, cancel, ctx, notesSheet, info, infoSheet, hud, webStep, notes: () => Productivity.list('note') };
})();
RENDER.actions = (d, ctx) => Actions.card(d, ctx);
