'use strict';
/* Change 1.3 (js/04-mission.js, js/04-briefing.js): goals + project tracker, night briefing with tomorrow's plan. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const UI = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(UI, 'src/index.html'), 'utf8');
const ORDER = [...INDEX.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)].map(m => m[1]);
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await settle(10); } }
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function nightBase() { const d = new Date(); if (d.getHours() < 4) d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return d; }
function mount({ settings, store, reply, native } = {}) {
  const dom = new JSDOM(INDEX, { url: 'https://appassets.androidplatform.net/assets/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.requestAnimationFrame = cb => { cb(Date.now()); return 1; };
  if (!w.crypto?.subtle) Object.defineProperty(w, 'crypto', { configurable: true, value: webcrypto });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.navigator.vibrate = () => true;
  w.open = () => null;
  w.fetch = async () => { throw new Error('network disabled in test'); };
  w.Notification = undefined;
  w.console = console;
  if (native) w.AdarshNative = native;
  w.localStorage.setItem('adarsh.ui.v3', JSON.stringify({ ...(store || {}), settings: { ui4: 1, bootAnim: false, ...(settings || {}) } }));
  const sent = [];
  w.ADARSH_BACKEND = {
    async send(req) { sent.push(JSON.parse(JSON.stringify(req))); return typeof reply === 'function' ? reply(req) : (reply || { type: 'text', text: 'ok' }); },
    async ping() { return { ok: true, label: 'test' }; }
  };
  const ctx = dom.getInternalVMContext();
  for (const file of ORDER) new vm.Script(fs.readFileSync(path.join(UI, 'src', file), 'utf8'), { filename: path.join(UI, 'src', file) }).runInContext(ctx);
  new vm.Script('globalThis.TEST = { S, Chat, App, Mission, Briefing, Productivity };').runInContext(ctx);
  return { dom, window: w, document: w.document, sent, ...w.TEST, close: () => dom.window.close() };
}
const later = (days, hh = 0, mm = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hh, mm, 0, 0); return d; };
const nightReply = (req) => {
  if (!req.briefing || req.briefing.followup) return { type: 'text', text: 'Follow-up ka jawab' };
  return { type: 'text', text: '**Aaj ka hisaab**\nInertia samjha. MIT goal: 2 milestone baaki.', uiMode: 'standard',
    briefing: { date: req.briefing.date, for: req.briefing.tomorrow, focus: 'Line-follower v2 ka sensor', plan: [
      { title: 'Physics: Newton ka 2nd law', time: '07:00', minutes: 45, goal: 'MIT', project: '' },
      { title: 'Robot v2: IR sensor jodna', time: '18:30', minutes: 60, goal: '', project: 'Line-follower' },
      { title: 'Economics: demand curve', time: '', minutes: 30, goal: 'MIT', project: '' }],
      memorySuggestions: [
        { text: 'Sir ne Inertia ka pehla niyam padha.', reason: 'Aage revision mein madad karega.' },
        { text: 'Robot v2 mein IR sensor agla upgrade hai.', reason: 'Project continuity ke liye.' }
      ] } };
};

test('default MIT goal is added on boot once; days left and progress come from the phone', () => {
  const app = mount();
  try {
    const { Mission, S } = app;
    assert.equal(S.goals.length, 1);
    const g = S.goals[0];
    assert.equal(g.title, 'Mujhe MIT jana hai');
    assert.equal(g.deadline, '');
    assert.equal(Mission.daysLeft(g), null);
    assert.equal(Mission.progress(g), 0);
    g.deadline = ymd(later(10));
    assert.equal(Mission.daysLeft(g), 10);
    g.milestones[0].done = true; g.milestones[1].done = true;
    assert.equal(Mission.progress(g), 50);
    assert.equal(Mission.ensureDefaultGoal().id, g.id);
    assert.equal(S.goals.length, 1, 'default creation is idempotent');
    S.goals.splice(0, 1);
    assert.equal(Mission.ensureDefaultGoal(), null, 'a deliberate deletion is not undone');
    assert.equal(S.goals.length, 0);
  } finally { app.close(); }
});

test('default goal preserves user goals, projects, legacy mission data, and existing MIT goals', () => {
  const custom = { id: 'user-g', title: 'Build a robot', why: 'Learn by building', deadline: '', status: 'active', milestones: [], created: 1, updated: 1 };
  const project = { id: 'user-p', name: 'Robot', why: '', goalId: 'user-g', status: 'active', concepts: [], versions: [{ id: 'v1', v: 1, aim: 'Move' }], created: 1, updated: 1 };
  const app = mount({ store: { goals: [custom], projects: [project], mission: 'Legacy text kept locally' } });
  try {
    assert.equal(app.S.goals.length, 2);
    assert.equal(app.S.goals[0].title, 'Build a robot');
    assert.equal(app.S.goals[1].title, 'Mujhe MIT jana hai');
    assert.equal(app.S.projects[0].name, 'Robot');
    assert.equal(app.S.mission, 'Legacy text kept locally', 'old local data is not silently deleted');
  } finally { app.close(); }
  const existing = { id: 'mit-g', title: 'Get into MIT', why: 'My existing goal', deadline: '', status: 'active', milestones: [], created: 1, updated: 1 };
  const app2 = mount({ store: { goals: [existing] } });
  try {
    assert.equal(app2.S.goals.length, 1, 'an existing MIT goal is not duplicated or replaced');
    assert.equal(app2.S.goals[0].title, 'Get into MIT');
  } finally { app2.close(); }
});

test('project builder cycle: update, upgrade to v2 with the old next as aim, idle days', () => {
  const app = mount();
  try {
    const { Mission, S } = app;
    const g = Mission.addGoal({ title: 'Robotics basics' });
    const p = Mission.addProject({ name: 'Line-follower', goalId: g.id, aim: 'Do motors chalana' });
    assert.equal(p.versions.length, 1);
    Object.assign(p.versions[0], { built: 'Motor driver', learned: 'PWM', next: 'IR sensor jodna' });
    Mission.upgrade(p);
    assert.equal(p.versions.length, 2);
    assert.equal(p.versions[1].v, 2);
    assert.equal(p.versions[1].aim, 'IR sensor jodna');
    assert.ok(p.versions[0].done > 0);
    p.updated = Date.now() - 5 * 864e5;
    assert.equal(Mission.idleDays(p), 5);
    const sum = Mission.summary();
    assert.equal(sum.projects[0].name, 'Line-follower');
    assert.equal(sum.projects[0].version, 2);
    assert.equal(sum.projects[0].next, 'IR sensor jodna');
    assert.equal(sum.projects[0].goal, 'Robotics basics');
    assert.equal(sum.projects[0].idleDays, 5);
  } finally { app.close(); }
});

test('Goals view has no Mission card and shows the default MIT goal; deadline and milestone progress work', () => {
  const app = mount();
  try {
    app.App.show('goals');
    const v = () => app.document.querySelector('#v-goals');
    assert.equal(text(v().querySelector('.hdr h1')), 'Goals');
    assert.equal(text(app.document.querySelector('#drawer [data-nav="goals"]')), 'Goals');
    assert.equal(v().querySelector('.mi-mission'), null);
    assert.doesNotMatch(text(v()), /MISSION|Edit mission/i);
    assert.equal(app.S.goals.length, 1);
    assert.match(text(v().querySelector('.mi-goal')), /Mujhe MIT jana hai/);
    assert.match(text(v().querySelector('.mi-goal')), /Deadline set nahi/);
    app.S.goals[0].deadline = ymd(later(20));
    app.App.show('goals');
    assert.match(text(v().querySelector('.mi-goal .pill')), /20 din baaki/);
    assert.ok(v().querySelector('.mi-goal .pill.warn'), 'under 30 days is a warning');
    v().querySelector('.mi-mrow').click();
    assert.match(text(v().querySelector('.mi-goal .pv-progress-line')), /25%/);
    assert.equal(app.S.goals[0].milestones[0].done, true);
  } finally { app.close(); }
});

test('night context: today counts from phone records and keeps bounded goals/projects only', () => {
  const base = nightBase(), now = Date.now();
  const inDay = Math.max(base.getTime() + 1000, now - 1000);
  const tmr = new Date(base); tmr.setDate(tmr.getDate() + 1); tmr.setHours(9, 15, 0, 0);
  const app = mount({ store: {
    vocab: [{ id: 'v1', w: 'Inertia', m: 'x', ts: inDay }, { id: 'v2', w: 'Old', m: 'y', ts: base.getTime() - 864e5 }],
    learnLog: [{ ts: inDay, concept: 'Inertia', q: 'Bus ruke to?', ok: false }, { ts: inDay, concept: 'Inertia', q: 'Law?', ok: true }],
    tasks: [{ id: 't1', kind: 'task', title: 'Done today', done: true, updated: inDay, created: 1 }, { id: 't2', kind: 'task', title: 'Open one', done: false, created: 1, updated: 1 },
      { id: 't3', kind: 'task', title: 'Coaching', done: false, at: tmr.getTime(), due: tmr.getTime(), created: 1, updated: 1 }],
    chats: [{ id: 'c1', title: 'x', ts: inDay, msgs: [{ id: 'm1', role: 'user', text: 'Inertia kya hai?', ts: inDay }, { id: 'm2', role: 'ai', ts: inDay, reply: { type: 'text', text: 'a', learn: { concept: 'Inertia', checks: [] } } }] }],
    goals: [{ id: 'g1', title: 'MIT', why: '', deadline: '', status: 'active', milestones: [], created: 1, updated: 1 }], mission: 'AGI'
  } });
  try {
    const c = app.Briefing.context();
    assert.equal(c.date, ymd(base));
    assert.equal(c.today.questions, 1);
    assert.equal(c.today.concepts.join(','), 'Inertia');
    assert.equal(c.today.words.join(','), 'Inertia');
    assert.equal(c.today.right, 1); assert.equal(c.today.total, 2);
    assert.equal(c.today.weak.length, 1); assert.equal(c.today.weak[0].q, 'Bus ruke to?');
    assert.equal(c.today.done.join(','), 'Done today');
    assert.equal(c.today.open.map(x => x.title).join(','), 'Open one');
    assert.equal(c.fixed.length, 1); assert.equal(c.fixed[0].title, 'Coaching'); assert.equal(c.fixed[0].time, '09:15');
    assert.equal(c.mission, undefined, 'the removed Mission feature is no longer sent in briefing context');
    assert.equal(c.goals[0].title, 'MIT');
  } finally { app.close(); }
});

test('first briefing asks consent; nothing is sent until sir agrees', async () => {
  const app = mount({ reply: nightReply });
  try {
    app.Briefing.start();
    const sh = app.document.querySelector('.sheet');
    assert.ok(sh, 'privacy sheet');
    assert.match(text(sh), /Groq.*Chats ka text nahi jata/);
    assert.equal(app.sent.length, 0);
    [...sh.querySelectorAll('button')].find(b => /Abhi nahi/.test(b.textContent)).click();
    assert.equal(app.sent.length, 0);
    assert.notEqual(app.S.settings.briefingConsent, true);
  } finally { app.close(); }
});

test('briefing runs in Standard even from another mode, shows KAL KA PLAN and saves picked items as tasks', async () => {
  const app = mount({ settings: { mode: 'physics', briefingConsent: true }, reply: nightReply });
  try {
    app.Briefing.start();
    await until(() => app.sent.length === 1 && !app.Chat.isBusy());
    const req = app.sent[0];
    assert.equal(req.mode, 'standard');
    assert.equal(req.meta.briefing, true);
    assert.equal(req.briefing.date, ymd(nightBase()));
    assert.ok(req.briefing.today && Array.isArray(req.briefing.goals));
    const c = app.S.chats.find(x => x.id === app.S.cur);
    assert.equal(c.briefing, ymd(nightBase()));
    assert.equal(app.S.briefings.length, 1);
    await until(() => app.document.querySelector('.bplan'));
    const card = () => app.document.querySelector('.bplan');
    assert.match(text(card()), /KAL KA PLAN/);
    assert.match(text(card()), /FOCUS\s*Line-follower v2 ka sensor/);
    assert.equal(card().querySelectorAll('.bp-row').length, 3);
    card().querySelectorAll('.bp-row')[2].click();   // drop the untimed one
    assert.match(text(card().querySelector('.bp-foot .btn')), /2 tasks save karo/);
    card().querySelector('.bp-foot .btn').click();
    await until(() => app.S.tasks.length === 2);
    const titles = app.S.tasks.map(t => t.title).sort();
    assert.equal(titles.join('|'), 'Physics: Newton ka 2nd law · 45 min|Robot v2: IR sensor jodna · 60 min');
    const robot = app.S.tasks.find(t => /Robot/.test(t.title));
    const want = new Date(nightBase()); want.setDate(want.getDate() + 1); want.setHours(18, 30, 0, 0);
    assert.equal(robot.at, want.getTime());
    await until(() => /2 tasks save ho gaye/.test(text(app.document.querySelector('.bplan .bp-foot'))));
    assert.equal(app.S.settings.mode, 'physics', 'the mode sir picked is not changed');
    /* a second tap opens the same briefing; no new model call */
    app.Briefing.start();
    await settle(30);
    assert.equal(app.sent.length, 1);
  } finally { app.close(); }
});

test('night memory suggestions ask first: approve saves locally, skip saves nothing', async () => {
  const app = mount({ settings: { briefingConsent: true }, reply: nightReply });
  try {
    app.Briefing.start();
    await until(() => app.sent.length === 1 && !app.Chat.isBusy());
    const card = app.document.querySelector('.bmem');
    assert.ok(card);
    assert.match(text(card), /YAAD RAKHUN\?/);
    assert.equal(app.S.memories.length, 0, 'model proposal alone never writes memory');
    [...card.querySelectorAll('button')].find(b => b.textContent === 'Yaad rakho').click();
    assert.equal(app.S.memories.length, 1);
    assert.equal(app.S.memories[0].text, 'Sir ne Inertia ka pehla niyam padha.');
    assert.equal(app.S.memories[0].source, 'night-briefing');
    assert.match(text(app.document.querySelector('.bmem')), /Memory mein save ho gayi/);
    [...app.document.querySelector('.bmem').querySelectorAll('button')].find(b => b.textContent === 'Skip').click();
    assert.equal(app.S.memories.length, 1, 'skip leaves the memory list unchanged');
    assert.match(text(app.document.querySelector('.bmem')), /Skip kiya/);
    const reply = app.S.chats.find(c => c.id === app.S.cur).msgs.find(m => m.role === 'ai' && m.reply && m.reply.briefing).reply.briefing;
    assert.equal(reply.memoryDecisions.join(','), 'saved,skipped');
  } finally { app.close(); }
});

test('follow-ups in the briefing chat stay in Standard and carry only goals/projects; retry rebuilds the night context', async () => {
  const app = mount({ settings: { mode: 'business', briefingConsent: true }, reply: nightReply,
    store: { goals: [{ id: 'g1', title: 'MIT', why: '', deadline: '', status: 'active', milestones: [], created: 1, updated: 1 }] } });
  try {
    app.Briefing.start();
    await until(() => app.sent.length === 1 && !app.Chat.isBusy());
    await app.Chat.submit('Kal subah 6 baje uth sakta hoon?');
    await until(() => app.sent.length === 2 && !app.Chat.isBusy());
    const f = app.sent[1];
    assert.equal(f.mode, 'standard');
    assert.equal(f.briefing.followup, true);
    assert.equal(f.briefing.goals[0].title, 'MIT');
    assert.equal(f.briefing.today, undefined, 'follow-ups do not resend the day');
    /* Retry on the follow-up stays Standard; Retry on the night message itself rebuilds the context */
    app.document.querySelector('.msg [aria-label="Retry"]').click();
    await until(() => app.sent.length === 3 && !app.Chat.isBusy());
    assert.equal(app.sent[2].mode, 'standard');
    assert.equal(app.sent[2].briefing.followup, true);
    const bc = app.S.chats.find(x => x.id === app.S.cur);
    bc.msgs.splice(2);   // back to [night user, night reply]
    app.Chat.renderThread();
    app.document.querySelector('.msg [aria-label="Retry"]').click();
    await until(() => app.sent.length === 4 && !app.Chat.isBusy());
    assert.equal(app.sent[3].meta.briefing, true);
    assert.ok(app.sent[3].briefing.today, 'fresh night context');
    /* a normal chat elsewhere sends no briefing field */
    app.Chat.newChat(); app.S.cur = null;
    await app.Chat.submit('Normal sawaal');
    await until(() => app.sent.length === 5 && !app.Chat.isBusy());
    assert.equal(app.sent[4].briefing, undefined);
    assert.equal(app.sent[4].mode, 'business');
  } finally { app.close(); }
});

test('settings expose local briefing privacy while on/time are Controller managed', () => {
  const calls = [];
  const native = {
    controllerStatus: () => JSON.stringify({ linked: true, device_settings: { briefingOn: false, briefingTime: '22:15' } }),
    briefingSet: (j) => { calls.push(JSON.parse(j)); return JSON.stringify({ ok: true, on: JSON.parse(j).on, time: JSON.parse(j).time, notify: true, exact: true }); },
    briefingStatus: () => JSON.stringify({ ok: true, notify: true, exact: true }), takeOpen: () => ''
  };
  const app = mount({ native, settings: { briefingConsent: false } });
  try {
    assert.ok(calls.length >= 1, 'boot syncs the Controller schedule');
    assert.equal(calls[0].time, '22:15'); assert.equal(calls[0].on, false); assert.equal(calls[0].ask, false);
    assert.equal(app.S.settings.briefingConsent, false, 'privacy consent stays local');
    app.App.show('settings');
    const v = app.document.querySelector('#v-settings');
    assert.match(text(v), /Goals & briefing/); assert.doesNotMatch(text(v), /\bMission\b/i);
    assert.match(text(v), /Briefing privacy/);
    assert.doesNotMatch(text(v), /Briefing ka time|Raat ki briefing/);
    assert.equal(v.querySelector('input[type=time]'), null);
  } finally { app.close(); }
});

test('notification tap opens the briefing after the lock; in-app banner shows once per night', async () => {
  let taken = 'briefing';
  const nsent = [];
  const native = { briefingSet: () => '{"ok":true}', briefingStatus: () => '{"ok":true}', takeOpen: () => { const t = taken; taken = ''; return t; },
    send: (id, j) => { nsent.push(JSON.parse(j)); } };
  const app = mount({ native, settings: { briefingConsent: true } });
  try {
    await until(() => nsent.length === 1);
    assert.equal(nsent[0].meta.briefing, true);
    assert.equal(nsent[0].mode, 'standard');
    assert.equal(taken, '', 'the open request is taken once');
    const now = new Date(); now.setHours(23, 0, 0, 0);
    app.S.briefings = []; app.S.settings.briefingSeen = '';
    app.S.settings.briefingTime = '21:30';
    assert.equal(app.Briefing.dueCheck(now.getTime()), true);
    assert.ok(app.document.querySelector('.banner'));
    assert.equal(app.Briefing.dueCheck(now.getTime() + 60e3), false, 'once per night');
  } finally { app.close(); }
});

test('export carries goals/projects/briefings and import keeps them typed and capped', () => {
  const app = mount();
  try {
    const out = app.Mission.cleanImport({ mission: 'X'.repeat(900), goals: [{ title: 'A', deadline: '2026-02-30', status: 'weird', milestones: [{ t: 'm', done: 'yes' }, 'bad'] }, 'junk', { title: '' }],
      projects: [{ name: 'P', versions: [{ v: 'x', built: 'b' }], concepts: ['a', 5] }] });
    assert.equal(out.mission.length, 400);
    assert.equal(out.goals.length, 1);
    assert.equal(out.goals[0].deadline, '');
    assert.equal(out.goals[0].status, 'active');
    assert.equal(out.goals[0].milestones.length, 1);
    assert.equal(out.goals[0].milestones[0].done, false);
    assert.equal(out.projects[0].versions[0].v, 1);
    assert.equal(out.projects[0].concepts.join(','), 'a');
    const b = app.Briefing.cleanImport({ briefings: [{ date: '2026-11-24', chatId: 'c', saved: 99 }, { date: 'x' }] });
    assert.equal(b.briefings.length, 1); assert.equal(b.briefings[0].saved, 20);
  } finally { app.close(); }
});
