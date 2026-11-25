'use strict';
/* 04-views.js : App shell (navigation, drawer, theme) + Today, Tasks, Memory, Philosophy, Settings */

const ABILITIES = [
  { id: 'research', ic: 'globe', name: 'Research & verify', desc: 'Kai sources dekhkar har claim check karta hai.', try: 'Research whether intermittent fasting really improves focus' },
  { id: 'debate', ic: 'chat', name: 'Debate', desc: 'Dono paksh, phir faisla.', try: 'Debate: should I learn Rust or Go first?' },
  { id: 'patterns', ic: 'search2', name: 'Patterns & connections', desc: 'Notes, chats aur memory mein pattern dhoondta hai.', try: 'What patterns do you see in my last week of notes?' },
  { id: 'memory', ic: 'brain', name: 'Memory', desc: 'Batayi baatein yaad rakhta hai.', try: 'Remember that I prefer short answers in Hinglish' },
  { id: 'tasks', ic: 'tasks', name: 'Local productivity', desc: 'Tasks (time ke saath reminder), Alarms, Notes aur Work.', try: 'task add karo kal 11 baje bank jana' },
  { id: 'proactive', ic: 'bell', name: 'Proactive briefings', desc: 'Subah ki briefing aur due-task alerts.', try: 'Brief me on today' },
  { id: 'selfeng', ic: 'code', name: 'Architecture (read-only)', desc: 'Apna architecture samjhata hai; code nahi badalta.', try: 'Tumhara architecture kaise kaam karta hai?' }
];
const isOn = () => true;  // Abilities page removed (v1.0.71): every ability stays on
const enabledAbilities = () => ABILITIES.filter(a => isOn(a.id)).map(a => a.id);

const App = (() => {
  let view = 'chat'; const root = () => $('#phone');
  const NAV = [['chat', 'chat', 'Chat'], ['today', 'sun', 'Today'], ['tasks', 'tasks', 'Tasks'], ['work', 'book', 'Work'], ['alarms', 'cal', 'Alarms & timers'], ['notes', 'file', 'Notes'], ['library', 'brain', 'Memory'], ['philosophy', 'sparkle', 'Philosophy']];
  const TITLES = { today: 'Today', tasks: 'Tasks', work: 'Work', alarms: 'Alarms & timers', notes: 'Notes', library: 'Memory', philosophy: 'Philosophy', settings: 'Settings' };
  const BUILD = {};
  let q = '';

  function applyTheme() {
    const r = document.documentElement; const t = S.settings.theme;
    if (t === 'light' || t === 'dark') r.setAttribute('data-theme', t); else r.removeAttribute('data-theme');
    r.setAttribute('data-font', S.settings.font);
  }
  function show(name) {
    view = name; $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + name));
    if (name === 'settings' && BackgroundVoice.active()) BackgroundVoice.stop('Settings opened. Restart background voice after changes.');
    drawer(false); if (name !== 'chat') build(name); else Chat.renderThread();
    drawerList();
  }
  function build(name) {
    const el = $('#v-' + name); el.textContent = '';
    const body = h('div', { class: 'scroll pad' }, h('div', { class: 'stack' }));
    const stack = body.firstChild;
    el.append(h('header', { class: 'hdr pad' }, ibtn('back', 'Back to chat', () => show('chat')), h('h1', {}, TITLES[name]), name === 'settings' ? h('span') : ibtn('sliders', 'Settings', () => show('settings'))), body);
    BUILD[name](stack, () => build(name));
  }
  function drawer(open) {
    root().classList.toggle('open', open);
    if (open) { drawerList(); } else q = '';
  }
  function buildDrawer() {
    const d = $('#drawer'); d.textContent = '';
    const top = h('div', { class: 'd-top pad' });
    const searching = () => top.classList.contains('s');
    const draw = () => {
      top.textContent = '';
      if (searching()) {
        const inp = h('input', { type: 'text', placeholder: 'Search chats', 'aria-label': 'Search chats', value: q, on: { input: () => { q = inp.value; drawerList(); } } });
        top.append(inp, ibtn('x', 'Close search', () => { top.classList.remove('s'); q = ''; draw(); drawerList(); })); setTimeout(() => inp.focus(), 30);
      } else top.append(h('span', { class: 'wm' }, 'ADARSH'), ibtn('search', 'Search chats', () => { top.classList.add('s'); draw(); }), ibtn('x', 'Close menu', () => drawer(false)));
    };
    draw();
    const nav = h('nav', { class: 'd-nav pad' }, NAV.map(([id, ic, t]) => h('button', { 'data-nav': id, on: { click: () => show(id) } }, icon(ic), t,
      id === 'tasks' ? h('span', { class: 'badge', id: 'bg-tasks' }) : null)));
    d.append(top, nav, h('div', { class: 'rule pad' }), h('div', { class: 'd-list pad', id: 'd-list' }),
      h('div', { class: 'd-foot pad' },
        h('button', { class: 'acct', 'aria-label': 'Settings', on: { click: () => show('settings') } }, h('span', { class: 'avatar' }, (S.settings.name || 'A')[0].toUpperCase()),
          h('span', { class: 'an' }, h('b', {}, S.settings.name || 'Adarsh'), h('small', {}, 'Settings'))),
        h('button', { class: 'fab', on: { click: () => { Chat.newChat(); show('chat'); Chat.renderThread(); } } }, icon('plus', 's'), 'New chat')));
    const sc = $('#scrim'); if (sc) sc.onclick = () => drawer(false);
  }
  const bucket = (ts) => {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0); const day = 864e5, t = t0.getTime();
    return ts >= t ? 'Today' : ts >= t - day ? 'Yesterday' : ts >= t - 7 * day ? 'Previous 7 days' : 'Earlier';
  };
  function drawerList() {
    const list = $('#d-list'); if (!list) return; list.textContent = '';
    $$('#drawer [data-nav]').forEach(b => b.setAttribute('aria-current', String(b.dataset.nav === view)));
    const openT = S.tasks.filter(t => !t.done).length, liveM = S.missions.filter(m => m.status === 'running').length;
    const bt = $('#bg-tasks'), bm = $('#bg-ms'); if (bt) bt.textContent = openT || ''; if (bm) bm.textContent = liveM || '';
    const cs = S.chats.filter(c => c.msgs.length && (!q || c.title.toLowerCase().includes(q.toLowerCase()))).sort((x, y) => (y.ts || 0) - (x.ts || 0));
    if (!cs.length) { list.append(h('div', { class: 'd-empty' }, q ? 'No chats match.' : 'No chats yet. Start one with New chat.')); return; }
    let lastGroup = '';
    cs.forEach(c => {
      const g = bucket(c.ts || 0);
      if (g !== lastGroup) { list.append(h('div', { class: 'd-group' }, g)); lastGroup = g; }
      list.append(h('div', { class: 'rc', role: 'button', tabindex: '0', 'aria-current': String(c.id === S.cur && view === 'chat'), on: { click: () => Chat.open(c.id), keydown: (e) => { if (e.key === 'Enter') Chat.open(c.id); } } },
        h('span', {}, c.title), h('button', { class: 'del', 'aria-label': 'Delete chat', on: { click: (e) => { e.stopPropagation(); Chat.remove(c.id); } } }, icon('trash', 's'))));
    });
  }
  /* run something in chat from anywhere */
  const ask = (text) => { show('chat'); Chat.submit(text); };
  const draft = (text) => { show('chat'); Chat.setDraft(text); };
  Bus.on('chats:changed', drawerList); Bus.on('missions:changed', drawerList);
  Bus.on('reply', () => drawerList());

  /* ================= Today ================= */
  BUILD.today = (st) => {
    const now = new Date();
    st.append(h('div', { class: 'today-hero' }, h('h2', {}, greeting() + ', ' + (S.settings.name || 'Adarsh')), h('p', {}, now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))));
    const Q = (ic, t, fn) => h('button', { class: 'qbtn', on: { click: fn } }, icon(ic), h('b', {}, t));
    st.append(h('div', { class: 'qgrid' },
      Q('sun', 'Brief me', () => ask('Brief me on today')), Q('cal', 'Plan my day', () => ask('Plan my day around my open tasks')),
      Q('globe', 'Research', () => draft('Research ')), Q('book', 'Work', () => show('work'))));
    const open = S.tasks.filter(t => !t.done).sort((a, b) => (a.due || 9e15) - (b.due || 9e15)).slice(0, 4);
    st.append(h('div', { class: 'sech' }, 'Due soon', h('button', { on: { click: () => show('tasks') } }, 'See all')));
    st.append(open.length ? h('div', { class: 'grp' }, open.map(t => { const f = fmtDue(t.due); return h('button', { class: 'item', on: { click: () => show('tasks') } }, icon('tasks'), h('span', { class: 't' }, h('b', { style: 'font-weight:500' }, t.title), f.t ? h('small', {}, f.t) : null)); }))
      : h('div', { class: 'item' }, h('span', { class: 't', style: 'color:var(--muted)' }, 'Kuch due nahi')));
    const pins = S.memories.filter(m => m.pin).slice(0, 3);
    if (pins.length) { st.append(h('div', { class: 'sech' }, 'Pinned memory')); st.append(h('div', { class: 'grp' }, pins.map(m => h('div', { class: 'item' }, icon('pin'), h('span', { class: 't' }, m.text))))); }
    const sugg = (Backend.suggestions && !Backend.isDemo()) ? Backend.suggestions() : [];
    if (sugg.length) {
      st.append(h('div', { class: 'sech' }, 'Suggested'));
      st.append(h('div', { class: 'grp' }, sugg.map(s => h('button', { class: 'item sug', on: { click: () => ask(s.prompt) } }, icon(s.ic || 'bolt'), h('span', { class: 't' }, h('b', { style: 'font-weight:500' }, s.title), h('small', {}, s.sub)), icon('chev', 'chev')))));
    }
  };

  /* ================= Tasks ================= */
  ['tasks', 'work', 'alarms', 'notes'].forEach(k => { BUILD[k] = ProductivityViews[k]; });
  Bus.on('records:changed', () => { drawerList(); if (['tasks', 'work', 'alarms', 'notes', 'today', 'library'].includes(view)) build(view); });

  Bus.on('missions:changed', () => { if (view === 'tasks') build('tasks'); });

  /* ================= Memory ================= */
  BUILD.library = (st, redraw) => {
    const inp = h('input', { type: 'text', placeholder: 'Add something to remember', 'aria-label': 'New memory' });
    const add = () => { const t = inp.value.trim(); if (!t) return; S.memories.unshift({ id: uid('mem'), text: t, pin: false, ts: Date.now() }); save(); redraw(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    st.append(h('div', { class: 'addbar', style: 'padding:0' }, inp, h('button', { class: 'go', on: { click: add } }, 'Save')));
    if (!S.memories.length) st.append(h('div', { class: 'empty' }, icon('brain'), h('div', {}, 'Khaali')));
    const sorted = [...S.memories].sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0));
    sorted.forEach((m, i) => st.append(h('div', { class: 'mem' }, h('span', { class: 'id' }, '#' + (S.memories.length - S.memories.indexOf(m))), h('p', {}, m.text),
      h('button', { 'aria-label': m.pin ? 'Unpin' : 'Pin', 'aria-pressed': String(!!m.pin), on: { click: () => { m.pin = !m.pin; save(); redraw(); } } }, icon('pin', 's')),
      h('button', { 'aria-label': 'Delete memory', on: { click: () => { const k = S.memories.indexOf(m); S.memories.splice(k, 1); save(); redraw(); toast('Memory deleted', { action: () => { S.memories.splice(k, 0, m); save(); if (view === 'library') redraw(); } }); } } }, icon('trash', 's')))));
  };

  /* ================= Philosophy =================
     The user's own principles. Saved only on this phone; sent with every answer request (all modes, live voice and
     background voice) so the model follows it. Never edited by the AI. */
  const PHILOSOPHY_MAX = 3000;
  BUILD.philosophy = (st) => {
    const ta = h('textarea', { rows: '12', maxlength: String(PHILOSOPHY_MAX), 'aria-label': 'Meri philosophy', placeholder: 'Usool, soch, priorities…',
      style: 'width:100%;min-height:260px;padding:14px;border-radius:14px;background:var(--card);color:var(--fg);border:0;font:inherit;line-height:1.5;resize:vertical' });
    ta.value = S.philosophy || '';
    const count = h('small', { class: 'muted' });
    const paint = () => { count.textContent = ta.value.length + ' / ' + PHILOSOPHY_MAX; };
    ta.addEventListener('input', paint); paint();
    const saveIt = () => { S.philosophy = ta.value.trim().slice(0, PHILOSOPHY_MAX); save(); toast(S.philosophy ? 'Philosophy save ho gayi' : 'Philosophy khaali hai'); };
    st.append(ta,
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' }, count, h('button', { class: 'btn pri', on: { click: saveIt } }, 'Save')));
  };

  /* ================= Settings ================= */
  const swItem = (ic, title, sub, get, set) => h('button', { class: 'item', role: 'switch', 'aria-checked': String(!!get()), on: { click: (e) => { set(!get()); save(); e.currentTarget.setAttribute('aria-checked', String(!!get())); } } },
    icon(ic), h('span', { class: 't' }, title, sub ? h('small', {}, sub) : null), h('span', { class: 'sw' }));
  const navItem = (ic, title, sub, fn) => h('button', { class: 'item', 'aria-label': title, on: { click: fn } }, icon(ic), h('span', { class: 't' }, title, sub ? h('small', {}, sub) : null), icon('chev', 'chev'));
  BUILD.settings = (st, redraw) => {
    const label = (t) => h('div', { class: 'glabel' }, t);
    st.append(h('button', { class: 'prof', on: { click: nameSheet } }, h('span', { class: 'avatar' }, (S.settings.name || 'A')[0].toUpperCase()), h('span', { class: 't' }, h('b', {}, S.settings.name || 'Adarsh'), null), icon('chev', 'chev')));
    const seg = (opts, get, set) => h('div', { class: 'seg' }, opts.map(([v, l]) => h('button', { 'aria-pressed': String(get() === v), on: { click: () => { set(v); save(); redraw(); } } }, l)));
    st.append(label('Appearance'),
      h('div', { class: 'themes' }, [['light', 'Light', 'tl'], ['dark', 'Dark', 'td'], ['system', 'Auto', 'ts']].map(([v, l, c]) => h('button', { class: c, 'aria-pressed': String(S.settings.theme === v), on: { click: () => { S.settings.theme = v; save(); applyTheme(); redraw(); } } }, h('span', { class: 'tile' }, h('i')), l))),
      h('div', { class: 'glabel', style: 'padding:6px 2px 0' }, 'Reply font'), seg([['serif', 'Serif'], ['sans', 'Sans']], () => S.settings.font, v => { S.settings.font = v; applyTheme(); }));
    st.append(label('Assistant'), h('div', { class: 'grp' },
      navItem('sliders', 'Answer source', ({ auto: 'Auto', manual: 'Manual', hybrid: 'Hybrid' })[S.settings.source || 'auto'], () => Chat.sourceSheet()),
      navItem('edit', 'Reply style', replySummary(), replySheet),
      swItem('globe', 'Built-in web search', '', () => S.settings.webSearch !== false, v => { S.settings.webSearch = v; toast(v ? 'Web search on' : 'Web search off'); }),
      swItem('search', 'Research sources', '14 providers', () => S.settings.research !== false, v => { S.settings.research = v; toast(v ? 'Sources on' : 'Sources off'); }),
      navItem('book', 'Lessons', '', () => Lessons.listSheet()),
      navItem('mic', 'Voice & language', (S.settings.voiceEngine === 'device' ? 'Phone' : (S.settings.voiceName || 'Orus')) + ' · ' + S.settings.lang, voiceSheet)));
    st.append(label('System'), h('div', { class: 'grp' },
      navItem('refresh', 'App updates', '', () => MobileUpdates.open())));
    st.append(label('Alerts'), h('div', { class: 'grp' },
      swItem('bell', 'Notifications', '', () => S.settings.notif, async (v) => {
        S.settings.notif = v;
        if (window.AdarshNative && AdarshNative.setNotify) {   // Android: the app posts the notification itself
          let r = ''; try { r = AdarshNative.setNotify(v); } catch (e) {}
          if (r === 'denied') { S.settings.notif = false; save(); toast('Permission blocked · phone Settings me allow karo'); redraw(); }
          else if (r === 'granted') toast('Notifications on');
        } else if (v && window.Notification && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) {} }
      }),
      swItem('kbd', 'Haptics', '', () => S.settings.haptics, v => { S.settings.haptics = v; if (v) vibe(30); })));
    st.append(label('Adarsh'), h('div', { class: 'grp' },
      navItem('shield', 'AI access', '', aiAccessSheet)));
    st.append(label('Security'), h('div', { class: 'grp' },
      navItem('lock', 'App lock (PIN)', S.lock ? 'On' : 'Off', () => Lock.manage(redraw)),
      S.lock ? swItem('shield', 'App chhupne par lock', '30 s', () => S.settings.lockOnHide, v => { S.settings.lockOnHide = v; }) : null,
      window.AdarshKeys ? navItem('lock', 'API keys', keysSummary(), keysSheet) : null,
      navItem('server', 'Connection', Backend.isNative() ? 'On-device' : Backend.isDemo() ? 'Demo' : (S.conn.url || 'Server'), connSheet)));
    st.append(label('Data'), h('div', { class: 'grp' },
      navItem('download', 'Export data', '', exportSheet),
      navItem('upload', 'Import data', '', () => $('#f-import').click()),
      navItem('trash', 'Clear all chats', '', () => confirmSheet({ title: 'Saari chats clear karein?', text: 'Memory aur tasks rahenge.', label: 'Clear', danger: true, onYes: () => { S.chats = []; S.cur = null; save(); Chat.renderThread(); drawerList(); toast('Chats cleared'); } }))));

  };
  function nameSheet() {
    sheet({ title: 'Your name', build(b, close) {
      const i = h('input', { type: 'text', value: S.settings.name || '', 'aria-label': 'Name' });
      b.append(i, h('button', { class: 'btn pri', on: { click: () => { S.settings.name = i.value.trim() || 'Adarsh'; save(); close(); buildDrawer(); drawerList(); build('settings'); } } }, 'Save'));
    } });
  }
  function aiAccessSheet() {
    sheet({ title: 'AI access', tall: true, build(b) {
      const rows = [
        ['localRead', 'Records read', 'Tasks, Work, Notes, Memory'],
        ['localEdit', 'Add / edit', 'Save, edit, complete'],
        ['personalOnline', 'Share context online', 'Har sawaal par'],
        ['oldChats', 'Old chats', 'Purani chats padhna'],
        ['currentChat', 'Current chat', 'Follow-up context'],
        ['architecture', 'Architecture', 'Read-only']
      ];
      b.append(h('div', { class: 'grp' }, rows.map(([key, title, sub]) => swItem('shield', title, sub, () => Productivity.access()[key], v => { S.settings.aiAccess = { ...Productivity.access(), [key]: v }; }))));
      b.append(h('p', { class: 'muted' }, 'AI edit kar sakta hai · delete, keys aur PIN kabhi nahi.'));
    } });
  }
  function architectureSheet() {
    sheet({ title: 'Architecture · read-only', tall: true, build(b) {
      const output = h('div', {}, h('p', {}, 'Reference padh raha hoon…')); b.append(output);
      Backend.send({ architecture: true, mode: Modes.current().id, access: Productivity.access() }, { onProgress: () => {} }).then(r => {
        output.replaceChildren(); const d = Array.isArray(r) ? r[0] : r;
        if (!d || !d.reference) { output.append(h('p', {}, (d && d.text) || 'Is backend mein reference available nahi hai.')); return; }
        output.append(h('p', {}, 'Code read-only reference. Koi write, deploy ya arbitrary file access nahi.'), h('p', { class: 'muted' }, 'Selected mode: ' + Modes.current().name));
        (d.reference.modules || []).forEach(m => output.append(h('div', { class: 'item' }, h('span', { class: 't' }, h('b', {}, m.path), h('small', {}, m.purpose)))));
        output.append(h('details', {}, h('summary', {}, 'Model plans / voice / boundaries'), h('pre', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px' }, JSON.stringify(d.reference, null, 2))));
      }).catch(e => output.replaceChildren(h('p', {}, 'Reference nahi khula: ' + e.message)));
    } });
  }
  /* V6: offline neural voice pack (Hindi + English male, ~42 MB once). Only shown inside the Android app. */
  function offlineBlock() {
    const N = window.AdarshNative;
    if (!N || !N.neuralStatus) return null;
    const msg = h('p', { class: 'muted' }); const btn = h('button', { class: 'btn ghost', on: { click: () => { try { N.neuralInstall(); } catch (e) {} paint(); poll(); } } }, 'Download');
    const st = () => { try { return JSON.parse(N.neuralStatus()); } catch (e) { return {}; } };
    function paint() {
      const s = st();
      if (s.installing) { msg.textContent = 'Downloading · ' + (s.progress || 0) + '%'; btn.disabled = true; return; }
      btn.disabled = false;
      if (s.hi && s.en) { msg.textContent = 'Ready · offline'; btn.hidden = true; }
      else msg.textContent = s.error ? 'Fail · ' + s.error : 'Piper · ~42 MB';
    }
    function poll() { paint(); if (st().installing) setTimeout(poll, 800); }
    window.__adarshNeural = () => paint();
    paint();
    return h('div', { class: 'fld' }, h('label', { class: 'l' }, 'Offline voice'), h('div', { class: 'inline' }, msg, btn));
  }
  function voiceSheet() {
    sheet({ title: 'Voice & language', tall: true, build(b) {
      const segOf = (opts, get, set) => {
        const seg = h('div', { class: 'seg' });
        opts.forEach(([v, l]) => seg.append(h('button', { 'aria-pressed': String(get() === v), on: { click: (e) => { set(v); save(); [...seg.children].forEach(x => x.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); } } }, l)));
        return seg;
      };
      const rate = h('input', { type: 'range', min: '0.7', max: '1.4', step: '0.05', value: String(S.settings.rate), 'aria-label': 'Speaking speed', on: { change: () => { S.settings.rate = +rate.value; save(); } } });
      const bnrSupported = !!(window.AdarshNative && window.AdarshNative.bnrSupported && window.AdarshNative.bnrSupported());
      const bnrFunctionId = h('input', { type: 'text', value: S.settings.bnrFunctionId || '', placeholder: 'NVIDIA BNR Function ID', 'aria-label': 'NVIDIA BNR Function ID', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', on: { change: () => { S.settings.bnrFunctionId = bnrFunctionId.value.trim(); save(); } } });
      const pick = h('select', { 'aria-label': 'Natural voice', style: 'width:100%;padding:12px;border-radius:14px;background:var(--card);color:var(--fg);border:0;font:inherit', on: { change: () => { S.settings.voiceName = pick.value; save(); TTS.speak('Namaste, main Adarsh hoon. Ye meri nayi awaaz hai.'); } } },
        TTS.VOICES.map(([v, d]) => { const o = h('option', { value: v }, v + ' · ' + d); if ((S.settings.voiceName || 'Orus') === v) o.selected = true; return o; }));
      const status = h('p', { class: 'muted' });
      /* phone TTS voices come from the system engine: names are cryptic, so the gender is shown and each tap is spoken */
      const devPick = (() => {
        const A = window.AdarshNative;
        if (!(A && A.ttsVoices)) return null;
        let list = [];
        try { list = JSON.parse(A.ttsVoices()) || []; } catch (e) { list = []; }
        if (!list.length) return null;
        const sel = h('select', { 'aria-label': 'Phone voice', style: 'width:100%;padding:12px;border-radius:14px;background:var(--card);color:var(--fg);border:0;font:inherit',
          on: { change: () => {
            S.settings.deviceVoice = sel.value === '__auto' ? '' : sel.value; save();
            try { A.ttsSetVoice(S.settings.deviceVoice || ''); } catch (e) {}
            try { A.ttsSpeak('pv' + Date.now(), 'Namaste Sir, ye phone ki awaaz hai.', S.settings.lang, +S.settings.rate || 1); } catch (e) {}
          } } },
          h('option', { value: '__auto' }, 'Auto · best available (male preferred)'));
        list.forEach(v => {
          const o = h('option', { value: v.name }, v.name + (v.gender ? ' · ' + v.gender : '') + ' · ' + v.locale + (v.network ? ' · net' : ''));
          if ((S.settings.deviceVoice || '') === v.name) o.selected = true;
          sel.append(o);
        });
        if (!S.settings.deviceVoice) sel.value = '__auto';
        return h('div', { class: 'fld' }, h('label', { class: 'l' }, 'Phone voice'), sel);
      })();
      const note = () => {
        const n = Backend.canTts() && !Backend.isDemo();
        status.textContent = n ? '' : 'Natural voice is backend mein nahi hai.';
        if (TTS.info.last === 'device' && TTS.info.why) status.textContent = 'Phone voice · natural fail (' + TTS.info.why + ')';
      };
      note();
      /* Adarsh Live: Gemini Live socket on the voice screen only (never background, never Standard text chat). */
      const liveNative = !!(window.AdarshNative && window.AdarshNative.liveStart);
      const livePick = h('select', { 'aria-label': 'Adarsh Live model', style: 'width:100%;padding:12px;border-radius:14px;background:var(--card);color:var(--fg);border:0;font:inherit',
        on: { change: () => { S.settings.liveModel = livePick.value; save(); } } },
        (typeof LIVE_MODELS !== 'undefined' ? LIVE_MODELS : []).map(([v, l]) => { const o = h('option', { value: v }, l); if ((S.settings.liveModel || 'auto') === v) o.selected = true; return o; }));
      const liveBlock = liveNative ? [
        h('div', { class: 'grp' },
          swItem('voice', 'Adarsh Live', 'Live voice', () => S.settings.adarshLive === true, v => { S.settings.adarshLive = v; if (!v && Live) Live.stop(); })),
        S.settings.adarshLive ? h('div', { class: 'fld' }, h('label', { class: 'l' }, 'Live model'), livePick,
          (() => { const out = h('p', { class: 'muted' }, ''); const btn = h('button', { class: 'btn ghost', on: { click: () => {
            out.textContent = 'Testing…';
            const lines = [];
            Live.start({ onState: (s, m, ev) => { if (s === 'connecting' && ev && ev.attempt) out.textContent = 'Connecting ' + ev.attempt + '/' + ev.total; if (s === 'listening') { lines.push('Live on' + (m ? ' · ' + m : '')); out.textContent = lines.join(' · '); } },
              onProbe: (m) => { lines.push('Key: ' + m); out.textContent = lines.join(' · '); },
              onNotice: (m) => { lines.push(m); out.textContent = lines.join(' · '); },
              onError: (m) => { lines.push('Live: ' + m); out.textContent = lines.join(' · '); Live.stop(); },
              onClosed: () => {} });
            Live.probe({ onProbe: (m) => { lines.push('Key: ' + m); out.textContent = lines.join(' · '); } });
            setTimeout(() => { if (Live.isOn) { Live.stop(); if (!out.textContent || /Testing/.test(out.textContent)) out.textContent = 'Live connected.'; } }, 8000);
          } } }, 'Test'); return h('div', { class: 'inline' }, btn, out); })()) : null
      ] : [];
      const kids = [
        swItem('speaker', 'Chat jawab bolkar sunao', '', () => S.settings.speak, v => { S.settings.speak = v; if (!v) TTS.stop(); }),
        ...liveBlock,
        h('label', { class: 'l' }, 'Voice engine'),
        segOf([['auto', 'Auto'], ['natural', 'Natural'], ['device', 'Phone']], () => S.settings.voiceEngine || 'auto', v => { S.settings.voiceEngine = v; }),
        h('p', { class: 'muted' }, 'Auto: natural, fail par phone.'),
        h('label', { class: 'l' }, 'Natural voice'), pick,
        devPick,
        h('label', { class: 'l' }, 'Language'),
        segOf([['hi-IN', 'Hindi'], ['en-IN', 'English (IN)'], ['en-US', 'English (US)']], () => S.settings.lang, v => { S.settings.lang = v; }),
        h('label', { class: 'l' }, 'Speed'), rate,
        bnrSupported ? h('div', { class: 'grp' }, swItem('mic', 'Noise removal (NVIDIA)', 'Online', () => !!S.settings.bnr, v => { S.settings.bnr = v; })) : null,
        bnrSupported ? h('div', { class: 'fld' }, h('label', { class: 'l' }, 'NVIDIA Function ID'), bnrFunctionId) : null,
        offlineBlock(),
        TTS.ok() ? h('button', { class: 'btn pri', on: { click: () => { status.textContent = 'Bol raha hoon…'; TTS.speak('Namaste! Main Adarsh hoon. Aap jo bhi poochoge, main seedha aur saaf jawab dunga.', note); } } }, 'Test voice') : null,
        status
      ];
      b.append(...kids.filter(Boolean));
    } });
  }
  function replySummary() {
    const L = { auto: 'Auto language', hinglish: 'Hinglish', english: 'English', hindi: 'Hindi' }, D = { simple: 'Simple', normal: 'Normal', detailed: 'Detailed' };
    return (L[S.settings.replyLang || 'auto'] || 'Auto') + ' · ' + (D[S.settings.depth || 'normal'] || 'Normal') + ' · ' + (S.settings.think === 'deep' ? 'Deep' : 'Fast');
  }
  function replySheet() {
    sheet({ title: 'Reply style', build(b) {
      const group = (title, key, def, opts, note) => {
        const seg = h('div', { class: 'seg' });
        opts.forEach(([v, label]) => seg.append(h('button', { 'aria-pressed': String((S.settings[key] || def) === v), on: { click: () => {
          S.settings[key] = v; save();
          [...seg.children].forEach(x => x.setAttribute('aria-pressed', 'false'));
          seg.children[opts.findIndex(o => o[0] === v)].setAttribute('aria-pressed', 'true');
          if (view === 'settings') build('settings');
        } } }, label)));
        const kids = [h('label', { class: 'l' }, title), seg];
        if (note) kids.push(h('p', { class: 'muted' }, note));
        b.append(...kids);
      };
      group('Language', 'replyLang', 'auto', [['auto', 'Auto'], ['hinglish', 'Hinglish'], ['english', 'English'], ['hindi', 'Hindi']],
        'Sawaal ki bhasha.');
      group('Council', 'think', 'fast', [['fast', 'Fast'], ['deep', 'Deep']],
        'Deep = zyada models, slow.');
      group('Depth', 'depth', 'normal', [['simple', 'Simple'], ['normal', 'Normal'], ['detailed', 'Detailed']],
        '');
    } });
  }
  function keysSummary() {
    const K = window.AdarshKeys, st = K.status(); const ok = id => !!(st[id] && st[id].set);
    /* a Cloudflare slot counts when it has a token and an Account ID (its own, or slot 1's) */
    const slotOk = (g, n) => ok(K.slotId(g.base, n)) && (!g.idBase || ok(K.slotId(g.idBase, n)) || ok(g.idBase));
    let providers = 0, keys = 0;
    (K.groups || []).forEach(g => { const c = [1, 2, 3].filter(n => slotOk(g, n)).length; keys += c; if (c) providers++; });
    return providers ? providers + '/5 providers · ' + keys + ' keys' : 'No keys';
  }
  function keysSheet() {
    // Save / Delete keep the sheet open: it redraws in place (same open groups, same scroll), so several keys can be
    // saved one after another without going back each time.
    sheet({ title: 'API keys', tall: true, build(b) { render(true); function render(first) {
      const K = window.AdarshKeys, st = K.status();
      if (first && st._notice) toast(st._notice);
      const keepOpen = new Set([...b.querySelectorAll('details.keygrp')].filter(d => d.open).map(d => d.getAttribute('data-g')));
      const scrollers = [b, b.parentElement].filter(Boolean).map(el => [el, el.scrollTop]);
      b.textContent = '';
      b.append(h('p', { class: 'muted' }, 'Encrypted on this phone · 3 keys per provider, 1 → 2 → 3'));
      const done = (r, msg) => { if (r && r.ok) { toast(msg); render(false); if (view === 'settings') build('settings'); } else toast((r && r.error) || 'Failed'); };
      const field = (id, label, plain) => {
        const cur = st[id] || {};
        return h('input', { type: plain ? 'text' : 'password', placeholder: cur.set ? label + ': saved (' + cur.hint + '). Paste to replace' : 'Paste ' + label, 'aria-label': label, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
      };
      (K.groups || []).forEach(g => {
        const anySet = [1, 2, 3].some(n => (st[K.slotId(g.base, n)] || {}).set);
        const open = first ? (anySet || g.name === 'Groq') : keepOpen.has(g.name);
        const box = h('details', { class: 'keygrp', 'data-g': g.name, open: open ? '' : null },
          h('summary', { class: 'l' }, g.name + ' · ' + [1, 2, 3].filter(n => (st[K.slotId(g.base, n)] || {}).set).length + '/3'));
        [1, 2, 3].forEach(n => {
          const keyId = K.slotId(g.base, n), idId = g.idBase ? K.slotId(g.idBase, n) : null;
          const keyIn = field(keyId, g.name + (g.idBase ? ' token ' : ' key ') + n, false);
          const idIn = idId ? field(idId, g.name + ' Account ID ' + n, true) : null;
          const isSet = (st[keyId] || {}).set || (idId && (st[idId] || {}).set);
          const kids = [h('label', { class: 'l' }, 'Key ' + n), keyIn];
          if (idIn) kids.push(idIn);
          kids.push(h('div', { class: 'frow' },
              h('button', { class: 'btn pri', style: 'flex:1', on: { click: () => {
                const v = keyIn.value.trim(), acc = idIn ? idIn.value.trim() : '';
                if (!v && !acc) return toast('Key paste karo');
                let r = { ok: true };
                if (acc) r = K.save(idId, acc);
                if (r && r.ok && v) r = K.save(keyId, v);
                done(r, g.name + ' key ' + n + ' saved');
              } } }, 'Save'),
              isSet ? h('button', { class: 'btn ghost', style: 'flex:1', on: { click: () => {
                let r = (st[keyId] || {}).set ? K.remove(keyId) : { ok: true };
                if (r && r.ok && idId && (st[idId] || {}).set) r = K.remove(idId);
                done(r, g.name + ' key ' + n + ' deleted');
              } } }, 'Delete') : null));
          box.append(...kids);
        });
        b.append(box);
      });
      K.providers.filter(p => !p.group).forEach(p => {
        const cur = st[p.id] || {};
        const inp = field(p.id, p.name, p.plain);
        b.append(h('label', { class: 'l' }, p.name + ' · ' + p.url), inp,
          h('div', { class: 'frow' },
            h('button', { class: 'btn pri', style: 'flex:1', on: { click: () => { const v = inp.value.trim(); if (!v) return toast('Paste a key first'); done(K.save(p.id, v), p.name + ' key saved'); } } }, 'Save'),
            cur.set ? h('button', { class: 'btn ghost', style: 'flex:1', on: { click: () => done(K.remove(p.id), p.name + ' key deleted') } }, 'Delete') : null));
      });
      const res = h('p', { style: 'white-space:pre-wrap;user-select:text' });
      b.append(h('button', { class: 'btn ghost', on: { click: async () => {
        res.textContent = 'Testing…';
        try { const r = await window.ADARSH_BACKEND.send({ diagnose: true }, {}); res.textContent = String((r && r.text) || '').replace(/\*\*/g, ''); }
        catch (e) { res.textContent = 'Test failed: ' + e.message; }
      } } }, 'Test connection'), res);
      scrollers.forEach(([el, y]) => { el.scrollTop = y; });
    } } });
  }
  /* Android: there is no server to point at. Show what the on-device engine is really doing. */
  function engineSheet() {
    sheet({ title: 'On-device engine', tall: true, build(b) {
      const B = window.ADARSH_BACKEND, st = B.status ? B.status() : {};
      const row = (k, v) => h('div', { class: 'item' }, h('span', { class: 't' }, h('b', { style: 'font-weight:500' }, k), h('small', {}, v)));
      const p = st.providers || {}; const on = Object.keys(p).filter(k => p[k]);
      const v = st.voice || {};
      b.append(h('div', { class: 'grp' },
          row('Engine', st.ready ? 'On-device · Python ' + (st.python || '?') : st.error ? 'Error · ' + st.error : 'Starting…'),
          row('Providers', on.length ? on.join(', ') : 'None'),
          row('Natural voice', v.gemini ? 'Ready' : v.groq_english ? 'English only' : 'Phone voice'),
          row('Plan', (st.plan_problems || []).length ? st.plan_problems.slice(0, 3).join('; ') : 'Valid')));
      const res = h('p', { style: 'white-space:pre-wrap;user-select:text' });
      b.append(h('button', { class: 'btn pri', on: { click: async () => { res.textContent = 'Testing…'; try { const r = await B.send({ diagnose: true }, {}); res.textContent = String((r && r.text) || '').replace(/\*\*/g, ''); } catch (e) { res.textContent = 'Test failed: ' + e.message; } } } }, 'Test connection'), res,
        h('button', { class: 'btn ghost', on: { click: () => { Backend.refresh(); toast('Checking…'); } } }, 'Recheck status'));
    } });
  }
  function connSheet() {
    if (Backend.isNative()) return engineSheet();
    sheet({ title: 'Connection', tall: true, build(b, close) {
      const url = h('input', { type: 'text', placeholder: 'https://your-server.example/api/chat', value: S.conn.url, 'aria-label': 'Backend URL', autocapitalize: 'off', autocomplete: 'off' });
      const tok = h('input', { type: 'password', placeholder: 'Secret token', value: S.conn.token, 'aria-label': 'Secret token', autocomplete: 'off' });
      const out = h('p', {});
      b.append(h('label', { class: 'l' }, 'Backend URL'), url, h('label', { class: 'l' }, 'Token'), tok, out,
        h('div', { class: 'frow' }, h('button', { class: 'btn ghost', style: 'flex:1', on: { click: async () => { S.conn.url = url.value.trim(); S.conn.token = tok.value; out.textContent = 'Testing…'; const r = await Backend.ping(); out.textContent = r.ok ? '✓ ' + r.label : '✗ ' + r.label; } } }, 'Test'),
          h('button', { class: 'btn pri', style: 'flex:1', on: { click: () => { S.conn.url = url.value.trim(); S.conn.token = tok.value; save(); Backend.refresh(); close(); if (view === 'settings') build('settings'); toast('Connection saved'); } } }, 'Save')),
        h('p', { class: 'muted' }, 'Token Bearer header me jata hai.'));
    } });
  }
  function exportSheet() {
    sheet({ title: 'Export data', tall: true, build(b) {
      Productivity.sync();
      const data = JSON.stringify({ version: 2, chats: S.chats, memories: S.memories, records: Productivity.exportRecords(), missions: S.missions, settings: S.settings, abilities: S.abilities }, (k, v) => k === '_ctx' ? undefined : v, 1);
      const ta = h('textarea', { readonly: '', style: 'width:100%;flex:1;min-height:200px;background:var(--card);border:0;border-radius:16px;padding:12px;font:12px var(--mono);color:var(--fg)' }); ta.value = data;
      const N = window.AdarshNative;
      window.__adarshSaved = (ok) => { if (ok === null) return; toast(ok ? 'File saved' : 'File save nahi hui'); };
      const kids = [
        h('p', { class: 'muted' }, 'JSON backup · PIN aur keys include nahi'), ta,
        N && N.saveFile ? h('button', { class: 'btn pri', on: { click: () => { try { N.saveFile('adarsh-backup-' + new Date().toISOString().slice(0, 10) + '.json', data); } catch (e) { toast('Save dialog nahi khula'); } } } }, 'Save as file') : null,
        h('button', { class: N && N.saveFile ? 'btn ghost' : 'btn pri', on: { click: async () => { if (await copyText(data)) toast('Copied'); else { ta.focus(); ta.select(); toast('Select all and copy'); } } } }, 'Copy JSON'),
        N && N.shareText ? h('button', { class: 'btn ghost', on: { click: () => { try { N.shareText(data); } catch (e) {} } } }, 'Share…') : null,
        !(N && N.saveFile) ? h('button', { class: 'btn ghost', on: { click: () => { const a = h('a', { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: 'adarsh-backup.json' }); document.body.append(a); a.click(); a.remove(); } } }, 'Download file') : null
      ];
      b.append(...kids.filter(Boolean));
    } });
  }
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'f-import' && t.files[0]) {
      /* audit M8: bounded size, known version, typed + capped lists before anything replaces local data */
      const MAX_IMPORT_BYTES = 8 * 1024 * 1024, CAPS = { chats: 500, memories: 2000, missions: 500 };
      if (t.files[0].size > MAX_IMPORT_BYTES) { toast('Backup file bahut badi hai (8 MB max).'); t.value = ''; return; }
      t.files[0].text().then(txt => {
        if (txt.length > MAX_IMPORT_BYTES) return toast('Backup file bahut badi hai (8 MB max).');
        let d;
        try { d = JSON.parse(txt); } catch (err) { return toast('That file is not valid JSON'); }
        if (!d || typeof d !== 'object' || Array.isArray(d)) return toast('Yeh ADARSH backup file nahi hai.');
        if (d.version !== undefined && d.version !== 1 && d.version !== 2) return toast('Backup version ' + String(d.version).slice(0, 12) + ' support nahi hai.');
        if (d.records !== undefined && !Array.isArray(d.records)) return toast('Backup ke records galat format me hain.');
        const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
        const lists = {};
        for (const k of Object.keys(CAPS)) {
          if (d[k] === undefined) continue;
          if (!Array.isArray(d[k])) return toast('Backup me "' + k + '" galat format me hai.');
          if (d[k].length > CAPS[k]) return toast('Backup me ' + k + ' bahut zyada hain (max ' + CAPS[k] + ').');
          lists[k] = d[k].filter(isObj);
        }
        if (lists.chats) lists.chats = lists.chats.filter(c => typeof c.id === 'string' && c.id.length <= 200 && (c.messages === undefined || Array.isArray(c.messages)));
        const legacy = { tasks: 'task', reminders: 'reminder', alarms: 'alarm', timers: 'timer', notes: 'note', work: 'work' };
        const records = Array.isArray(d.records) ? d.records : Object.entries(legacy).flatMap(([key, kind]) => (Array.isArray(d[key]) ? d[key].slice(0, 2000) : []).filter(isObj).map(r => ({ ...r, kind, at: r.at || r.due || 0, created: r.created || r.ts || Date.now() })));
        confirmSheet({ title: 'Import this backup?', text: 'Chats, memory aur missions replace honge. Records merge honge. PIN aur keys wahi rahenge.', label: 'Import', onYes: () => {
          try {
            const r = Productivity.importRecords(records); if (!r.ok) return toast(r.message || r.error || 'Records import fail hua; purana data preserve hai.');
            ['chats', 'memories', 'missions'].forEach(k => { if (Array.isArray(lists[k])) S[k] = lists[k]; });
            S.cur = S.chats[0] ? S.chats[0].id : null; saveNow(); Chat.renderThread(); drawerList(); toast('Imported');
          } catch (e) { toast('Import fail: ' + e.message); }
        } });
      }).catch(() => toast('Backup file padh nahi paya')); t.value = '';
    }
    if ((t.id === 'f-any' || t.id === 'f-img') && t.files) { [...t.files].forEach(Chat.addFile); t.value = ''; }
  });

  return { show, drawer, buildDrawer, drawerList, applyTheme, ask, draft, get view() { return view; } };
})();
