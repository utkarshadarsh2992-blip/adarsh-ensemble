'use strict';
/* 04-views.js : App shell (navigation, drawer, theme) + Today, Tasks, Missions, Memory, Abilities, Settings */

const ABILITIES = [
  { id: 'research', ic: 'globe', name: 'Research & verify', desc: 'Searches several sources and checks each claim before answering.', try: 'Research whether intermittent fasting really improves focus' },
  { id: 'debate', ic: 'chat', name: 'Debate', desc: 'Argues both sides, then a moderator gives a verdict.', try: 'Debate: should I learn Rust or Go first?' },
  { id: 'patterns', ic: 'search2', name: 'Patterns & connections', desc: 'Finds patterns across notes, chats and memories and links related ideas.', try: 'What patterns do you see in my last week of notes?' },
  { id: 'missions', ic: 'flag', name: 'Missions', desc: 'Long jobs broken into stages that keep running while you are away.', try: 'Start a mission: compare the best budget laptops for coding' },
  { id: 'memory', ic: 'brain', name: 'Memory', desc: 'Remembers things you tell it and uses them later.', try: 'Remember that I prefer short answers in Hinglish' },
  { id: 'tasks', ic: 'tasks', name: 'Tasks & reminders', desc: 'Turns “remind me…” into tasks with due times.', try: 'Remind me to call the bank tomorrow 11am' },
  { id: 'proactive', ic: 'bell', name: 'Proactive briefings', desc: 'Morning briefing, due-task nudges and alerts pushed to you.', try: 'Brief me on today' },
  { id: 'selfeng', ic: 'bolt', name: 'Self-engineering', desc: 'Proposes changes to its own code in a staging copy. Always asks your permission before deploy.', try: 'Audit your own code and propose one improvement', approval: true }
];
const isOn = (id) => S.abilities[id] !== false;
const enabledAbilities = () => ABILITIES.filter(a => isOn(a.id)).map(a => a.id);

const App = (() => {
  let view = 'chat'; const root = () => $('#phone');
  const NAV = [['chat', 'chat', 'Chat'], ['today', 'sun', 'Today'], ['tasks', 'tasks', 'Tasks'], ['missions', 'flag', 'Missions'], ['library', 'brain', 'Memory'], ['abilities', 'bolt', 'Abilities']];
  const TITLES = { today: 'Today', tasks: 'Tasks', missions: 'Missions', library: 'Memory', abilities: 'Abilities', settings: 'Settings' };
  const BUILD = {};
  let q = '';

  function applyTheme() {
    const r = document.documentElement; const t = S.settings.theme;
    if (t === 'light' || t === 'dark') r.setAttribute('data-theme', t); else r.removeAttribute('data-theme');
    r.setAttribute('data-font', S.settings.font);
  }
  function show(name) {
    view = name; $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + name));
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
      id === 'tasks' ? h('span', { class: 'badge', id: 'bg-tasks' }) : id === 'missions' ? h('span', { class: 'badge', id: 'bg-ms' }) : null)));
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
      Q('globe', 'Research', () => draft('Research ')), Q('flag', 'New mission', () => draft('Start a mission: '))));
    const open = S.tasks.filter(t => !t.done).sort((a, b) => (a.due || 9e15) - (b.due || 9e15)).slice(0, 4);
    st.append(h('div', { class: 'sech' }, 'Due soon', h('button', { on: { click: () => show('tasks') } }, 'See all')));
    st.append(open.length ? h('div', { class: 'grp' }, open.map(t => { const f = fmtDue(t.due); return h('button', { class: 'item', on: { click: () => show('tasks') } }, icon('tasks'), h('span', { class: 't' }, h('b', { style: 'font-weight:500' }, t.title), f.t ? h('small', {}, f.t) : null)); }))
      : h('div', { class: 'item' }, h('span', { class: 't', style: 'color:var(--muted)' }, 'Nothing due. Say “remind me to…” in chat.')));
    const pins = S.memories.filter(m => m.pin).slice(0, 3);
    if (pins.length) { st.append(h('div', { class: 'sech' }, 'Pinned memory')); st.append(h('div', { class: 'grp' }, pins.map(m => h('div', { class: 'item' }, icon('pin'), h('span', { class: 't' }, m.text))))); }
    const sugg = Backend.suggestions ? Backend.suggestions() : [];
    if (sugg.length) {
      st.append(h('div', { class: 'sech' }, 'Suggested', Backend.isDemo() ? h('span', { class: 'tag demo' }, 'DEMO') : null));
      st.append(h('div', { class: 'grp' }, sugg.map(s => h('button', { class: 'item sug', on: { click: () => ask(s.prompt) } }, icon(s.ic || 'bolt'), h('span', { class: 't' }, h('b', { style: 'font-weight:500' }, s.title), h('small', {}, s.sub)), icon('chev', 'chev')))));
    }
  };

  /* ================= Tasks ================= */
  BUILD.tasks = (st, redraw) => {
    const inp = h('input', { type: 'text', placeholder: 'Add a task', 'aria-label': 'Task title' }); const due = h('input', { type: 'datetime-local', 'aria-label': 'Due (optional)' });
    const add = () => { const t = inp.value.trim(); if (!t) return; S.tasks.push({ id: uid('t'), title: t, due: due.value ? new Date(due.value).getTime() : null, done: false, ts: Date.now() }); save(); Bus.emit('missions:changed'); redraw(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    st.append(h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, h('div', { class: 'addbar', style: 'padding:0' }, inp, h('button', { class: 'go', on: { click: add } }, 'Add')),
      h('div', { class: 'addbar', style: 'padding:0;align-items:center' }, h('span', { class: 'muted', style: 'flex:none' }, 'Due'), due)));
    const open = S.tasks.filter(t => !t.done).sort((a, b) => (a.due || 9e15) - (b.due || 9e15)), done = S.tasks.filter(t => t.done);
    const row = (t) => { const f = fmtDue(t.due); return h('div', { class: 'task' + (t.done ? ' done' : '') },
      h('button', { class: 'cb' + (t.done ? ' on' : ''), role: 'checkbox', 'aria-checked': String(t.done), 'aria-label': 'Done: ' + t.title, on: { click: () => { t.done = !t.done; vibe(); save(); Bus.emit('missions:changed'); redraw(); } } }, t.done ? icon('check') : null),
      h('div', { class: 'tt' }, h('b', {}, t.title), f.t ? h('span', { class: 'due ' + (t.done ? '' : f.c) }, f.t) : null),
      h('button', { class: 'del', 'aria-label': 'Delete ' + t.title, on: { click: () => { S.tasks = S.tasks.filter(x => x !== t); save(); Bus.emit('missions:changed'); redraw(); } } }, icon('trash', 's'))); };
    if (!S.tasks.length) st.append(h('div', { class: 'empty' }, icon('tasks'), h('div', {}, 'No tasks yet.'), h('div', { class: 'muted' }, 'Add one here or just tell Adarsh in chat.')));
    if (open.length) st.append(h('div', { class: 'grp' }, open.map(row)));
    if (done.length) st.append(h('details', {}, h('summary', { class: 'muted', style: 'padding:8px 4px' }, 'Completed (' + done.length + ')'), h('div', { class: 'grp', style: 'margin-top:8px' }, done.map(row))));
  };

  /* ================= Missions ================= */
  BUILD.missions = (st, redraw) => {
    if (!S.missions.length) { st.append(h('div', { class: 'empty' }, icon('flag'), h('div', {}, 'No missions yet.'), h('div', { class: 'muted' }, 'A mission is a long job split into stages. Describe the goal in chat.'), h('button', { class: 'btn pri', on: { click: () => draft('Start a mission: ') } }, 'Start a mission'))); return; }
    S.missions.forEach(m => st.append(renderReply({ type: 'mission', ...m }, { msg: {}, redraw })));
  };
  Bus.on('missions:changed', () => { if (view === 'missions') build('missions'); if (view === 'tasks') build('tasks'); });

  /* ================= Memory ================= */
  BUILD.library = (st, redraw) => {
    const inp = h('input', { type: 'text', placeholder: 'Add something to remember', 'aria-label': 'New memory' });
    const add = () => { const t = inp.value.trim(); if (!t) return; S.memories.unshift({ id: uid('mem'), text: t, pin: false, ts: Date.now() }); save(); redraw(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    st.append(h('div', { class: 'addbar', style: 'padding:0' }, inp, h('button', { class: 'go', on: { click: add } }, 'Save')));
    st.append(h('p', { class: 'muted' }, 'Adarsh uses these in every chat. Say “remember that…” in chat to add one.'));
    if (!S.memories.length) st.append(h('div', { class: 'empty' }, icon('brain'), h('div', {}, 'Nothing remembered yet.')));
    const sorted = [...S.memories].sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0));
    sorted.forEach((m, i) => st.append(h('div', { class: 'mem' }, h('span', { class: 'id' }, '#' + (S.memories.length - S.memories.indexOf(m))), h('p', {}, m.text),
      h('button', { 'aria-label': m.pin ? 'Unpin' : 'Pin', 'aria-pressed': String(!!m.pin), on: { click: () => { m.pin = !m.pin; save(); redraw(); } } }, icon('pin', 's')),
      h('button', { 'aria-label': 'Delete memory', on: { click: () => { const k = S.memories.indexOf(m); S.memories.splice(k, 1); save(); redraw(); toast('Memory deleted', { action: () => { S.memories.splice(k, 0, m); save(); if (view === 'library') redraw(); } }); } } }, icon('trash', 's')))));
  };

  /* ================= Abilities ================= */
  BUILD.abilities = (st, redraw) => {
    st.append(h('p', { class: 'muted' }, 'No commands to learn. Just say what you want in normal language and Adarsh picks the right ability. Switch off the ones you don’t want.'));
    st.append(h('div', { class: 'grp' }, ABILITIES.map(a => {
      const on = isOn(a.id);
      return h('div', { class: 'item abil col2' },
        h('div', { class: 'tt' }, h('span', { class: 'ico' }, icon(a.ic)), h('span', { class: 't', style: 'padding:0' }, h('b', {}, a.name, a.approval ? h('span', { class: 'tag' }, 'ASKS FIRST') : null), h('small', {}, a.desc)),
          h('button', { class: 'swb', role: 'switch', 'aria-checked': String(on), 'aria-label': a.name, on: { click: () => { S.abilities[a.id] = !on; save(); redraw(); } } }, h('span', { class: 'sw' }))),
        h('button', { class: 'try', on: { click: () => draft(a.try) } }, 'Try: “' + a.try + '”'));
    })));
  };

  /* ================= Settings ================= */
  const swItem = (ic, title, sub, get, set) => h('button', { class: 'item', role: 'switch', 'aria-checked': String(!!get()), on: { click: (e) => { set(!get()); save(); e.currentTarget.setAttribute('aria-checked', String(!!get())); } } },
    icon(ic), h('span', { class: 't' }, title, sub ? h('small', {}, sub) : null), h('span', { class: 'sw' }));
  const navItem = (ic, title, sub, fn) => h('button', { class: 'item', on: { click: fn } }, icon(ic), h('span', { class: 't' }, title, sub ? h('small', {}, sub) : null), icon('chev', 'chev'));
  BUILD.settings = (st, redraw) => {
    const label = (t) => h('div', { class: 'glabel' }, t);
    st.append(h('button', { class: 'prof', on: { click: nameSheet } }, h('span', { class: 'avatar' }, (S.settings.name || 'A')[0].toUpperCase()), h('span', { class: 't' }, h('b', {}, S.settings.name || 'Adarsh'), h('small', {}, 'Personal · private to this device')), icon('chev', 'chev')));
    const seg = (opts, get, set) => h('div', { class: 'seg' }, opts.map(([v, l]) => h('button', { 'aria-pressed': String(get() === v), on: { click: () => { set(v); save(); redraw(); } } }, l)));
    st.append(label('Appearance'),
      h('div', { class: 'themes' }, [['light', 'Light', 'tl'], ['dark', 'Dark', 'td'], ['system', 'Auto', 'ts']].map(([v, l, c]) => h('button', { class: c, 'aria-pressed': String(S.settings.theme === v), on: { click: () => { S.settings.theme = v; save(); applyTheme(); redraw(); } } }, h('span', { class: 'tile' }, h('i')), l))),
      h('div', { class: 'd-label', style: 'padding:6px 4px 0' }, 'Reply font'), seg([['serif', 'Serif'], ['sans', 'Sans']], () => S.settings.font, v => { S.settings.font = v; applyTheme(); }));
    st.append(label('Assistant'), h('div', { class: 'grp' },
      navItem('sliders', 'Answer source', ({ auto: 'Auto · six models write the answers', manual: 'Manual · you paste answers from other AIs', hybrid: 'Hybrid · your answers plus the six models' })[S.settings.source || 'auto'], () => Chat.sourceSheet()),
      navItem('edit', 'Reply style', replySummary(), replySheet),
      navItem('book', 'Lessons', 'Manual master answer ke seekhe hue rules', () => Lessons.listSheet()),
      navItem('mic', 'Voice & language', ({ auto: 'Natural voice (auto)', natural: 'Natural voice', device: 'Phone voice' })[S.settings.voiceEngine || 'auto'] + ' · ' + (S.settings.voiceName || 'Kore') + ' · ' + (S.settings.speak ? 'reads chat replies' : 'voice mode only') + ' · ' + S.settings.lang, voiceSheet)));
    st.append(label('Alerts and feel'), h('div', { class: 'grp' },
      swItem('bell', 'Notifications', 'Alert me when a reply arrives while the app is closed or hidden', () => S.settings.notif, async (v) => {
        S.settings.notif = v;
        if (window.AdarshNative && AdarshNative.setNotify) {   // Android: the app posts the notification itself
          let r = ''; try { r = AdarshNative.setNotify(v); } catch (e) {}
          if (r === 'denied') { S.settings.notif = false; save(); toast('Notification permission blocked. Phone Settings > Apps > Adarsh > Notifications me allow karo'); redraw(); }
          else if (r === 'granted') toast('Notifications on');
        } else if (v && window.Notification && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) {} }
      }),
      swItem('kbd', 'Haptics', 'Small vibration on taps', () => S.settings.haptics, v => { S.settings.haptics = v; if (v) vibe(30); }),
      swItem('sparkle', 'Jarvis (Standard mode)', 'Short "Ji Sir" replies, in-app actions and the working HUD', () => S.settings.jarvis !== false, v => { S.settings.jarvis = v; })));
    st.append(label('Jarvis'), h('div', { class: 'grp' },
      navItem('file', 'Notes', 'Notes jo aap bol ke save karte ho', () => Actions.notesSheet()),
      navItem('bell', 'Reminders and alarms', 'Set time par notification aayega (app band ho to bhi)', () => Actions.infoSheet ? Actions.infoSheet() : toast('App mein reminders kaam karte hain'))));
    st.append(label('Privacy and connection'), h('div', { class: 'grp' },
      navItem('lock', 'App lock (PIN)', S.lock ? 'On · tap to change or remove' : 'Off', () => Lock.manage(redraw)),
      S.lock ? swItem('shield', 'Lock when app is hidden', 'Asks for PIN after 30 s away', () => S.settings.lockOnHide, v => { S.settings.lockOnHide = v; }) : null,
      window.AdarshKeys ? navItem('lock', 'API keys', keysSummary(), keysSheet) : null,
      navItem('server', 'Connection', Backend.isNative() ? 'On-device engine · tap for status' : Backend.isDemo() ? 'Demo mode · no backend connected' : (S.conn.url || 'This server (/api/chat)'), connSheet)));
    st.append(label('Data'), h('div', { class: 'grp' },
      navItem('download', 'Export data', 'Chats, memory, tasks as JSON', exportSheet),
      navItem('upload', 'Import data', 'Restore from an export', () => $('#f-import').click()),
      navItem('trash', 'Clear all chats', '', () => confirmSheet({ title: 'Clear all chats?', text: 'This removes every chat on this device. Memory and tasks stay.', label: 'Clear', danger: true, onYes: () => { S.chats = []; S.cur = null; save(); Chat.renderThread(); drawerList(); toast('Chats cleared'); } }))));
    st.append(h('div', { class: 'center muted' }, 'ADARSH UI v4 · frontend only'));
  };
  function nameSheet() {
    sheet({ title: 'Your name', build(b, close) {
      const i = h('input', { type: 'text', value: S.settings.name || '', 'aria-label': 'Name' });
      b.append(i, h('button', { class: 'btn pri', on: { click: () => { S.settings.name = i.value.trim() || 'Adarsh'; save(); close(); buildDrawer(); drawerList(); build('settings'); } } }, 'Save'));
    } });
  }
  /* V6: offline neural voice pack (Hindi + English male, ~42 MB once). Only shown inside the Android app. */
  function offlineBlock() {
    const N = window.AdarshNative;
    if (!N || !N.neuralStatus) return h('span');
    const msg = h('p', { class: 'muted' }); const btn = h('button', { class: 'btn', on: { click: () => { try { N.neuralInstall(); } catch (e) {} paint(); poll(); } } }, 'Download offline voice');
    const st = () => { try { return JSON.parse(N.neuralStatus()); } catch (e) { return {}; } };
    function paint() {
      const s = st();
      if (s.installing) { msg.textContent = 'Offline voice download ho rahi hai… ' + (s.progress || 0) + '%'; btn.disabled = true; return; }
      btn.disabled = false;
      if (s.hi && s.en) { msg.textContent = 'Offline neural voice taiyar (Hindi + English). Internet ya Gemini quota na ho tab ye bolti hai.'; btn.hidden = true; }
      else msg.textContent = (s.error ? 'Download fail: ' + s.error + '. ' : '') + 'Offline voice (Piper, ~42 MB, ek baar) download karo: bina internet ke bhi natural awaaz.';
    }
    function poll() { paint(); if (st().installing) setTimeout(poll, 800); }
    window.__adarshNeural = () => paint();
    paint();
    return h('div', {}, h('label', { class: 'l' }, 'Offline neural voice (fallback)'), msg, btn);
  }
  function voiceSheet() {
    sheet({ title: 'Voice & language', tall: true, build(b) {
      const segOf = (opts, get, set) => {
        const seg = h('div', { class: 'seg' });
        opts.forEach(([v, l]) => seg.append(h('button', { 'aria-pressed': String(get() === v), on: { click: (e) => { set(v); save(); [...seg.children].forEach(x => x.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); } } }, l)));
        return seg;
      };
      const rate = h('input', { type: 'range', min: '0.7', max: '1.4', step: '0.05', value: String(S.settings.rate), 'aria-label': 'Speaking speed', on: { change: () => { S.settings.rate = +rate.value; save(); } } });
      const pick = h('select', { 'aria-label': 'Natural voice', style: 'width:100%;padding:12px;border-radius:14px;background:var(--card);color:var(--fg);border:0;font:inherit', on: { change: () => { S.settings.voiceName = pick.value; save(); TTS.speak('Namaste, main Adarsh hoon. Ye meri nayi awaaz hai.'); } } },
        TTS.VOICES.map(([v, d]) => { const o = h('option', { value: v }, v + ' · ' + d); if ((S.settings.voiceName || 'Kore') === v) o.selected = true; return o; }));
      const status = h('p', { class: 'muted' });
      const note = () => {
        const n = Backend.canTts() && !Backend.isDemo();
        status.textContent = (n ? 'Natural voice: Gemini TTS (Gemini API key chahiye; free quota limited). ' : 'Natural voice is backend me nahi hai. ')
          + 'Na chale to phone ki apni voice turant bolti hai.' + (TTS.info.last ? ' Last time: ' + (TTS.info.last === 'natural' ? 'natural voice' + (TTS.info.model ? ' (' + TTS.info.model + ')' : '') : 'phone voice' + (TTS.info.why ? ' · natural voice error: ' + TTS.info.why : '')) : '');
      };
      note();
      b.append(swItem('speaker', 'Speak replies in chat', 'Har naya jawab apne aap padh ke sunaye (voice mode hamesha bolta hai)', () => S.settings.speak, v => { S.settings.speak = v; if (!v) TTS.stop(); }),
        h('label', { class: 'l' }, 'Voice engine'),
        segOf([['auto', 'Auto'], ['natural', 'Natural'], ['device', 'Phone']], () => S.settings.voiceEngine || 'auto', v => { S.settings.voiceEngine = v; }),
        h('p', { class: 'muted' }, 'Auto: natural (Gemini) awaaz, aur fail ho to phone ki voice. Phone: sirf device TTS, offline bhi chalta hai.'),
        h('label', { class: 'l' }, 'Natural voice'), pick,
        h('label', { class: 'l' }, 'Language (sunna aur bolna)'),
        segOf([['hi-IN', 'Hindi / Hinglish'], ['en-IN', 'English (India)'], ['en-US', 'English (US)']], () => S.settings.lang, v => { S.settings.lang = v; }),
        h('label', { class: 'l' }, 'Speaking speed'), rate,
        offlineBlock(),
        TTS.ok() ? h('button', { class: 'btn pri', on: { click: () => { status.textContent = 'Bol raha hoon…'; TTS.speak('Namaste! Main Adarsh hoon. Aap jo bhi poochoge, main seedha aur saaf jawab dunga.', note); } } }, 'Test voice')
          : h('p', {}, 'Is browser me speech output nahi hai.'),
        status);
    } });
  }
  function replySummary() {
    const L = { auto: 'Auto language', hinglish: 'Hinglish', english: 'English', hindi: 'Hindi' }, D = { simple: 'Simple', normal: 'Normal', detailed: 'Detailed' };
    return (L[S.settings.replyLang || 'auto'] || 'Auto language') + ' · ' + (D[S.settings.depth || 'normal'] || 'Normal') + ' · ' + (S.settings.think === 'deep' ? 'Deep council' : 'Fast council');
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
        b.append(h('label', { class: 'l' }, title), seg, h('p', { class: 'muted' }, note));
      };
      group('Language', 'replyLang', 'auto', [['auto', 'Auto'], ['hinglish', 'Hinglish'], ['english', 'English'], ['hindi', 'Hindi']],
        'Auto answers in the language of your question.');
      group('Council', 'think', 'fast', [['fast', 'Fast'], ['deep', 'Deep']],
        'Sirf Verified/Physics/Math/Business/Coding modes me: Fast = kam models, quota bachta hai. Deep = zyada models aur falsifiers, slow aur quota-heavy. Standard hamesha 1 model, turant.');
      group('Depth', 'depth', 'normal', [['simple', 'Simple'], ['normal', 'Normal'], ['detailed', 'Detailed']],
        'Simple: everyday words and one example. Detailed: the mechanism, edge cases and a worked example.');
    } });
  }
  function keysSummary() {
    const st = window.AdarshKeys.status(); const ok = id => !!(st[id] && st[id].set);
    const n = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY'].filter(ok).length
      + (ok('CLOUDFLARE_API_TOKEN') && ok('CLOUDFLARE_ACCOUNT_ID') ? 1 : 0);
    return n ? n + ' of 5 providers set' : 'No keys yet. Add at least one to get answers';
  }
  function keysSheet() {
    sheet({ title: 'API keys', tall: true, build(b, close) {
      const K = window.AdarshKeys, st = K.status();
      b.append(h('p', {}, 'Keys are stored encrypted on this phone and are only sent to the provider you got them from. They are never shown again after saving.'));
      K.providers.forEach(p => {
        const cur = st[p.id] || {};
        const inp = h('input', { type: p.plain ? 'text' : 'password', placeholder: cur.set ? 'Saved (' + cur.hint + '). Paste a new key to replace' : 'Paste ' + p.name + (p.plain ? '' : ' key'), 'aria-label': p.name + ' API key', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
        const done = (r, msg) => { if (r && r.ok) { toast(msg); close(); if (view === 'settings') build('settings'); } else toast((r && r.error) || 'Failed'); };
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
    } });
  }
  /* Android: there is no server to point at. Show what the on-device engine is really doing. */
  function engineSheet() {
    sheet({ title: 'On-device engine', tall: true, build(b) {
      const B = window.ADARSH_BACKEND, st = B.status ? B.status() : {};
      const row = (k, v) => h('div', { class: 'item' }, h('span', { class: 't' }, h('b', { style: 'font-weight:500' }, k), h('small', {}, v)));
      const p = st.providers || {}; const on = Object.keys(p).filter(k => p[k]);
      const v = st.voice || {};
      b.append(h('p', {}, 'Is app me koi server nahi hai: engine isi phone par chalta hai aur sirf tumhare API keys se models ko call karta hai.'),
        h('div', { class: 'grp' },
          row('Engine', st.ready ? 'Running (Python ' + (st.python || '?') + ')' : st.error ? 'Error: ' + st.error : 'Starting…'),
          row('Providers with a key', on.length ? on.join(', ') : 'None. Settings > API keys'),
          row('Natural voice', v.gemini ? 'Ready (Gemini key found)' : v.groq_english ? 'English only (Groq key)' : 'Needs a Gemini key. Phone voice is used meanwhile'),
          row('Plan check', (st.plan_problems || []).length ? st.plan_problems.slice(0, 3).join('; ') : 'All model chains valid')));
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
      b.append(h('p', {}, 'Point the app at your ADARSH backend. The token is sent as a Bearer header; your server must verify it and keep its own allow-list (the Telegram CHAT_ID check). Leave empty for the demo.'),
        h('label', { class: 'l' }, 'Backend URL'), url, h('label', { class: 'l' }, 'Secret token'), tok, out,
        h('div', { class: 'frow' }, h('button', { class: 'btn ghost', style: 'flex:1', on: { click: async () => { S.conn.url = url.value.trim(); S.conn.token = tok.value; out.textContent = 'Testing…'; const r = await Backend.ping(); out.textContent = r.ok ? '✓ ' + r.label : '✗ ' + r.label; } } }, 'Test'),
          h('button', { class: 'btn pri', style: 'flex:1', on: { click: () => { S.conn.url = url.value.trim(); S.conn.token = tok.value; save(); Backend.refresh(); close(); if (view === 'settings') build('settings'); toast('Connection saved'); } } }, 'Save')),
        h('p', {}, 'Or from code: set window.ADARSH_BACKEND = { send, missionAction?, ping? } before the app loads. See ARCHITECTURE.md.'));
    } });
  }
  function exportSheet() {
    sheet({ title: 'Export data', tall: true, build(b) {
      const data = JSON.stringify({ chats: S.chats, memories: S.memories, tasks: S.tasks, missions: S.missions, settings: S.settings, abilities: S.abilities }, null, 1);
      const ta = h('textarea', { readonly: '', style: 'width:100%;flex:1;min-height:200px;background:var(--card);border:0;border-radius:16px;padding:12px;font:12px var(--mono);color:var(--fg)' }); ta.value = data;
      const N = window.AdarshNative;
      window.__adarshSaved = (ok) => { if (ok === null) return; toast(ok ? 'File saved' : 'Could not save the file'); };
      b.append(h('p', {}, 'Save this JSON as a file or copy it, and keep it somewhere safe. It does not include your PIN or token.'), ta,
        N && N.saveFile ? h('button', { class: 'btn pri', on: { click: () => { try { N.saveFile('adarsh-backup-' + new Date().toISOString().slice(0, 10) + '.json', data); } catch (e) { toast('Could not open the save dialog'); } } } }, 'Save as file') : null,
        h('button', { class: N && N.saveFile ? 'btn ghost' : 'btn pri', on: { click: async () => { if (await copyText(data)) toast('Copied'); else { ta.focus(); ta.select(); toast('Select all and copy'); } } } }, 'Copy JSON'),
        N && N.shareText ? h('button', { class: 'btn ghost', on: { click: () => { try { N.shareText(data); } catch (e) {} } } }, 'Share…') : null,
        !(N && N.saveFile) ? h('button', { class: 'btn ghost', on: { click: () => { const a = h('a', { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: 'adarsh-backup.json' }); document.body.append(a); a.click(); a.remove(); } } }, 'Download file') : null);
    } });
  }
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'f-import' && t.files[0]) {
      t.files[0].text().then(txt => {
        const d = JSON.parse(txt); confirmSheet({ title: 'Replace data?', text: 'Imported chats, memory and tasks replace what is on this device.', label: 'Import', onYes: () => { ['chats', 'memories', 'tasks', 'missions'].forEach(k => { if (Array.isArray(d[k])) S[k] = d[k]; }); S.cur = S.chats[0] ? S.chats[0].id : null; save(); Chat.renderThread(); drawerList(); toast('Imported'); } });
      }).catch(() => toast('That file is not valid JSON')); t.value = '';
    }
    if ((t.id === 'f-any' || t.id === 'f-img') && t.files) { [...t.files].forEach(Chat.addFile); t.value = ''; }
  });

  return { show, drawer, buildDrawer, drawerList, applyTheme, ask, draft, get view() { return view; } };
})();
