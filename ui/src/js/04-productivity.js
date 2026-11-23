'use strict';
/* Explicit local capability layer. Never grants arbitrary JS/filesystem access to a model. */
const Productivity = (() => {
  const COLLECTIONS = { task: 'tasks', reminder: 'reminders', alarm: 'alarms', timer: 'timers', note: 'notes', work: 'work' };
  const ACCESS = { localRead: true, localEdit: true, personalOnline: false, oldChats: false, currentChat: true, architecture: true };
  const BLOCKED = new Set(['note.clear', 'dnd.set', 'panel.open']);
  const SETTINGS = new Set(['name', 'theme', 'font', 'rate', 'lang', 'voiceName', 'voiceEngine', 'voiceReplies', 'speak', 'haptics']);
  const timers = new Map();
  const N = () => window.AdarshNative;
  const native = () => !!(N() && N().recordsList && N().runActions);
  const access = () => ({ ...ACCESS, ...(S.settings.aiAccess || {}) });
  const result = (ok, message, extra = {}) => ({ ok, message, ...extra });
  const text = (v, max = 600) => typeof v === 'string' ? v.trim().slice(0, max) : '';
  const fields = ['id', 'kind', 'title', 'text', 'at', 'created', 'updated', 'done', 'firedAt', 'category', 'goal', 'progress', 'minutes', 'outcome', 'entries'];
  const IMPORT_MAX_BYTES = 2 * 1024 * 1024, IMPORT_MAX_RECORDS = 500, IMPORT_RECORD_MAX_BYTES = 32 * 1024;
  const jsonBytes = (v) => { try { return new TextEncoder().encode(JSON.stringify(v)).length; } catch (e) { return Infinity; } };
  function safeRecord(r) {
    if (!r || !COLLECTIONS[r.kind]) return null;
    const out = {};
    fields.forEach(k => { if (r[k] != null && (typeof r[k] !== 'object' || k === 'entries')) out[k] = r[k]; });
    if (Array.isArray(out.entries)) out.entries = out.entries.map(e => ({ id: e.id, date: e.date, minutes: e.minutes, text: e.text, progress: e.progress, outcome: e.outcome }));
    if (!out.at) delete out.at;
    if (!out.firedAt) delete out.firedAt;
    if (['task', 'work'].includes(out.kind)) { out.title = out.title || out.text; delete out.text; }
    else { out.text = out.text || out.title; delete out.title; }
    return out;
  }
  function importedRecord(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || jsonBytes(r) > IMPORT_RECORD_MAX_BYTES || typeof r.kind !== 'string' || !COLLECTIONS[r.kind]) return null;
    const strCaps = { id: 120, title: 120, text: 600, category: 120, goal: 600, outcome: 600 };
    for (const [k, max] of Object.entries(strCaps)) if (r[k] != null && (typeof r[k] !== 'string' || r[k].length > max)) return null;
    for (const k of ['at', 'created', 'updated', 'firedAt', 'progress', 'minutes']) if (r[k] != null && (typeof r[k] !== 'number' || !Number.isFinite(r[k]) || r[k] < 0)) return null;
    if (r.progress != null && r.progress > 100 || r.minutes != null && r.minutes > 1440) return null;
    if (r.done != null && typeof r.done !== 'boolean') return null;
    if (r.entries != null) {
      if (!Array.isArray(r.entries) || r.entries.length > 100) return null;
      for (const e of r.entries) {
        if (!e || typeof e !== 'object' || Array.isArray(e) || (e.id != null && (typeof e.id !== 'string' || e.id.length > 120)) ||
          (e.date != null && (typeof e.date !== 'string' || e.date.length > 40)) || (e.text != null && (typeof e.text !== 'string' || e.text.length > 600)) ||
          (e.outcome != null && (typeof e.outcome !== 'string' || e.outcome.length > 600)) ||
          (e.minutes != null && (typeof e.minutes !== 'number' || !Number.isFinite(e.minutes) || e.minutes < 0 || e.minutes > 1440)) ||
          (e.progress != null && (typeof e.progress !== 'number' || !Number.isFinite(e.progress) || e.progress < 0 || e.progress > 100))) return null;
      }
    }
    const x = safeRecord(r);
    return x && jsonBytes(x) <= IMPORT_RECORD_MAX_BYTES ? x : null;
  }
  function absorb(records) {
    Object.keys(COLLECTIONS).forEach(k => { S[COLLECTIONS[k]] = []; });
    records.forEach(r => { const x = safeRecord(r); if (x) { if (x.kind === 'task') x.due = x.at || null; S[COLLECTIONS[x.kind]].push(x); } });
  }
  function changed() { saveNow(); Bus.emit('records:changed'); }
  function sync() {
    if (!native()) return true;
    try {
      const j = JSON.parse(N().recordsList());
      if (j.ok === false || j.error || !Array.isArray(j.records)) return false;
      absorb(j.records); save(); return true;
    } catch (e) { return false; }
  }
  function init() {
    Object.values(COLLECTIONS).forEach(k => { if (!Array.isArray(S[k])) S[k] = []; });
    S.settings.aiAccess = access();
    const legacy = [];
    Object.entries(COLLECTIONS).forEach(([kind, key]) => S[key].forEach(r => {
      const x = safeRecord({ ...r, id: r.id || uid(kind), kind, at: r.at || r.due, created: r.created || r.ts || 1, updated: r.updated || r.created || r.ts || 1 });
      if (x) legacy.push(x);
    }));
    try { (JSON.parse(localStorage.getItem('adarsh.notes.v1') || '[]')).forEach(r => {
      if (!legacy.some(x => x.kind === 'note' && x.text === r.text)) legacy.push(safeRecord({ ...r, id: r.id || uid('note'), kind: 'note', created: r.created || r.ts || 1, updated: r.updated || r.created || r.ts || 1 }));
    }); } catch (e) {}
    if (native()) {
      if (!S.settings.recordsMigrated && N().recordsImport) {
        try {
          const current = JSON.parse(N().recordsList());
          if (current.ok === false || current.error || !Array.isArray(current.records)) throw new Error('Native records unavailable');
          const ids = new Set(current.records.map(r => r.id));
          // During migration native IDs always win, even if an old mirror has a misleading newer timestamp.
          const rows = legacy.filter(r => r && !ids.has(r.id));
          const j = JSON.parse(N().recordsImport(JSON.stringify({ records: rows })));
          if (!j.ok) throw new Error(j.error || 'Migration failed');
          S.settings.recordsMigrated = true;
        } catch (e) { toast('Records migration fail hui; purana local data preserve hai. ' + e.message); save(); return; }
      }
      if (!sync()) toast('Local records abhi nahi khule. App dobara kholo; purana data delete nahi hua.');
    } else {
      absorb(legacy);
      Object.values(COLLECTIONS).flatMap(k => S[k]).filter(r => r.at > Date.now() && !r.done && !r.firedAt).forEach(armWeb);
    }
    save();
  }
  function list(kind) {
    if (kind === 'memory') return S.memories;
    return S[COLLECTIONS[kind]] || [];
  }
  function target(kind, a) {
    const all = list(kind);
    const exact = a.id ? all.filter(r => r.id === a.id) : [];
    if (a.id) return exact.length === 1 ? exact[0] : null;
    const q = text(a.query, 120).toLowerCase();
    if (!q) return null;
    const hits = all.filter(r => (r.title || r.text || '').toLowerCase() === q);
    const near = hits.length ? hits : all.filter(r => (r.title || r.text || '').toLowerCase().includes(q));
    return near.length === 1 ? near[0] : null;
  }
  function cancelWeb(id) { if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); } }
  function armWeb(r) {
    cancelWeb(r.id);
    if (!r.at || r.done || r.firedAt || r.at <= Date.now()) return;
    // Browser timers are not a background scheduling service. Long waits are rechecked within the tab.
    const fire = () => {
      if (r.done || !list(r.kind).some(x => x.id === r.id)) return;
      if (r.at > Date.now()) { timers.set(r.id, setTimeout(fire, Math.min(r.at - Date.now(), 2147480000))); return; }
      r.firedAt = Date.now(); changed();
      const title = r.kind === 'timer' ? 'Timer khatam' : r.kind === 'task' ? 'Task due' : 'Reminder';
      try { if (window.Notification && Notification.permission === 'granted') new Notification(title, { body: r.title || r.text }); } catch (e) {}
      toast((r.title || r.text) + ' — time ho gaya');
    };
    timers.set(r.id, setTimeout(fire, Math.min(Math.max(1, r.at - Date.now()), 2147480000)));
  }
  function setting(a) {
    if (!SETTINGS.has(a.key)) return result(false, 'Sir, ye setting AI change nahi kar sakta.');
    const allowed = { theme: ['system', 'light', 'dark'], font: ['serif', 'sans'], lang: ['hi-IN', 'en-IN', 'en-US'], voiceEngine: ['auto', 'natural', 'device'] };
    let v = a.value;
    if (allowed[a.key] && !allowed[a.key].includes(v)) return result(false, 'Setting ki value valid nahi hai.');
    if (a.key === 'rate' && (typeof v !== 'number' || !Number.isFinite(v) || v < 0.7 || v > 1.4)) return result(false, 'Voice speed 0.7 se 1.4 tak honi chahiye.');
    if (a.key === 'voiceName' && !VOICES.some(x => x[0] === v)) return result(false, 'Ye natural voice available nahi hai.');
    if (['speak', 'voiceReplies', 'haptics'].includes(a.key) && typeof v !== 'boolean') return result(false, 'On/off value chahiye.');
    if (a.key === 'name') { v = text(v, 60); if (!v) return result(false, 'Naam chahiye.'); }
    S.settings[a.key] = v;
    if (a.key === 'theme' || a.key === 'font') App.applyTheme();
    changed();
    return result(true, 'Setting update: ' + a.key + ' = ' + String(v));
  }
  async function run(step, confirmed = false, manual = false, mode = 'standard') {
    const action = String(step.action || ''), a = step.args || {};
    if (!manual && mode !== 'standard') return result(false, 'Standard select karo; mode change nahi kiya.');
    if (BLOCKED.has(action) || /(?:delete|clear|security|pin|exec|deploy)/i.test(action) || (action === 'app.open' && a.app === 'settings')) return result(false, 'Sir, ye operation AI ke liye disabled hai.');
    const read = action.endsWith('.list');
    if (!manual && !(read ? access().localRead : access().localEdit)) return result(false, 'Local AI access off hai.');
    if (['message.draft', 'call.dial'].includes(action) && !confirmed) return result(false, 'Confirmation chahiye', { pending: true });
    const kind = action.split('.')[0];
    if (read && (COLLECTIONS[kind] || kind === 'memory')) {
      if (!sync()) return result(false, 'Local records read nahi hue; purana mirror preserve hai. App dobara kholo.');
      const rows = list(kind);
      return result(true, rows.length ? rows.slice(0, 8).map(r => (r.title || r.text) + (r.at ? ' · ' + fmtDue(r.at).t : '') + (r.kind === 'work' ? ' · ' + (r.progress || 0) + '% · ' + (r.minutes || 0) + ' min' : '')).join('. ') : 'Koi ' + kind + ' record nahi hai.', { records: rows });
    }
    if (action === 'settings.update') return setting(a);
    if (action.startsWith('memory.')) {
      if (action === 'memory.add') { const t = text(a.text); if (!t) return result(false, 'Memory text chahiye.'); const r = { id: uid('mem'), text: t, ts: Date.now(), pin: false }; S.memories.unshift(r); changed(); return result(true, 'Memory save ho gayi', { record: r }); }
      if (action === 'memory.edit') { const r = target('memory', a); if (!r) return result(false, 'Ek unique memory ka naam ya ID batao.'); const t = text(a.text); if (!t) return result(false, 'Naya text chahiye.'); r.text = t; changed(); return result(true, 'Memory update ho gayi', { record: r }); }
      return result(false, 'Memory operation allowed nahi hai.');
    }
    if (native()) {
      try {
        const j = JSON.parse(N().runActions(JSON.stringify({ mode: 'standard', confirmed: !!confirmed, steps: [{ ...step, id: step.id || uid('s') }] })));
        const r = (j.results || [])[0];
        if (!r) return result(false, j.error || 'Phone ne result nahi diya.');
        sync(); if (r.ok) changed(); return r;
      } catch (e) { return result(false, 'Phone operation fail: ' + e.message); }
    }
    if (!COLLECTIONS[kind]) return result(false, 'Ye action sirf Android app mein chalta hai.');
    return browserRecord(action, a);
  }
  function browserRecord(action, a) {
    const kind = action.split('.')[0], op = action.split('.')[1];
    if (!['add', 'start', 'edit', 'done', 'log'].includes(op)) return result(false, 'Unsupported record operation.');
    if ((a.at != null && (typeof a.at !== 'number' || !Number.isFinite(a.at) || a.at <= Date.now())) || (a.progress != null && (typeof a.progress !== 'number' || a.progress < 0 || a.progress > 100)) || (a.minutes != null && (typeof a.minutes !== 'number' || a.minutes < 0 || a.minutes > 1440))) return result(false, 'Time/progress/minutes valid nahi hain.');
    let r;
    if (op === 'add' || op === 'start') {
      const title = text(a.title || a.text, kind === 'note' ? 600 : 120);
      if (!title) return result(false, 'Naam ya text chahiye.');
      if (['alarm', 'reminder'].includes(kind) && !a.at) return result(false, 'Time chahiye.');
      if (kind === 'timer' && (typeof a.seconds !== 'number' || a.seconds < 1 || a.seconds > 86400)) return result(false, 'Timer 1 second se 24 ghante tak ho sakta hai.');
      r = { id: uid(kind[0]), kind, title, text: title, created: Date.now(), updated: Date.now(), at: a.at || 0 };
      if (kind === 'task') r.done = false;
      if (kind === 'work') Object.assign(r, { category: text(a.category, 120), goal: text(a.goal), progress: 0, minutes: 0, outcome: '', entries: [] });
      if (kind === 'timer') r.at = Date.now() + a.seconds * 1000;
      list(kind).push(r);
    } else {
      r = target(kind, a); if (!r) return result(false, 'Ek unique record ka naam ya ID batao; kuch change nahi kiya.');
      if (op === 'done') { if (typeof a.done !== 'boolean') return result(false, 'Done true/false chahiye.'); r.done = a.done; if (a.done) cancelWeb(r.id); }
      else if (op === 'log') {
        const t = text(a.text); if (!t) return result(false, 'Work detail chahiye.');
        const e = { id: uid('entry'), text: t, date: a.date || new Date().toLocaleDateString('en-CA'), minutes: a.minutes || 0, outcome: text(a.outcome) };
        if (a.progress != null) { e.progress = a.progress; r.progress = a.progress; }
        (r.entries || (r.entries = [])).push(e); r.minutes = (r.minutes || 0) + e.minutes;
        if (e.outcome) r.outcome = e.outcome;
      } else {
        ['title', 'text', 'category', 'goal', 'outcome'].forEach(k => { if (a[k] != null) r[k] = text(a[k], k === 'title' ? 120 : 600); });
        if (a.title != null) r.text = r.title;
        if (a.text != null && kind !== 'work') r.title = r.text;
        if (a.at != null) { r.at = a.at; delete r.firedAt; }
        if (a.progress != null) r.progress = a.progress;
      }
      r.updated = Date.now();
    }
    if (kind === 'task') r.due = r.at || null;
    if (r.at) armWeb(r);
    changed();
    const warning = r.at && !r.done ? 'Browser mein alert sirf tab khula rehne par aayega.' : '';
    return result(true, kind + (op === 'add' || op === 'start' ? ' save ho gaya' : ' update ho gaya') + (r.at ? ' · ' + fmtDue(r.at).t : '') + (warning ? '. ' + warning : ''), { record: r, detail: r.id, warning });
  }
  async function manual(action, args) {
    if (native() && /^(task|reminder|alarm|timer)\./.test(action) && (args.at || args.seconds)) {
      try { const i = JSON.parse(N().actionInfo()); if (!i.notify) N().setNotify(true); } catch (e) {}
    }
    return run({ id: uid('manual'), action, args, risk: 'safe' }, false, true);
  }
  async function removeManual(id) {
    if (native() && N().recordsDelete) {
      try { const j = JSON.parse(N().recordsDelete(id)); sync(); changed(); return j; } catch (e) { return result(false, 'Delete nahi hua.'); }
    }
    Object.values(COLLECTIONS).forEach(k => { S[k] = S[k].filter(r => r.id !== id); }); cancelWeb(id); changed(); return result(true, 'Record delete ho gaya');
  }
  function exportRecords() { return Object.values(COLLECTIONS).flatMap(k => S[k]).map(safeRecord).filter(Boolean); }
  function importRecords(records) {
    if (!Array.isArray(records) || records.length > IMPORT_MAX_RECORDS || jsonBytes(records) > IMPORT_MAX_BYTES) return result(false, 'Backup records bahut bade ya zyada hain; import nahi hua.');
    const rows = [];
    for (const raw of records) {
      const r = importedRecord(raw);
      if (!r) return result(false, 'Backup me invalid ya bahut bada record mila; purana data preserve hai.');
      rows.push({ ...r, id: r.id || uid(r.kind), created: r.created || 1, updated: r.updated || r.created || 1 });
    }
    if (native() && N().recordsImport) { const r = JSON.parse(N().recordsImport(JSON.stringify({ records: rows }))); if (r.ok) { sync(); changed(); } return r; }
    rows.forEach(r => { if (r.kind === 'task') r.due = r.at || null; const a = list(r.kind), i = a.findIndex(x => x.id === r.id); if (i >= 0) a[i] = r; else a.push(r); armWeb(r); }); changed(); return result(true, 'Records restore ho gaye');
  }
  const onlineFields = ['id', 'kind', 'title', 'text', 'at', 'done', 'category', 'goal', 'progress', 'minutes', 'outcome'];
  function modelContext(query, chatId) {
    const a = access();
    if (!a.localRead || !a.personalOnline) return undefined;
    const low = query.toLowerCase();
    const relevant = /\b(my|mera|mere|meri|apne|apna|today|aaj|progress|brief|summary|summari[sz]e|plan|analy[sz]e|records?|tasks?|work|notes?|reminders?|memor(?:y|ies)|projects?|kaam|padhai)\b|old chat|purane chat|previous chat|pichli baat|past conversation/i.test(query);
    if (!relevant) return undefined;
    if (!sync()) return undefined;
    const kinds = [];
    if (/task|plan|today|aaj|brief/i.test(low)) kinds.push('task');
    if (/work|project|progress|kaam/i.test(low)) kinds.push('work');
    if (/notes?/i.test(low)) kinds.push('note');
    if (/reminder/i.test(low)) kinds.push('reminder');
    if (/alarm/i.test(low)) kinds.push('alarm');
    if (/memor|remember|meri preference/i.test(low)) kinds.push('memory');
    const tokens = low.match(/[\p{L}\p{N}]{3,}/gu) || [];
    const rows = [...new Set(kinds)].flatMap(k => list(k).map(r => ({ ...r, kind: k })));
    rows.sort((x, y) => {
      const score = r => tokens.reduce((n, w) => n + ((r.title || r.text || '').toLowerCase().includes(w) ? 1 : 0), 0);
      return score(y) - score(x) || (y.updated || y.created || y.ts || 0) - (x.updated || x.created || x.ts || 0);
    });
    const redact = v => v.replace(/\b(?:api[_ -]?key|password|secret|token|pin)\s*[:=]\s*\S+|\b(?:sk-|AIza)[\w-]{12,}/gi, '[redacted]');
    const selected = []; let size = 0;
    for (const r of rows.slice(0, 12)) {
      const out = {};
      onlineFields.forEach(k => { const v = r[k]; if (typeof v === 'string') out[k] = redact(v).slice(0, 240); else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v; });
      if (r.kind === 'work') out.entries = (r.entries || []).slice(-3).map(e => ({ date: e.date, minutes: e.minutes, text: redact(String(e.text || '')).slice(0, 160), progress: e.progress, outcome: redact(String(e.outcome || '')).slice(0, 160) }));
      const len = JSON.stringify(out).length; if (size + len > 2300) break; selected.push(out); size += len;
    }
    const old = [];
    if (a.oldChats && /old chat|purane chat|previous chat|pichli baat|past conversation/i.test(query)) {
      const chats = S.chats.filter(c => c.id !== chatId);
      const matches = chats.flatMap(c => c.msgs || []).filter(m => !m.localOnly && !(m.reply && (m.reply.origin === 'local-rule' || ['actions', 'blocked', 'clarification', 'task', 'memory'].includes(m.reply.type)))).filter(m => tokens.some(w => (m.text || (m.reply ? speechOf(m.reply) : '')).toLowerCase().includes(w))).slice(-3);
      matches.forEach(m => old.push({ role: m.role === 'user' ? 'user' : 'assistant', text: redact(m.text || (m.reply ? speechOf(m.reply) : '')).slice(0, 180) }));
    }
    return selected.length || old.length ? { records: selected, oldChats: old } : undefined;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); Bus.emit('records:changed'); } });
  return { init, sync, list, run, manual, removeManual, access, modelContext, exportRecords, importRecords, safeRecord, native };
})();
