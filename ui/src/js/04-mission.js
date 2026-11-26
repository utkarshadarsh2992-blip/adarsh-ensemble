'use strict';
/* 04-mission.js : goals + project tracker (change 1.3).
   - S.goals: [{id, title, why, deadline 'YYYY-MM-DD' | '', status active|paused|done, milestones:[{id, t, done}], created, updated}]
     Days left are counted from today's date on the phone; progress = milestones done / total.
   - S.projects: sir's builder cycle (build -> learn -> upgrade). [{id, name, goalId, why, status, concepts:[],
     versions:[{id, v, aim, built, learned, next, started, done}], created, updated}]. "Upgrade" closes the current
     version and starts v+1 whose aim is the old "next upgrade".
   Everything stays on the phone. The night briefing (04-briefing.js) sends a bounded summary() only when sir starts it. */
const Mission = (() => {
  const MAX_GOALS = 30, MAX_PROJECTS = 40, MAX_MS = 30, MAX_VERSIONS = 60, IDLE_DAYS = 3;
  const STATUS = ['active', 'paused', 'done'];
  const STATUS_NAME = { active: 'Active', paused: 'Paused', done: 'Done' };
  const STARTER_GOAL = {
    title: 'Mujhe MIT jana hai',
    why: 'Math, science, computer science, business aur economics ki foundation bana kar MIT ki taiyari',
    milestones: ['Math basics: algebra se calculus tak', 'Physics basics: mechanics aur energy', 'Programming basics: Python', 'Economics aur business basics']
  };
  const clean = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const block = (v, n) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, n) : '');
  const goals = () => (Array.isArray(S.goals) ? S.goals : (S.goals = []));
  const projects = () => (Array.isArray(S.projects) ? S.projects : (S.projects = []));
  const dayStart = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const validDate = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number), x = new Date(y, m - 1, d);
    return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d;
  };
  const dateOf = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  function changed() { save(); Bus.emit('mission:changed'); }

  /* ---------- numbers ---------- */
  function daysLeft(g, now = Date.now()) {
    if (!g || !validDate(g.deadline)) return null;
    return Math.round((dateOf(g.deadline) - dayStart(now)) / 864e5);
  }
  function progress(g) {
    const ms = Array.isArray(g.milestones) ? g.milestones : [];
    if (g.status === 'done') return 100;
    return ms.length ? Math.round(ms.filter(m => m.done).length * 100 / ms.length) : null;
  }
  const cur = (p) => (p.versions && p.versions.length ? p.versions[p.versions.length - 1] : null);
  function idleDays(p, now = Date.now()) { return Math.max(0, Math.round((dayStart(now) - dayStart(p.updated || p.created || now)) / 864e5)); }
  const goalOf = (p) => goals().find(g => g.id === p.goalId) || null;
  function leftText(n) {
    if (n == null) return 'Deadline set nahi';
    if (n > 0) return n + ' din baaki';
    if (n === 0) return 'Deadline aaj hai';
    return 'Deadline ' + (-n) + ' din pehle nikal gayi';
  }
  const leftTone = (n) => (n == null ? 'mute' : n < 0 ? 'bad' : n <= 30 ? 'warn' : 'good');

  /* ---------- records ---------- */
  function addGoal({ title, why = '', deadline = '', milestones = [] }) {
    title = clean(title, 120); if (!title) return null;
    if (goals().length >= MAX_GOALS) { toast('Max ' + MAX_GOALS + ' goals. Purane done goals hatao.'); return null; }
    const g = { id: uid('g'), title, why: clean(why, 200), deadline: validDate(deadline) ? deadline : '', status: 'active',
      milestones: milestones.map(t => clean(t, 100)).filter(Boolean).slice(0, MAX_MS).map(t => ({ id: uid('ms'), t, done: false })), created: Date.now(), updated: Date.now() };
    goals().push(g); changed(); return g;
  }
  function ensureDefaultGoal() {
    const existing = goals().find(g => /\bMIT\b/i.test(clean(g.title, 120)));
    if (existing) {
      if (S.settings.defaultMitGoalSeeded !== true) { S.settings.defaultMitGoalSeeded = true; save(); }
      return existing;
    }
    if (S.settings.defaultMitGoalSeeded === true) return null;
    const added = addGoal(STARTER_GOAL);
    if (added) { S.settings.defaultMitGoalSeeded = true; save(); }
    return added;
  }
  function addProject({ name, why = '', goalId = '', aim = '' }) {
    name = clean(name, 80); if (!name) return null;
    if (projects().length >= MAX_PROJECTS) { toast('Max ' + MAX_PROJECTS + ' projects.'); return null; }
    const p = { id: uid('p'), name, why: clean(why, 200), goalId: goals().some(g => g.id === goalId) ? goalId : '', status: 'active', concepts: [],
      versions: [{ id: uid('v'), v: 1, aim: clean(aim, 300), built: '', learned: '', next: '', started: Date.now(), done: 0 }], created: Date.now(), updated: Date.now() };
    projects().unshift(p); changed(); return p;
  }
  function upgrade(p) {
    const v = cur(p); if (!v) return;
    if (p.versions.length >= MAX_VERSIONS) return toast('Max ' + MAX_VERSIONS + ' versions.');
    v.done = Date.now();
    p.versions.push({ id: uid('v'), v: v.v + 1, aim: v.next || '', built: '', learned: '', next: '', started: Date.now(), done: 0 });
    p.status = 'active'; p.updated = Date.now(); changed();
    toast(p.name + ' · v' + (v.v + 1) + ' shuru');
  }
  function remove(list, x, label) {
    const k = list.indexOf(x); if (k < 0) return;
    list.splice(k, 1); changed();
    toast(label + ' hata diya', { action: () => { list.splice(k, 0, x); changed(); } });
  }

  /* ---------- recent concepts (from answers' check blocks) ---------- */
  function recentConcepts(days = 7) {
    const since = Date.now() - days * 864e5, seen = new Set(), out = [];
    (S.chats || []).forEach(c => (c.msgs || []).forEach(m => {
      const k = m.role === 'ai' && (m.ts || 0) >= since && m.reply && m.reply.learn ? clean(m.reply.learn.concept, 60) : '';
      if (k && !seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); out.push({ k, ts: m.ts || 0 }); }
    }));
    return out.sort((a, b) => b.ts - a.ts).slice(0, 16).map(x => x.k);
  }

  /* ---------- briefing summary (bounded; see briefing.py clean_goals / clean_projects) ---------- */
  function summary() {
    const order = { active: 0, paused: 1, done: 2 };
    const gs = goals().slice().sort((a, b) => order[a.status] - order[b.status]).slice(0, 8).map(g => ({
      title: g.title, deadline: g.deadline || '', daysLeft: daysLeft(g), progress: progress(g),
      open: (g.milestones || []).filter(m => !m.done).slice(0, 5).map(m => m.t), why: g.why || '' }));
    const ps = projects().slice().sort((a, b) => order[a.status] - order[b.status]).slice(0, 8).map(p => {
      const v = cur(p) || {}, g = goalOf(p);
      return { name: p.name, version: v.v || 1, status: p.status, built: v.built || '', learned: v.learned || '', next: v.next || v.aim || '',
        idleDays: idleDays(p), concepts: (p.concepts || []).slice(0, 8), goal: g ? g.title : '' };
    });
    return { goals: gs, projects: ps };
  }

  /* ---------- import (typed + capped, audit M8) ---------- */
  function cleanImport(d) {
    const out = {}, isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
    if (typeof d.mission === 'string') out.mission = clean(d.mission, 400);
    if (Array.isArray(d.goals)) out.goals = d.goals.filter(isObj).slice(0, MAX_GOALS).map(g => ({
      id: clean(g.id, 40) || uid('g'), title: clean(g.title, 120), why: clean(g.why, 200), deadline: validDate(g.deadline) ? g.deadline : '',
      status: STATUS.includes(g.status) ? g.status : 'active',
      milestones: (Array.isArray(g.milestones) ? g.milestones : []).filter(isObj).slice(0, MAX_MS).map(m => ({ id: clean(m.id, 40) || uid('ms'), t: clean(m.t, 100), done: m.done === true })).filter(m => m.t),
      created: +g.created || Date.now(), updated: +g.updated || Date.now() })).filter(g => g.title);
    if (Array.isArray(d.projects)) out.projects = d.projects.filter(isObj).slice(0, MAX_PROJECTS).map(p => {
      const vs = (Array.isArray(p.versions) ? p.versions : []).filter(isObj).slice(0, MAX_VERSIONS).map((v, i) => ({
        id: clean(v.id, 40) || uid('v'), v: Math.max(1, Math.min(999, Math.round(+v.v) || i + 1)), aim: clean(v.aim, 300), built: clean(v.built, 300),
        learned: clean(v.learned, 300), next: clean(v.next, 300), started: +v.started || Date.now(), done: +v.done || 0 }));
      return { id: clean(p.id, 40) || uid('p'), name: clean(p.name, 80), why: clean(p.why, 200), goalId: clean(p.goalId, 40), status: STATUS.includes(p.status) ? p.status : 'active',
        concepts: (Array.isArray(p.concepts) ? p.concepts : []).map(c => clean(c, 60)).filter(Boolean).slice(0, 20),
        versions: vs.length ? vs : [{ id: uid('v'), v: 1, aim: '', built: '', learned: '', next: '', started: Date.now(), done: 0 }],
        created: +p.created || Date.now(), updated: +p.updated || Date.now() };
    }).filter(p => p.name);
    return out;
  }

  /* ---------- sheets ---------- */
  const field = (label, input, hint) => h('label', { class: 'pv-field' }, h('span', { class: 'pv-label' }, label), input, hint ? h('span', { class: 'pv-hint' }, hint) : null);
  const inp = (value, ph, max) => h('input', { class: 'pv-input', type: 'text', value: value || '', placeholder: ph || '', maxlength: String(max || 120) });
  const area = (value, ph, max) => { const t = h('textarea', { class: 'pv-textarea', placeholder: ph || '', maxlength: String(max || 300) }); t.value = value || ''; return t; };
  const segOf = (opts, get, set) => {
    const seg = h('div', { class: 'seg' });
    opts.forEach(([v, l]) => seg.append(h('button', { type: 'button', 'aria-pressed': String(get() === v), on: { click: (e) => { set(v); [...seg.children].forEach(x => x.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); } } }, l)));
    return seg;
  };
  function goalSheet(g) {
    sheet({ title: g ? 'Goal badlo' : 'Naya goal', tall: true, build(b, close) {
      const title = inp(g && g.title, 'Kya haasil karna hai', 120), why = inp(g && g.why, 'Ye goal kyun aham hai', 200);
      const dl = h('input', { class: 'pv-input', type: 'date', value: (g && g.deadline) || '', 'aria-label': 'Deadline' });
      const ms = area(g ? (g.milestones || []).map(m => m.t).join('\n') : '', 'Ek line = ek milestone', 3000);
      let status = (g && g.status) || 'active';
      b.append(h('div', { class: 'pv-form' }, field('Goal', title), field('Kyun', why), field('Deadline', dl, 'Isi se "din baaki" ginte hain. Baad mein bhi set kar sakte ho.'),
        field('Milestones', ms, 'Progress = poore hue milestones. Har line ek milestone.'),
        g ? field('Status', segOf(STATUS.map(s => [s, STATUS_NAME[s]]), () => status, v => { status = v; })) : null,
        h('div', { class: 'pv-actions' },
          g ? h('button', { class: 'btn ghost', on: { click: () => { close(); remove(goals(), g, 'Goal'); } } }, 'Delete') : null,
          h('button', { class: 'btn pri', on: { click: () => {
            const t = clean(title.value, 120); if (!t) return toast('Goal ka naam likho');
            if (dl.value && !validDate(dl.value)) return toast('Deadline YYYY-MM-DD honi chahiye');
            const lines = ms.value.split('\n').map(x => clean(x, 100)).filter(Boolean).slice(0, MAX_MS);
            if (!g) { addGoal({ title: t, why: why.value, deadline: dl.value, milestones: lines }); close(); return toast('Goal save'); }
            const old = new Map((g.milestones || []).map(m => [m.t.toLowerCase(), m]));
            Object.assign(g, { title: t, why: clean(why.value, 200), deadline: dl.value || '', status, updated: Date.now(),
              milestones: lines.map(x => old.get(x.toLowerCase()) || { id: uid('ms'), t: x, done: false }) });
            changed(); close(); toast('Goal update');
          } } }, 'Save'))));
    } });
  }
  function projectSheet(p) {
    sheet({ title: p ? 'Project badlo' : 'Naya project', tall: true, build(b, close) {
      const name = inp(p && p.name, 'Project ka naam (jaise: Line-follower robot)', 80), why = inp(p && p.why, 'Kyun (kya seekhna hai)', 200);
      const aim = p ? null : area('', 'v1 mein kya banana hai', 300);
      const sel = h('select', { class: 'pv-input', 'aria-label': 'Goal' }, h('option', { value: '' }, 'Kisi goal se nahi'),
        goals().map(g => { const o = h('option', { value: g.id }, g.title); if (p && p.goalId === g.id) o.selected = true; return o; }));
      let status = (p && p.status) || 'active';
      b.append(h('div', { class: 'pv-form' }, field('Project', name), field('Kyun', why), field('Goal', sel), aim ? field('v1 ka target', aim) : null,
        p ? field('Status', segOf(STATUS.map(s => [s, STATUS_NAME[s]]), () => status, v => { status = v; })) : null,
        h('div', { class: 'pv-actions' },
          p ? h('button', { class: 'btn ghost', on: { click: () => { close(); remove(projects(), p, 'Project'); } } }, 'Delete') : null,
          h('button', { class: 'btn pri', on: { click: () => {
            const n = clean(name.value, 80); if (!n) return toast('Project ka naam likho');
            if (!p) { addProject({ name: n, why: why.value, goalId: sel.value, aim: aim.value }); close(); return toast('Project save · v1'); }
            Object.assign(p, { name: n, why: clean(why.value, 200), goalId: sel.value, status, updated: Date.now() }); changed(); close(); toast('Project update');
          } } }, 'Save'))));
    } });
  }
  function versionSheet(p) {
    const v = cur(p); if (!v) return;
    sheet({ title: p.name + ' · v' + v.v, tall: true, build(b, close) {
      const built = area(v.built, 'Is version mein kya bana / chala', 300), learned = area(v.learned, 'Kya seekha (concept, galti, trick)', 300), next = area(v.next, 'Agla upgrade kya hoga', 300);
      const picked = new Set(p.concepts || []);
      const chips = h('div', { class: 'chips mi-concepts' });
      const drawChips = () => {
        chips.textContent = '';
        const all = [...new Set([...recentConcepts(), ...picked])];
        if (!all.length) chips.append(h('span', { class: 'pv-hint' }, 'Abhi koi concept nahi. Jawabon ke CHECK card ke concepts yahan aayenge.'));
        all.forEach(k => chips.append(h('button', { type: 'button', class: 'mi-chip' + (picked.has(k) ? ' on' : ''), 'aria-pressed': String(picked.has(k)),
          on: { click: () => { if (picked.has(k)) picked.delete(k); else picked.add(k); drawChips(); } } }, k)));
      };
      drawChips();
      b.append(h('div', { class: 'pv-form' }, v.aim ? h('p', { class: 'pv-hint' }, 'Is version ka target: ' + v.aim) : null,
        field('Built', built), field('Learned', learned), field('Next upgrade', next, 'Upgrade dabane par ye agle version ka target banega.'),
        field('Concepts jo is project mein lage', chips, 'Pichhle 7 din ke jawabon ke concepts. Tap = jodo / hatao.'),
        h('button', { class: 'btn pri', on: { click: () => {
          Object.assign(v, { built: clean(built.value, 300), learned: clean(learned.value, 300), next: clean(next.value, 300) });
          p.concepts = [...picked].slice(0, 20); p.updated = Date.now(); changed(); close(); toast('Project update');
        } } }, 'Save')));
    } });
  }

  /* ---------- cards ---------- */
  function goalCard(g, redraw) {
    const n = daysLeft(g), pct = progress(g), ms = g.milestones || [];
    return h('article', { class: 'pv-project mi-goal' + (g.status === 'done' ? ' is-done' : '') },
      h('div', { class: 'pv-project-head' },
        h('div', { class: 'pv-project-title' }, h('span', { class: 'mi-k' }, 'GOAL' + (g.status !== 'active' ? ' · ' + STATUS_NAME[g.status].toUpperCase() : '')), h('b', {}, g.title)),
        h('button', { class: 'pv-icon-btn', type: 'button', 'aria-label': 'Edit goal', on: { click: () => goalSheet(g) } }, icon('edit', 's'))),
      g.why ? h('p', { class: 'pv-project-goal' }, g.why) : null,
      h('div', { class: 'mi-meta' }, h('span', { class: 'pill ' + leftTone(n) }, leftText(n)), g.deadline ? h('span', { class: 'pv-chip' }, g.deadline) : null),
      pct == null ? null : h('div', { class: 'pv-progress-line' }, h('div', { class: 'pv-progress-bar' }, h('i', { style: 'width:' + pct + '%' })), h('span', {}, pct + '%')),
      ms.length ? h('div', { class: 'mi-ms' }, ms.map(m => h('button', { type: 'button', class: 'mi-mrow' + (m.done ? ' done' : ''), role: 'checkbox', 'aria-checked': String(!!m.done),
        on: { click: () => { m.done = !m.done; g.updated = Date.now(); changed(); } } }, h('span', { class: 'pv-check', 'aria-checked': String(!!m.done) }, m.done ? icon('check') : null), h('span', {}, m.t)))) : null,
      g.deadline ? null : h('button', { class: 'link', on: { click: () => goalSheet(g) } }, 'Deadline set karo'));
  }
  function projectCard(p, redraw) {
    const v = cur(p) || {}, g = goalOf(p), idle = idleDays(p);
    const row = (k, t) => (t ? h('div', { class: 'mi-row' }, h('span', { class: 'mi-rk' }, k), h('span', {}, t)) : null);
    const history = (p.versions || []).slice(0, -1).reverse();
    return h('article', { class: 'pv-project mi-proj' + (p.status === 'done' ? ' is-done' : '') },
      h('div', { class: 'pv-project-head' },
        h('div', { class: 'pv-project-title' }, h('span', { class: 'mi-k' }, 'PROJECT · v' + (v.v || 1) + (p.status !== 'active' ? ' · ' + STATUS_NAME[p.status].toUpperCase() : '')), h('b', {}, p.name)),
        h('button', { class: 'pv-icon-btn', type: 'button', 'aria-label': 'Edit project', on: { click: () => projectSheet(p) } }, icon('edit', 's'))),
      h('div', { class: 'mi-meta' }, g ? h('span', { class: 'pv-chip' }, icon('target', 's'), g.title.slice(0, 40)) : null,
        p.status === 'active' && idle >= IDLE_DAYS ? h('span', { class: 'pill warn' }, idle + ' din se kaam nahi') : h('span', { class: 'pill mute' }, idle === 0 ? 'Aaj update' : idle + ' din pehle update')),
      h('div', { class: 'mi-rows' }, row('TARGET', v.aim), row('BUILT', v.built), row('LEARNED', v.learned), row('NEXT', v.next),
        !v.built && !v.learned && !v.next ? h('p', { class: 'pv-hint' }, 'Abhi kuch likha nahi. "Update" se built / learned / next likho.') : null),
      (p.concepts || []).length ? h('div', { class: 'chips' }, p.concepts.map(k => h('span', { class: 'chip' }, k))) : null,
      history.length ? h('details', { class: 'pv-entry-details' }, h('summary', {}, 'Purane versions', h('span', {}, String(history.length))),
        h('div', { class: 'pv-entries' }, history.map(x => h('div', { class: 'pv-entry' }, h('div', { class: 'pv-entry-head' }, h('b', {}, 'v' + x.v), h('span', {}, x.done ? new Date(x.done).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '')),
          x.built ? h('p', {}, 'Built: ' + x.built) : null, x.learned ? h('small', {}, 'Learned: ' + x.learned) : null)))) : null,
      h('div', { class: 'pv-actions' },
        h('button', { class: 'btn ghost', on: { click: () => versionSheet(p) } }, icon('edit', 's'), 'Update'),
        h('button', { class: 'btn pri', on: { click: () => confirmSheet({ title: 'v' + ((v.v || 1) + 1) + ' shuru karein?', text: 'v' + (v.v || 1) + ' band hoga aur history mein jayega. Naye version ka target: ' + (v.next || '(next upgrade khaali hai)'), label: 'Upgrade', onYes: () => upgrade(p) }) } }, icon('up', 's'), 'Upgrade')));
  }

  /* ---------- Goals view ---------- */
  function view(st, redraw) {
    const brief = h('button', { class: 'btn pri mi-brief', on: { click: () => Briefing.start() } }, icon('moon', 's'), 'Raat ki briefing abhi');
    if (!goals().length && !projects().length) {
      st.append(h('div', { class: 'pv-empty' }, icon('target'), h('b', {}, 'Abhi koi goal ya project nahi'),
        h('span', {}, 'Goal ya project add karke apni progress track karo.'),
        h('button', { class: 'link', on: { click: () => goalSheet() } }, 'Khud goal likho')));
    }
    st.append(h('div', { class: 'sech' }, 'Goals', h('button', { on: { click: () => goalSheet() } }, '+ Goal')));
    if (goals().length) goals().forEach(g => st.append(goalCard(g, redraw)));
    else st.append(h('p', { class: 'muted' }, 'Goal = kya haasil karna hai, kab tak. Deadline se din baaki ginte hain.'));
    st.append(h('div', { class: 'sech' }, 'Projects · build → learn → upgrade', h('button', { on: { click: () => projectSheet() } }, '+ Project')));
    if (projects().length) projects().forEach(p => st.append(projectCard(p, redraw)));
    else st.append(h('p', { class: 'muted' }, 'Project banao, usse seekho, phir upgrade karo. Har version ka built / learned / next yahan rahega, aur raat ki briefing har project par baat karegi.'));
  }

  /* ---------- Today card ---------- */
  function todayCard() {
    const g = goals().find(x => x.status === 'active'), p = projects().find(x => x.status === 'active');
    const lines = [];
    if (g) { const n = daysLeft(g), pct = progress(g); lines.push(h('div', { class: 'mi-trow' }, icon('target', 's'), h('span', { class: 't' }, g.title), h('span', { class: 'pill ' + leftTone(n) }, n == null ? 'no deadline' : n >= 0 ? n + ' din' : 'late'), pct == null ? null : h('span', { class: 'pv-chip' }, pct + '%'))); }
    if (p) { const idle = idleDays(p), v = cur(p) || {}; lines.push(h('div', { class: 'mi-trow' }, icon('bolt', 's'), h('span', { class: 't' }, p.name + ' · v' + (v.v || 1)), idle >= IDLE_DAYS ? h('span', { class: 'pill warn' }, idle + ' din idle') : null)); }
    if (!lines.length) lines.push(h('p', { class: 'muted' }, 'Goals aur projects abhi khaali hain.'));
    return h('div', { class: 'card mi-today' }, h('div', { class: 'card-h' }, h('div', { class: 'grow' }, h('span', { class: 'k' }, 'GOALS · RAAT KI BRIEFING'), lines)),
      h('div', { class: 'card-btns' }, h('button', { class: 'btn pri', style: 'flex:1', on: { click: () => Briefing.start() } }, icon('moon', 's'), 'Briefing'),
        h('button', { class: 'btn ghost', style: 'flex:1', on: { click: () => App.show('goals') } }, 'Goals')));
  }

  return { view, todayCard, summary, cleanImport, ensureDefaultGoal, addGoal, addProject, upgrade, daysLeft, progress, idleDays, recentConcepts, goals, projects, goalSheet, projectSheet, versionSheet, validDate };
})();
