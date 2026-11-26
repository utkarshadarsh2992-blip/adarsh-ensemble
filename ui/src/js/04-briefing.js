'use strict';
/* 04-briefing.js : night briefing + tomorrow's plan (change 1.3).
   Battery: the phone only shows a notification at the set time (AlarmManager, see Briefing.kt). The one Groq call
   happens when sir opens it. Privacy: a bounded summary (goals, projects, today's concepts / words / check
   score, tasks, tomorrow's fixed times) goes to Groq only for this, after a one-time consent. No chat text is sent.
   Seam: request body `briefing` = context() for the night call, {followup, goals, projects} for later messages in the
   briefing chat; the reply carries `briefing: {date, for, focus, plan:[{title, time, minutes, goal, project}]}`. */
const Briefing = (() => {
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const hm = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const clean = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const okTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  const time = () => (okTime(S.settings.briefingTime) ? S.settings.briefingTime : '21:30');
  const N = () => window.AdarshNative;
  /* Before 4 am the night still belongs to the previous day. */
  function base(now = Date.now()) { const d = new Date(now); if (d.getHours() < 4) d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return d; }
  const dateOf = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
  const dayLabel = (s) => (Mission.validDate(s) ? dateOf(s).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '');

  /* ---------- context for the night call (bounded again in briefing.clean_context) ---------- */
  function context(now = Date.now()) {
    Productivity.sync();
    const d0 = base(now), d1 = new Date(d0), d2 = new Date(d0);
    d1.setDate(d1.getDate() + 1); d2.setDate(d2.getDate() + 2);
    const from = d0.getTime(), t1 = d1.getTime(), t2 = d2.getTime(), today = ymd(d0);
    const inToday = (ts) => +ts >= from && +ts <= now;
    let questions = 0; const concepts = [], seen = new Set();
    (S.chats || []).forEach(c => (c.msgs || []).forEach(m => {
      if (!inToday(m.ts)) return;
      if (m.role === 'user' && m.text && !m.briefing) questions++;
      const k = m.role === 'ai' && m.reply && m.reply.learn ? clean(m.reply.learn.concept, 80) : '';
      if (k && !seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); concepts.push(k); }
    }));
    const words = (S.vocab || []).filter(v => inToday(v.ts)).map(v => clean(v.w, 40)).filter(Boolean).slice(-20);
    const log = (S.learnLog || []).filter(x => inToday(x.ts));
    const weak = [], wk = new Set();
    log.filter(x => !x.ok).forEach(x => { const key = (x.concept || '') + '|' + (x.q || ''); if (!wk.has(key) && weak.length < 6) { wk.add(key); weak.push({ concept: clean(x.concept, 80), q: clean(x.q, 200) }); } });
    const tasks = S.tasks || [], at = (r) => +(r.at || r.due || 0);
    const done = tasks.filter(t => t.done && inToday(t.updated)).map(t => clean(t.title || t.text, 120)).filter(Boolean).slice(0, 10);
    const open = tasks.filter(t => !t.done && !(at(t) >= t1 && at(t) < t2)).sort((a, b) => (at(a) || 9e15) - (at(b) || 9e15)).slice(0, 10)
      .map(t => ({ title: clean(t.title || t.text, 120), due: at(t) ? fmtDue(at(t)).t : '' }));
    const work = (S.work || []).map(w => ({ title: clean(w.title, 120), minutes: (w.entries || []).filter(e => e && e.date === today).reduce((s, e) => s + (+e.minutes || 0), 0) }))
      .filter(w => w.title && w.minutes > 0).slice(0, 6);
    const fixed = [...tasks.filter(t => !t.done), ...(S.reminders || []), ...(S.alarms || [])].filter(r => at(r) >= t1 && at(r) < t2)
      .sort((a, b) => at(a) - at(b)).slice(0, 10).map(r => ({ title: clean(r.title || r.text, 120) || 'Alarm', time: hm(at(r)) }));
    const sum = Mission.summary();
    return { date: today, tomorrow: ymd(d1), weekday: DAYS[d0.getDay()], tomorrowDay: DAYS[d1.getDay()], now: hm(now),
      goals: sum.goals, projects: sum.projects,
      today: { questions, concepts: concepts.slice(0, 12), words, right: log.filter(x => x.ok).length, total: log.length, weak, done, open, work },
      fixed, news: News.briefingLines() };
  }
  function request(c, meta) {
    if (meta && meta.briefing) return context();
    if (c && c.briefing) { const s = Mission.summary(); return { followup: true, goals: s.goals, projects: s.projects }; }
    return undefined;
  }

  /* ---------- start ---------- */
  function privacySheet(then) {
    sheet({ title: 'Raat ki briefing · privacy', build(b, close) {
      b.append(h('div', { class: 'bp-consent' },
        h('p', {}, 'Briefing ke liye ek chhota summary Groq (Standard mode ka AI) ko jayega:'),
        h('ul', {}, ['Goals (deadline, progress) aur projects (built / learned / next)', 'Aaj ke concepts, naye shabd, check score aur galat sawaal', 'Aaj ke done / open tasks, work minutes, kal ke fixed time'].map(t => h('li', {}, t))),
        h('p', { class: 'muted' }, 'Chats ka text nahi jata. Briefing 0–3 memory suggestions de sakti hai; sir “Yaad rakho” dabayenge tabhi phone ki Memory mein save hogi. Din mein “yaad rakho…” bolne par seedha save hoga.')),
        h('div', { class: 'frow' },
          h('button', { class: 'btn ghost', style: 'flex:1', on: { click: () => { if (S.settings.briefingConsent) { S.settings.briefingConsent = false; save(); toast('Consent hata diya. Agli briefing par phir poochega.'); } close(); if (then) then(false); } } }, S.settings.briefingConsent ? 'Consent hatao' : 'Abhi nahi'),
          h('button', { class: 'btn pri', style: 'flex:1', on: { click: () => { S.settings.briefingConsent = true; save(); close(); if (then) then(true); } } }, S.settings.briefingConsent ? 'Theek hai' : 'Theek hai, chalao')));
    } });
  }
  const succeeded = (c) => (c.msgs || []).some(m => m.role === 'ai' && m.reply && m.reply.briefing);
  function start() {
    if (Chat.isBusy()) return toast('Pehle current jawab aane do.');
    if (!S.settings.briefingConsent) return privacySheet(ok => { if (ok) start(); });
    const date = ymd(base()), text = 'Raat ki briefing · ' + dayLabel(date);
    const ex = (S.chats || []).find(c => c.briefing === date);
    if (ex && succeeded(ex)) { Chat.open(ex.id); return toast('Aaj ki briefing ye rahi. Nayi chahiye to Retry dabao.'); }
    const go = () => {   /* change 1.5: top news lines were fetched just before (News.prefetchTop) */
      if (Chat.isBusy()) return;
      if (ex) { Chat.open(ex.id); return Chat.submit(text, { briefing: true }); }
      App.show('chat');
      const c = Chat.newChat(); c.briefing = date; save();
      Chat.submit(text, { briefing: true });
    };
    if (News.wants()) { toast('Khabar la raha hoon…'); News.prefetchTop(3500).then(go, go); } else go();   // sync when news is off
  }
  function absorb(c, r) {
    if (!c || !c.briefing || !r || !r.briefing || typeof r.briefing !== 'object') return;
    const date = Mission.validDate(r.briefing.date) ? r.briefing.date : c.briefing;
    const list = (Array.isArray(S.briefings) ? S.briefings : []).filter(x => !(x.date === date && x.chatId === c.id));
    list.unshift({ date, chatId: c.id, ts: Date.now(), saved: 0 });
    S.briefings = list.slice(0, 60);
    try { News.copyBriefing(r, date); } catch (e) {}   // change 1.5: optional Telegram copy
  }
  const doneToday = () => (S.briefings || []).some(x => x.date === ymd(base()));

  /* ---------- plan card under the briefing reply ---------- */
  function planAt(day, t) {
    if (!okTime(t) || !Mission.validDate(day)) return 0;
    const d = dateOf(day), [hh, mm] = t.split(':').map(Number); d.setHours(hh, mm, 0, 0);
    return d.getTime() > Date.now() ? d.getTime() : 0;
  }
  async function savePlan(B, ctx, btn) {
    const items = (B.plan || []).filter((x, i) => B.pick[i] !== false);
    if (!items.length) return toast('Koi item select nahi hai.');
    btn.disabled = true;
    let ok = 0, fail = '';
    for (const it of items) {
      const title = clean(it.title, 100) + (it.minutes ? ' · ' + it.minutes + ' min' : ''), at = planAt(B.for, it.time);
      try { const r = await Productivity.manual('task.add', at ? { title, at } : { title }); if (r && r.ok) ok++; else fail = (r && (r.message || r.error)) || 'save nahi hua'; } catch (e) { fail = e.message; }
    }
    B.saved = ok;
    const row = (S.briefings || []).find(x => x.chatId === (ctx.chatId || '') || x.date === B.date); if (row) row.saved = ok;
    save(); ctx.redraw();
    toast(ok ? ok + ' tasks kal ke liye save' + (fail ? ' · kuch fail: ' + fail : '') : 'Tasks save nahi hue: ' + fail);
  }
  function extras(m, ctx) {
    const B = m.reply && m.reply.briefing;
    if (!B || typeof B !== 'object') return [];
    const suggestions = (Array.isArray(B.memorySuggestions) ? B.memorySuggestions : []).slice(0, 3)
      .map(x => ({ text: clean(typeof x === 'string' ? x : x && x.text, 180), reason: clean(x && x.reason, 120) }))
      .filter(x => x.text);
    const extras = [];
    const hasPlan = Array.isArray(B.plan) && (B.plan.length || B.focus);
    if (hasPlan) {
      if (!Array.isArray(B.pick) || B.pick.length !== B.plan.length) B.pick = B.plan.map(() => true);
      const saved = B.saved > 0, n = B.pick.filter(x => x !== false).length;
      const rows = B.plan.map((it, i) => {
      const on = B.pick[i] !== false;
      const tags = [it.goal ? h('span', { class: 'bp-tag' }, 'GOAL · ' + clean(it.goal, 40)) : null, it.project ? h('span', { class: 'bp-tag' }, 'PROJECT · ' + clean(it.project, 40)) : null].filter(Boolean);
      return h('button', { type: 'button', class: 'bp-row' + (on ? ' on' : ''), role: 'checkbox', 'aria-checked': String(on), disabled: saved,
        on: { click: () => { B.pick[i] = !on; save(); ctx.redraw(); } } },
        h('span', { class: 'bp-box' }, on ? icon('check', 's') : null),
        h('span', { class: 'bp-time' }, it.time || '--:--'),
        h('span', { class: 'bp-main' }, h('b', {}, it.title), tags.length ? h('span', { class: 'bp-tags' }, tags) : null),
        it.minutes ? h('span', { class: 'bp-min' }, it.minutes + 'm') : null);
      });
      const total = B.plan.reduce((s, it, i) => s + (B.pick[i] !== false ? +it.minutes || 0 : 0), 0);
      const btn = h('button', { class: 'btn ' + (saved ? 'ghost' : 'pri'), disabled: saved || !n, on: { click: (e) => savePlan(B, { ...ctx, chatId: (S.cur || '') }, e.currentTarget) } },
      saved ? icon('check', 's') : icon('plus', 's'), saved ? B.saved + ' tasks save ho gaye' : n + ' tasks save karo');
      extras.push(h('div', { class: 'bplan', role: 'group', 'aria-label': 'Kal ka plan' },
      h('div', { class: 'bp-head' }, h('span', { class: 'bp-k' }, icon('moon', 's'), 'KAL KA PLAN'), h('span', { class: 'bp-d' }, dayLabel(B.for) + (total ? ' · ' + Math.round(total / 6) / 10 + ' h' : ''))),
      B.focus ? h('div', { class: 'bp-focus' }, h('span', { class: 'bp-fk' }, 'FOCUS'), h('span', {}, B.focus)) : null,
      rows.length ? h('div', { class: 'bp-rows' }, rows) : null,
      rows.length ? h('div', { class: 'bp-foot' }, btn, h('span', { class: 'bp-note' }, saved ? 'Tasks list mein hain; time wale par alert aayega.' : 'Tap = item hatao / jodo. Time wale tasks par alert aayega.')) : null));
    }
    if (suggestions.length) {
      if (!Array.isArray(B.memoryDecisions)) B.memoryDecisions = [];
      const normalized = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const rows = suggestions.map((item, i) => {
        const already = (S.memories || []).some(x => normalized(x.text) === normalized(item.text));
        const status = B.memoryDecisions[i] || (already ? 'existing' : '');
        if (status) {
          const label = status === 'saved' || status === 'existing' ? (status === 'saved' ? 'Memory mein save ho gayi' : 'Pehle se Memory mein hai') : 'Skip kiya';
          return h('div', { class: 'bm-row' }, h('div', { class: 'bm-copy' }, h('b', {}, item.text), item.reason ? h('small', {}, item.reason) : null), h('span', { class: 'bm-state' }, label));
        }
        const decide = keep => {
          if (keep && !already) S.memories.unshift({ id: uid('mem'), text: item.text, pin: false, ts: Date.now(), source: 'night-briefing' });
          B.memoryDecisions[i] = keep ? 'saved' : 'skipped'; save(); ctx.redraw();
          if (keep) toast(already ? 'Ye memory pehle se hai.' : 'Memory phone par save ho gayi.');
        };
        return h('div', { class: 'bm-row' }, h('div', { class: 'bm-copy' }, h('b', {}, item.text), item.reason ? h('small', {}, item.reason) : null),
          h('div', { class: 'bm-actions' },
            h('button', { class: 'btn pri bm-yes', on: { click: () => decide(true) } }, 'Yaad rakho'),
            h('button', { class: 'btn ghost bm-no', on: { click: () => decide(false) } }, 'Skip')));
      });
      extras.push(h('div', { class: 'bmem', role: 'group', 'aria-label': 'Memory approval' },
        h('div', { class: 'bm-head' }, icon('brain', 's'), h('b', {}, 'YAAD RAKHUN?')),
        h('p', { class: 'bm-note' }, 'Ye aaj ke records se AI ke suggestions hain. “Yaad rakho” par hi local Memory mein save honge.'),
        rows));
    }
    return extras;
  }

  /* ---------- schedule (Android alarm) + in-app due banner ---------- */
  function sync(ask = false) {
    const n = N();
    if (!n || !n.briefingSet) return null;
    try { return JSON.parse(n.briefingSet(JSON.stringify({ on: S.settings.briefingOn !== false, time: time(), ask: !!ask }))); } catch (e) { return null; }
  }
  function status() {
    const on = S.settings.briefingOn !== false;
    if (!on) return 'Band hai';
    const n = N(); let j = null;
    if (n && n.briefingStatus) { try { j = JSON.parse(n.briefingStatus()); } catch (e) {} }
    if (!j) return 'Roz ' + time() + ' · app khula ho tab banner';
    return 'Roz ' + time() + ' · notification' + (j.notify === false ? ' (permission off)' : '') + (j.exact === false ? ' · approx time' : '');
  }
  function timeSheet(onDone) {
    sheet({ title: 'Briefing ka time', build(b, close) {
      const inp = h('input', { class: 'pv-input', type: 'time', value: time(), 'aria-label': 'Briefing time' });
      b.append(h('div', { class: 'pv-form' },
        h('label', { class: 'pv-field' }, h('span', { class: 'pv-label' }, 'Roz is time par'), inp, h('span', { class: 'pv-hint' }, 'Phone sirf notification dikhata hai (battery bachti hai). Groq call tab hoti hai jab aap briefing kholte ho.')),
        h('button', { class: 'btn pri', on: { click: () => {
          if (!okTime(inp.value)) return toast('Time HH:MM chahiye');
          S.settings.briefingTime = inp.value; S.settings.briefingOn = true; save(); sync(true); close(); toast('Briefing roz ' + inp.value + ' par'); try { News.syncTime(true); } catch (e) {} if (onDone) onDone();
        } } }, 'Save')));
    } });
  }
  function setOn(v) { S.settings.briefingOn = !!v; save(); sync(!!v); toast(v ? 'Raat ki briefing on · ' + time() : 'Raat ki briefing band'); }
  function locked() { const l = document.getElementById('lock'); return !!(l && !l.hidden); }
  function dueCheck(now = Date.now()) {
    if (S.settings.briefingOn === false || document.hidden || locked()) return false;
    const [hh, mm] = time().split(':').map(Number), at = new Date(now);
    at.setHours(hh, mm, 0, 0); if (at.getTime() > now) at.setDate(at.getDate() - 1);
    if (now - at.getTime() > 6 * 3600e3) return false;
    const key = ymd(base(at.getTime() + 60e3));
    if (S.settings.briefingSeen === key || (S.briefings || []).some(x => x.date === key)) return false;
    S.settings.briefingSeen = key; save();
    banner({ title: 'Raat ki briefing ka time', text: 'Aaj ka hisaab aur kal ka plan. Ek Groq call.', label: 'Shuru', onOpen: start, ms: 0 });
    return true;
  }
  let waitT = 0;
  function openFromNotification() {
    clearTimeout(waitT);
    const end = Date.now() + 10 * 60e3;
    const go = () => { if (locked() || Chat.isBusy()) { if (Date.now() < end) waitT = setTimeout(go, 700); return; } start(); };
    go();
  }
  window.__adarshOpen = (what) => {   /* MainActivity.onNewIntent: notification tapped while the app was running */
    if (what !== 'briefing' && !/^news/.test(String(what))) return;
    try { const n = N(); if (n && n.takeOpen) n.takeOpen(); } catch (e) {}   // clear the native flag so a page reload does not reopen it
    if (what === 'briefing') openFromNotification(); else News.open(what);
  };
  function init() {
    sync(false);
    const n = N();
    try { const v = n && n.takeOpen ? String(n.takeOpen() || '') : ''; if (v === 'briefing') openFromNotification(); else if (/^news/.test(v)) News.open(v); } catch (e) {}
    setTimeout(dueCheck, 4000); setInterval(dueCheck, 60e3);
  }
  function cleanImport(d) {
    if (!Array.isArray(d.briefings)) return {};
    return { briefings: d.briefings.filter(x => x && typeof x === 'object' && Mission.validDate(x.date)).slice(0, 60)
      .map(x => ({ date: x.date, chatId: clean(x.chatId, 200), ts: +x.ts || 0, saved: Math.max(0, Math.min(20, Math.round(+x.saved) || 0)) })) };
  }
  return { context, request, start, absorb, extras, sync, status, timeSheet, privacySheet, setOn, dueCheck, init, cleanImport, doneToday, time, base, ymd };
})();
