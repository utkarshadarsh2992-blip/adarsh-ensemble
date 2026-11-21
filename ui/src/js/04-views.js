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
    d.append(top, nav, h('div', { class: 'rule pad' }), h('div', { class: 'd-label pad' }, 'Recents'), h('div', { class: 'd-list pad', id: 'd-list' }),
      h('div', { class: 'd-foot pad' }, h('button', { class: 'avatar', 'aria-label': 'Settings', on: { click: () => show('settings') } }, (S.settings.name || 'A')[0].toUpperCase()),
        h('button', { class: 'fab', on: { click: () => { Chat.newChat(); show('chat'); Chat.renderThread(); } } }, icon('plus'), 'New chat')));
  }
  function drawerList() {
    const list = $('#d-list'); if (!list) return; list.textContent = '';
    $$('#drawer [data-nav]').forEach(b => b.setAttribute('aria-current', String(b.dataset.nav === view)));
    const openT = S.tasks.filter(t => !t.done).length, liveM = S.missions.filter(m => m.status === 'running').length;
    const bt = $('#bg-tasks'), bm = $('#bg-ms'); if (bt) bt.textContent = openT || ''; if (bm) bm.textContent = liveM || '';
    const cs = S.chats.filter(c => c.msgs.length && (!q || c.title.toLowerCase().includes(q.toLowerCase())));
    if (!cs.length) list.append(h('div', { class: 'd-empty' }, q ? 'No chats match.' : 'No chats yet.'));
    cs.forEach(c => list.append(h('div', { class: 'rc', role: 'button', tabindex: '0', 'aria-current': String(c.id === S.cur && view === 'chat'), on: { click: () => Chat.open(c.id), keydown: (e) => { if (e.key === 'Enter') Chat.open(c.id); } } },
      icon('chat'), h('span', {}, c.title), h('button', { class: 'del', 'aria-label': 'Delete chat', on: { click: (e) => { e.stopPropagation(); Chat.remove(c.id); } } }, icon('trash', 's')))));
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
    st.append(h('button', { class: 'prof', on: { click: nameSheet } }, h('span', { class: 'avatar' }, (S.settings.name || 'A')[0].toUpperCase()), h('span', { class: 't' }, h('b', {}, S.settings.name || 'Adarsh'), h('small', {}, 'Personal · private to this device')), icon('chev', 'chev')));
    const seg = (opts, get, set) => h('div', { class: 'seg' }, opts.map(([v, l]) => h('button', { 'aria-pressed': String(get() === v), on: { click: () => { set(v); save(); redraw(); } } }, l)));
    st.append(h('div', { class: 'd-label', style: 'padding:0 4px' }, 'Color mode'),
      h('div', { class: 'themes' }, [['light', 'Light', 'tl'], ['dark', 'Dark', 'td'], ['system', 'Auto', 'ts']].map(([v, l, c]) => h('button', { class: c, 'aria-pressed': String(S.settings.theme === v), on: { click: () => { S.settings.theme = v; save(); applyTheme(); redraw(); } } }, h('span', { class: 'tile' }, h('i')), l))),
      h('div', { class: 'd-label', style: 'padding:6px 4px 0' }, 'Chat font'), seg([['sans', 'Default'], ['serif', 'Serif']], () => S.settings.font, v => { S.settings.font = v; applyTheme(); }));
    st.append(h('div', { class: 'grp' },
      navItem('mic', 'Voice & language', (S.settings.speak ? 'Speaks replies' : 'Silent replies') + ' · ' + S.settings.lang, voiceSheet),
      swItem('bell', 'Notifications', 'Alert me when a reply or reminder arrives', () => S.settings.notif, async (v) => { S.settings.notif = v; if (v && window.Notification && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) {} } }),
      swItem('kbd', 'Haptics', 'Small vibration on taps', () => S.settings.haptics, v => { S.settings.haptics = v; })));
    st.append(h('div', { class: 'grp' },
      navItem('lock', 'App lock (PIN)', S.lock ? 'On · tap to change or remove' : 'Off', () => Lock.manage(redraw)),
      S.lock ? swItem('shield', 'Lock when app is hidden', 'Asks for PIN after 30 s away', () => S.settings.lockOnHide, v => { S.settings.lockOnHide = v; }) : null,
      window.AdarshKeys ? navItem('lock', 'API keys', keysSummary(), keysSheet) : null,
      navItem('server', 'Connection', Backend.isDemo() ? 'Demo mode · no backend connected' : (S.conn.url || 'This server (/api/chat)'), connSheet)));
    st.append(h('div', { class: 'grp' },
      navItem('download', 'Export data', 'Chats, memory, tasks as JSON', exportSheet),
      navItem('upload', 'Import data', 'Restore from an export', () => $('#f-import').click()),
      navItem('trash', 'Clear all chats', '', () => confirmSheet({ title: 'Clear all chats?', text: 'This removes every chat on this device. Memory and tasks stay.', label: 'Clear', danger: true, onYes: () => { S.chats = []; S.cur = null; save(); Chat.renderThread(); drawerList(); toast('Chats cleared'); } }))));
    st.append(h('div', { class: 'center muted' }, 'ADARSH UI v3 · frontend only'));
  };
  function nameSheet() {
    sheet({ title: 'Your name', build(b, close) {
      const i = h('input', { type: 'text', value: S.settings.name || '', 'aria-label': 'Name' });
      b.append(i, h('button', { class: 'btn pri', on: { click: () => { S.settings.name = i.value.trim() || 'Adarsh'; save(); close(); buildDrawer(); drawerList(); build('settings'); } } }, 'Save'));
    } });
  }
  function voiceSheet() {
    sheet({ title: 'Voice & language', build(b, close) {
      const langs = [['hi-IN', 'Hindi'], ['en-IN', 'English (India)'], ['en-US', 'English (US)']];
      const rate = h('input', { type: 'range', min: '0.7', max: '1.4', step: '0.1', value: String(S.settings.rate), 'aria-label': 'Speaking speed', on: { change: () => { S.settings.rate = +rate.value; save(); } } });
      const seg = h('div', { class: 'seg' }, langs.map(([v, l]) => h('button', { 'aria-pressed': String(S.settings.lang === v), on: { click: (e) => { S.settings.lang = v; save(); $$('.seg button', b).forEach(x => x.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); } } }, l)));
      b.append(swItem('speaker', 'Speak replies', 'Read answers aloud in voice mode and on tap', () => S.settings.speak, v => { S.settings.speak = v; }),
        h('label', { class: 'l' }, 'Recognition language'), seg, h('label', { class: 'l' }, 'Speaking speed'), rate,
        TTS.ok() ? h('button', { class: 'btn ghost', on: { click: () => TTS.speak('Namaste. Main Adarsh hoon.') } }, 'Test voice') : h('p', {}, 'This browser has no speech output.'));
    } });
  }
  function keysSummary() {
    const st = window.AdarshKeys.status(); const n = Object.values(st).filter(x => x && x.set).length;
    return n ? n + ' of 3 providers set' : 'No keys yet. Add at least one to get answers';
  }
  function keysSheet() {
    sheet({ title: 'API keys', tall: true, build(b, close) {
      const K = window.AdarshKeys, st = K.status();
      b.append(h('p', {}, 'Keys are stored encrypted on this phone and are only sent to the provider you got them from. They are never shown again after saving.'));
      K.providers.forEach(p => {
        const cur = st[p.id] || {};
        const inp = h('input', { type: 'password', placeholder: cur.set ? 'Saved (' + cur.hint + '). Paste a new key to replace' : 'Paste ' + p.name + ' key', 'aria-label': p.name + ' API key', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
        const done = (r, msg) => { if (r && r.ok) { toast(msg); close(); if (view === 'settings') build('settings'); } else toast((r && r.error) || 'Failed'); };
        b.append(h('label', { class: 'l' }, p.name + ' · ' + p.url), inp,
          h('div', { class: 'frow' },
            h('button', { class: 'btn pri', style: 'flex:1', on: { click: () => { const v = inp.value.trim(); if (!v) return toast('Paste a key first'); done(K.save(p.id, v), p.name + ' key saved'); } } }, 'Save'),
            cur.set ? h('button', { class: 'btn ghost', style: 'flex:1', on: { click: () => done(K.remove(p.id), p.name + ' key deleted') } }, 'Delete') : null));
      });
    } });
  }
  function connSheet() {
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
      b.append(h('p', {}, 'Copy this JSON and keep it somewhere safe. It does not include your PIN or token.'), ta,
        h('button', { class: 'btn pri', on: { click: async () => { try { await navigator.clipboard.writeText(data); toast('Copied'); } catch (e) { ta.select(); toast('Select all and copy'); } } } }, 'Copy JSON'));
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
