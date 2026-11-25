'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');

const UI = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(UI, 'src/index.html'), 'utf8');
const SCRIPT_ORDER = [...INDEX.matchAll(/<script\s+src="([^"]+)"\s*>\s*<\/script>/g)].map(m => m[1]);
const STORAGE_KEY = 'adarsh.ui.v3';

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const settle = async (ms = 0) => { await wait(ms); await Promise.resolve(); };
const textOf = el => (el && el.textContent || '').replace(/\s+/g, ' ').trim();
const button = (root, label) => [...(root || document).querySelectorAll('button')].find(b => textOf(b) === label || b.getAttribute('aria-label') === label);
const clickButton = async (root, label) => {
  const b = button(root, label);
  assert.ok(b, `button ${JSON.stringify(label)} should exist`);
  b.click();
  await settle();
  return b;
};
const input = (root, label) => {
  const el = (root || document).querySelector(`[aria-label="${label}"]`);
  assert.ok(el, `control ${JSON.stringify(label)} should exist`);
  return el;
};
const future = (minutes = 60) => Date.now() + minutes * 60 * 1000;
const localDateTime = (minutes = 60) => {
  const d = new Date(future(minutes));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const plan = (steps, text = 'Kaam') => ({ type: 'actions', origin: 'local-rule', mode: 'standard', text, steps });
const step = (id, action, args = {}, extra = {}) => ({ id, action, args, risk: 'safe', ...extra });

function sourceList() {
  return SCRIPT_ORDER.map(relative => ({ relative, source: fs.readFileSync(path.join(UI, 'src', relative.replace(/^js\//, 'js/')), 'utf8') }));
}

function makeHarness({ route, storage, native = false, nativeOverrides = {} } = {}) {
  const dom = new JSDOM(INDEX, {
    url: 'http://adarsh.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;
  const requests = [];
  const originalSetTimeout = w.setTimeout.bind(w);
  const backend = {
    async send(req, options = {}) {
      requests.push(req);
      if (options.onProgress) options.onProgress('offline test progress');
      return route ? await route(req, options) : { type: 'text', text: 'offline test reply' };
    },
    async ping() { return { ok: true, label: 'Offline test backend' }; }
  };

  w.matchMedia = () => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.requestAnimationFrame = cb => { cb(Date.now()); return 1; };
  w.cancelAnimationFrame = () => {};
  w.URL.createObjectURL = () => 'blob:http://adarsh.test/test-object';
  if (!w.crypto || !w.crypto.subtle) Object.defineProperty(w, 'crypto', { configurable: true, value: webcrypto });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.navigator.vibrate = () => true;
  w.open = () => null;
  w.fetch = async () => { throw new Error('network disabled in integration tests'); };
  w.Notification = undefined;
  w.console = console;
  if (storage) {
    for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  if (native) {
    w.AdarshNative = {
      status: () => JSON.stringify({ ready: true, providers: { groq: true } }),
      recordsList: () => JSON.stringify({ ok: false, error: 'canonical store unavailable' }),
      runActions: () => JSON.stringify({ results: [] }),
      ...nativeOverrides
    };
  } else {
    w.ADARSH_BACKEND = backend;
  }

  const context = dom.getInternalVMContext();
  for (const { relative, source } of sourceList()) {
    new vm.Script(source, { filename: path.join(UI, 'src', relative) }).runInContext(context);
  }
  new vm.Script('globalThis.TEST = { S, App, Chat, Actions, Productivity, Voice, STT, TTS, Modes, Bus, MobileUpdates, BackgroundVoice, load, saveNow, speechOf };', { filename: 'test-hooks.js' }).runInContext(context);

  const api = {
    dom,
    window: w,
    document: w.document,
    requests,
    ...w.TEST,
    async close() {
      try { w.Voice.close(); } catch {}
      try { w.STT.stop(); } catch {}
      try { w.TTS.stop(); } catch {}
      dom.window.close();
      await settle();
    },
    originalSetTimeout
  };
  return api;
}

function lastReply(app) {
  const chat = app.S.chats[0];
  assert.ok(chat, 'a chat should exist');
  const msg = [...chat.msgs].reverse().find(m => m.role === 'ai');
  assert.ok(msg, 'an assistant reply should exist');
  return msg.reply;
}

function openImportFile(app, data) {
  const file = new app.window.File([JSON.stringify(data)], 'backup.json', { type: 'application/json' });
  const picker = app.document.querySelector('#f-import');
  Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
}

test('manual productivity pages render from the drawer: Tasks, Work, alarms, notes, Philosophy (no Reminders/Missions/Abilities)', async t => {
  const app = makeHarness();
  t.after(() => app.close());

  app.App.drawer(true);
  assert.equal(app.document.querySelector('#phone').classList.contains('open'), true);
  for (const [name, title] of [['tasks', 'Tasks'], ['work', 'Work projects'], ['alarms', 'Alarms & timers'], ['notes', 'Notes'], ['philosophy', 'Philosophy']]) {
    app.App.drawer(true);
    app.document.querySelector(`[data-nav="${name}"]`).click();
    await settle();
    assert.equal(app.App.view, name);
    assert.match(app.document.querySelector(`#v-${name}`).textContent, new RegExp(title.split(' ')[0], 'i'));
  }
  for (const gone of ['reminders', 'missions', 'abilities']) assert.equal(app.document.querySelector(`[data-nav="${gone}"]`), null, gone + ' page removed');
});
test('Philosophy page saves locally and every chat request carries it', async t => {
  const seen = [];
  const app = makeHarness({ route: async req => { seen.push(req); return { type: 'text', text: 'ok' }; } });
  t.after(() => app.close());
  app.App.show('philosophy');
  app.document.querySelector('#v-philosophy textarea').value = '  Sach pehle, phir aaram.  ';
  await clickButton(app.document, 'Save');
  assert.equal(app.S.philosophy, 'Sach pehle, phir aaram.');
  await app.Chat.submit('kya karun aaj');
  const req = seen.find(r => r.text === 'kya karun aaj');
  assert.ok(req, 'request sent');
  assert.equal(req.philosophy, 'Sach pehle, phir aaram.');
});

test('manual task and work forms create, edit, complete, and log records through current contracts', async t => {
  const app = makeHarness();
  t.after(() => app.close());

  app.App.show('tasks');
  input(app.document, 'New task title').value = 'Draft invoice';
  await clickButton(app.document, 'Add task');
  assert.equal(app.S.tasks.length, 1);
  assert.equal(app.S.tasks[0].title, 'Draft invoice');
  await clickButton(app.document, 'Edit task');
  const taskSheet = app.document.querySelector('.shade');
  input(taskSheet, 'Title').value = 'Draft final invoice';
  await clickButton(taskSheet, 'Save changes');
  assert.equal(app.S.tasks[0].title, 'Draft final invoice');
  await clickButton(app.document, 'Mark task complete');
  assert.equal(app.S.tasks[0].done, true);

  app.App.show('work');
  input(app.document, 'Project title').value = 'Launch workshop';
  input(app.document, 'Project category').value = 'Work';
  input(app.document, 'Project goal').value = 'Ship the public workshop';
  await clickButton(app.document, 'Add project');
  assert.equal(app.S.work.length, 1);
  assert.equal(app.S.work[0].goal, 'Ship the public workshop');
  await clickButton(app.document, 'Edit project');
  const editSheet = app.document.querySelector('.shade');
  input(editSheet, 'Progress percent').value = '25';
  input(editSheet, 'Outcome').value = 'Outline approved';
  await clickButton(editSheet, 'Save changes');
  assert.equal(app.S.work[0].progress, 25);
  assert.equal(app.S.work[0].outcome, 'Outline approved');
  await clickButton(app.document, 'Log activity');
  const logSheet = app.document.querySelector('.shade');
  input(logSheet, 'Minutes worked').value = '45';
  input(logSheet, 'Activity text').value = 'Prepared the outline';
  input(logSheet, 'Progress percent').value = '50';
  input(logSheet, 'Activity result').value = 'Outline ready for review';
  await clickButton(logSheet, 'Log activity');
  assert.equal(app.S.work[0].minutes, 45);
  assert.equal(app.S.work[0].entries.length, 1);
  assert.equal(app.S.work[0].entries[0].text, 'Prepared the outline');
  assert.equal(app.S.work[0].progress, 50);
});

test('manual timed-task reminder, alarm, timer, and note forms keep records in their own collections', async t => {
  const app = makeHarness();
  t.after(() => app.close());

  // Reminder = task with a time (Reminders page removed)
  app.App.show('tasks');
  input(app.document, 'New task title').value = 'Drink water';
  input(app.document, 'Due date and time').value = localDateTime();
  await clickButton(app.document, 'Add task');
  assert.equal(app.S.tasks.length, 1);
  assert.ok(app.S.tasks[0].at > Date.now());
  assert.equal(app.S.reminders.length, 0);

  app.App.show('alarms');
  input(app.document, 'New alarm').value = 'Stand-up';
  input(app.document, 'Alarm date and time').value = localDateTime(90);
  await clickButton(app.document, 'Schedule alarm');
  input(app.document, 'Timer minutes').value = '5';
  input(app.document, 'Timer label').value = 'Focus block';
  await clickButton(app.document, 'Start timer');
  assert.equal(app.S.alarms.length, 1);
  assert.equal(app.S.timers.length, 1);

  app.App.show('notes');
  input(app.document, 'New note').value = 'Questions for Monday';
  await clickButton(app.document, 'Save note');
  assert.equal(app.S.notes.length, 1);
  assert.equal(app.S.notes[0].text, 'Questions for Monday');
});

test('a timed task action is stored in S.tasks and never becomes a reminder', async t => {
  const at = future();
  const app = makeHarness({ route: async req => req.text === 'timed task' ? plan([step('timed', 'task.add', { title: 'Submit report', at })]) : { type: 'text', text: 'ok' } });
  t.after(() => app.close());

  await app.Chat.submit('timed task');
  assert.equal(app.S.tasks.length, 1);
  assert.equal(app.S.tasks[0].title, 'Submit report');
  assert.equal(app.S.tasks[0].at, at);
  assert.equal(app.S.reminders.length, 0);
});

test('typed and voice-originated chat commands share the local note/task action path', async t => {
  const app = makeHarness({ route: async req => {
    if (req.text === 'typed note') return plan([step('note', 'note.add', { text: 'Keep receipts' })]);
    if (req.text === 'voice task') return plan([step('task', 'task.add', { title: 'Call bank' })]);
    return { type: 'text', text: 'ok' };
  }});
  t.after(() => app.close());

  await app.Chat.submit('typed note');
  await app.Chat.submit('voice task', { voice: true });
  assert.equal(app.S.notes[0].text, 'Keep receipts');
  assert.equal(app.S.tasks[0].title, 'Call bank');
  assert.equal(app.requests.at(-1).meta.voice, true);
});

test('action progress does not replace step objects, and the reply is delivered only after execution saves its outcome', async t => {
  const app = makeHarness({ route: async req => req.text === 'save this' ? plan([
    step('save', 'note.add', { text: 'Saved before reply' })
  ], 'plan text') : { type: 'text', text: 'ok' } });
  t.after(() => app.close());
  const spoken = [];
  const off = app.Bus.on('reply', ({ msg }) => spoken.push({ text: msg.reply.text, saved: app.S.notes.some(n => n.text === 'Saved before reply') }));

  await app.Chat.submit('save this');
  off();
  const reply = lastReply(app);
  assert.equal(app.S.notes.length, 1);
  assert.equal(typeof reply.steps[0], 'object');
  assert.equal(reply.steps[0].action, 'note.add');
  assert.match(reply.text, /note save ho gaya/i);
  assert.deepEqual(spoken.at(-1), { text: reply.text, saved: true });
});

test('safe steps are not replayed when a later sensitive step is confirmed', async t => {
  const app = makeHarness();
  t.after(() => app.close());
  const d = plan([
    step('safe', 'note.add', { text: 'Only once' }),
    step('sensitive', 'message.draft', { text: 'Hello' }, { risk: 'high', detail: 'draft a message' })
  ]);

  await app.Actions.execute(d, false);
  assert.equal(app.S.notes.length, 1);
  assert.equal(d.run.state, 'pending');
  await app.Actions.execute(d, true);
  assert.equal(app.S.notes.length, 1, 'the already completed safe step must not run again');
  assert.equal(d.run.results.safe.ok, true);
  assert.equal(d.run.results.sensitive.ok, false);
});

test('a message confirmation cannot be bypassed by labelling the step risk=safe', async t => {
  const app = makeHarness();
  t.after(() => app.close());
  const d = plan([step('message', 'message.draft', { text: 'Do not send automatically' }, { risk: 'safe' })]);

  await app.Actions.execute(d, false);
  assert.equal(d.run.state, 'pending');
  assert.equal(d.run.results.message.pending, true);
  assert.equal(app.S.chats.length, 0);
});

test('AI-blocked actions remain rejected even when execute is called as confirmed', async t => {
  const app = makeHarness();
  t.after(() => app.close());
  const d = plan([step('blocked', 'note.clear', {}, { risk: 'high' })]);

  await app.Actions.execute(d, true);
  assert.equal(d.run.results.blocked.ok, false);
  assert.match(d.run.results.blocked.message, /disabled|allowed/i);
  assert.equal(app.S.notes.length, 0);
});

test('remote task and memory-shaped replies are display-only and never mutate local collections', async t => {
  const app = makeHarness({ route: async req => {
    if (req.text === 'remote task') return { type: 'task', title: 'Untrusted task proposal' };
    if (req.text === 'remote memory') return { type: 'memory', text: 'Untrusted memory proposal' };
    return { type: 'text', text: 'ok' };
  }});
  t.after(() => app.close());

  await app.Chat.submit('remote task');
  await app.Chat.submit('remote memory');
  assert.equal(app.S.tasks.length, 0);
  assert.equal(app.S.memories.length, 0);
  assert.match(app.S.chats[0].msgs.at(-1).reply.text, /Memory proposal/);
});

test('denied AI local access changes nothing, while the manual contract remains functional', async t => {
  const app = makeHarness();
  t.after(() => app.close());
  app.S.settings.aiAccess = { ...app.Productivity.access(), localRead: false, localEdit: false };

  const denied = await app.Productivity.run(step('ai', 'task.add', { title: 'AI must not add' }), false, false, 'standard');
  assert.equal(denied.ok, false);
  assert.equal(app.S.tasks.length, 0);
  const manual = await app.Productivity.manual('task.add', { title: 'Manual task' });
  assert.equal(manual.ok, true);
  assert.equal(app.S.tasks.length, 1);
  assert.equal(app.S.tasks[0].title, 'Manual task');
});

test('canonical sync failure with ok:false/error preserves the existing browser mirror', async t => {
  const existing = { id: 'keep-1', kind: 'task', title: 'Keep this mirror', text: 'Keep this mirror', created: Date.now(), at: 0, done: false };
  const app = makeHarness({ native: true, storage: { [STORAGE_KEY]: { tasks: [existing], settings: { ui4: 1 } } } });
  t.after(() => app.close());

  assert.equal(app.S.tasks.length, 1);
  assert.equal(app.S.tasks[0].id, 'keep-1');
  assert.equal(app.Productivity.sync(), false);
  assert.equal(JSON.stringify(app.S.tasks.map(x => x.id)), JSON.stringify(['keep-1']));
});

test('browser import/export covers every productivity collection and merges without deleting local records', async t => {
  const app = makeHarness();
  t.after(() => app.close());
  const records = [
    ['task', { title: 'Export task' }],
    ['reminder', { text: 'Export reminder', at: future(70) }],
    ['alarm', { text: 'Export alarm', at: future(80) }],
    ['timer', { text: 'Export timer', seconds: 120 }],
    ['note', { text: 'Export note' }],
    ['work', { title: 'Export project', goal: 'Export goal' }]
  ];
  for (const [kind, args] of records) {
    const r = await app.Productivity.manual(kind === 'timer' ? 'timer.start' : `${kind}.add`, args);
    assert.equal(r.ok, true, `${kind} should be manually addable`);
  }
  const localOnly = await app.Productivity.manual('note.add', { text: 'Do not delete me' });
  assert.equal(localOnly.ok, true);
  const exported = app.Productivity.exportRecords();
  assert.deepEqual(new Set(exported.map(r => r.kind)), new Set(['task', 'reminder', 'alarm', 'timer', 'note', 'work']));

  const replacement = exported.filter(r => r.text !== 'Do not delete me');
  assert.equal(app.Productivity.importRecords(replacement).ok, true);
  assert.equal(app.S.notes.some(n => n.text === 'Do not delete me'), true);
  assert.equal(app.S.tasks.some(r => r.title === 'Export task'), true);
  assert.equal(app.S.work.some(r => r.title === 'Export project'), true);
});

test('personalOnline defaults off, then sends only bounded relevant redacted records without secrets or whole state', async t => {
  const app = makeHarness();
  t.after(() => app.close());
  app.S.conn = { url: 'https://private.example/api', token: 'CONNECTION_SECRET' };
  app.S.tasks.push({ id: 'task-1', kind: 'task', title: 'Review api_key: TASK_VALUE', text: 'Review api_key: TASK_VALUE', done: false, created: Date.now() });
  app.S.notes.push({ id: 'note-1', kind: 'note', text: 'password: NOTE_VALUE; plan launch', created: Date.now() });
  assert.equal(app.Productivity.access().personalOnline, false);
  assert.equal(app.Productivity.modelContext('my tasks and notes', null), undefined);

  app.S.settings.aiAccess = { ...app.Productivity.access(), personalOnline: true };
  const context = app.Productivity.modelContext('my tasks and notes plan', null);
  assert.ok(context);
  const encoded = JSON.stringify(context);
  assert.doesNotMatch(encoded, /TASK_VALUE|NOTE_VALUE|CONNECTION_SECRET/);
  assert.doesNotMatch(encoded, /"conn"|"settings"|"lock"|"token"/i);
  assert.ok(encoded.length <= 2600, 'online context should remain bounded');
  assert.ok(context.records.length <= 12);
});

test('online context selects matching memories and recent project versions, excluding unrelated records', async t => {
  const app = makeHarness();
  t.after(() => app.close());
  app.S.settings.aiAccess = { ...app.Productivity.access(), personalOnline: true };
  app.S.memories = [
    { id: 'mem-style', text: 'Sir ko Hinglish mein step-by-step robot concepts samajhna pasand hai', created: Date.now() },
    { id: 'mem-unrelated', text: 'Favourite cricket team ka match schedule', created: Date.now() }
  ];
  app.S.projects = [{ id: 'project-1', name: 'Robot arm', why: '', status: 'active', concepts: [], created: Date.now(), updated: Date.now(), versions: [
    { v: 1, aim: 'Old unrelated idea', learned: 'old', next: 'old' },
    { v: 2, aim: 'Robot arm torque tests', learned: 'motor stalls', next: 'measure torque' },
    { v: 3, aim: 'Improve robot arm torque', learned: 'gear ratio matters', next: 'test new gears' }
  ] }];

  const context = app.Productivity.modelContext('Explain torque for the robot arm in Hinglish', null);
  assert.ok(context);
  const encoded = JSON.stringify(context);
  assert.match(encoded, /Sir ko Hinglish/);
  assert.doesNotMatch(encoded, /cricket team/);
  assert.match(encoded, /Robot arm torque tests/);
  assert.match(encoded, /Improve robot arm torque/);
  assert.doesNotMatch(encoded, /Old unrelated idea/);

  app.S.settings.aiAccess.personalOnline = false;
  assert.equal(app.Productivity.modelContext('Explain torque for the robot arm in Hinglish', null), undefined);
});

test('old-chat context requires its separate opt-in and follows the old-chat intent', async t => {
  const app = makeHarness();
  t.after(() => app.close());
  app.S.chats = [
    { id: 'current', msgs: [], ts: Date.now() },
    { id: 'old', msgs: [{ role: 'user', text: 'The old launch decision was Friday' }], ts: Date.now() - 1000 }
  ];
  app.S.settings.aiAccess = { ...app.Productivity.access(), personalOnline: true, oldChats: false };
  assert.equal(app.Productivity.modelContext('old chat launch decision', 'current'), undefined);
  app.S.settings.aiAccess.oldChats = true;
  const context = app.Productivity.modelContext('old chat launch decision', 'current');
  assert.equal(context.oldChats.length, 1);
  assert.match(context.oldChats[0].text, /Friday/);
});

test('mode is captured before async attachment IO, and voice keeps the selected answer source', async t => {
  const app = makeHarness({ route: async req => ({ type: 'text', text: `received ${req.mode}/${req.source}` }) });
  t.after(() => app.close());
  const OriginalReader = app.window.FileReader;
  app.window.FileReader = class DelayedReader {
    readAsDataURL(file) { this.result = `data:${file.type};base64,ZmFrZQ==`; app.window.setTimeout(() => this.onload(), 15); }
  };
  app.Modes.set('physics');
  app.Chat.addFile(new app.window.File(['x'], 'brief.txt', { type: 'text/plain' }));
  app.Chat.setDraft('attachment query');
  const pending = app.Chat.submit();
  app.Modes.set('coding');
  await pending;
  assert.equal(app.requests.at(-1).mode, 'physics');
  app.window.FileReader = OriginalReader;

  app.S.settings.source = 'manual';
  app.Chat.sourceSheet();
  const sourceSheet = app.document.querySelector('.shade');
  await clickButton(sourceSheet, 'Manual');
  const answer = sourceSheet.querySelector('[aria-label="Answer 1 text"]');
  answer.value = 'Use the selected source';
  answer.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await clickButton(sourceSheet, 'Done');
  app.Voice.open();
  assert.equal(app.document.querySelector('.chipbtn[aria-pressed="false"]')?.textContent, 'Hands-free');
  const voiceInput = input(app.document, 'Type a message');
  voiceInput.value = 'voice source query';
  voiceInput.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  while (app.Chat.isBusy()) await settle(1);
  assert.equal(app.requests.at(-1).source, 'manual');
  assert.equal(JSON.stringify(app.requests.at(-1).meta), JSON.stringify({ voice: true }));
});

test('closing voice during a pending confirmation does not restart the microphone; contradictory answers and timeout stay pending', async t => {
  let currentAnswer = null;
  const app = makeHarness({ route: async req => plan([
    step(req.text, 'message.draft', { text: req.text }, { risk: 'high', detail: req.text })
  ]) });
  t.after(() => app.close());
  const listeners = { partial: [], final: [], state: [] };
  let starts = 0;
  app.STT.dict = {
    onPartial(fn) { listeners.partial.push(fn); return () => { listeners.partial = listeners.partial.filter(x => x !== fn); }; },
    onFinal(fn) { listeners.final.push(fn); return () => { listeners.final = listeners.final.filter(x => x !== fn); }; },
    onState(fn) { listeners.state.push(fn); return () => { listeners.state = listeners.state.filter(x => x !== fn); }; },
    start() { starts++; return Promise.resolve(); },
    stop() { return Promise.resolve(); }
  };
  const emitFinal = text => { currentAnswer = text; listeners.final.slice().forEach(fn => fn({ text })); listeners.state.slice().forEach(fn => fn({ state: 'idle', reason: 'final' })); };

  app.Voice.open();
  assert.equal(app.document.querySelector('.chipbtn[aria-pressed="false"]')?.textContent, 'Hands-free');
  let voiceInput = input(app.document, 'Type a message');
  voiceInput.value = 'close pending';
  voiceInput.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  const startsBeforeClose = starts;
  app.Voice.close();
  await settle(10);
  assert.equal(app.Voice.isOpen, false);
  assert.equal(starts, startsBeforeClose, 'closing a pending prompt must not restart the microphone');

  app.Voice.open();
  voiceInput = input(app.document, 'Type a message');
  voiceInput.value = 'contradictory';
  voiceInput.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.ok(starts >= 1);
  emitFinal('haan nahi');
  await settle(10);
  const contradictory = lastReply(app);
  assert.equal(contradictory.run.state, 'pending');

  const originalTimeout = app.window.setTimeout;
  app.window.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 7000 ? 5 : ms, ...args);
  app.Voice.open();
  voiceInput = input(app.document, 'Type a message');
  voiceInput.value = 'unrecognized';
  voiceInput.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle(20);
  const timeoutReply = lastReply(app);
  assert.equal(timeoutReply.run.state, 'pending');
  app.window.setTimeout = originalTimeout;
  assert.equal(currentAnswer, 'haan nahi');
});


test('local note and task-list commands are excluded from the next ordinary request history when sharing is off', async t => {
  const app = makeHarness({ route: async req => {
    if (req.text === 'local note') return plan([step('note', 'note.add', { text: 'Private note' })]);
    if (req.text === 'local task list') return plan([step('list', 'task.list')]);
    return { type: 'text', text: 'ordinary answer' };
  }});
  t.after(() => app.close());

  await app.Chat.submit('local note');
  await app.Chat.submit('local task list');
  await app.Chat.submit('ordinary question');
  const ordinary = app.requests.at(-1);
  assert.equal(JSON.stringify(ordinary.history), JSON.stringify([]));
  assert.equal(ordinary.app_context, undefined);
  assert.equal(app.S.settings.aiAccess.personalOnline, false);
});

test('a personal-context reply is not retained in later history after online sharing is toggled off', async t => {
  const app = makeHarness({ route: async req => req.text === 'my tasks' ? { type: 'text', text: 'Context task surfaced' } : { type: 'text', text: req.text } });
  t.after(() => app.close());
  app.S.tasks.push({ id: 'task-ctx', kind: 'task', title: 'Context task', text: 'Context task', created: Date.now(), done: false });
  app.S.settings.aiAccess = { ...app.Productivity.access(), personalOnline: true };

  await app.Chat.submit('my tasks');
  assert.ok(app.requests[0].app_context);
  app.S.settings.aiAccess.personalOnline = false;
  await app.Chat.submit('ordinary follow-up');
  assert.equal(app.requests[1].history.some(x => /Context task/i.test(x.text)), false);
});

test('attachment IO keeps the original chat and mode, and busy blocks a second send race', async t => {
  const app = makeHarness({ route: async req => ({ type: 'text', text: 'attachment received' }) });
  t.after(() => app.close());
  const first = app.Chat.newChat();
  first.msgs.push({ id: 'old-user', role: 'user', text: 'Prior question' });
  first.msgs.push({ id: 'old-ai', role: 'ai', reply: { type: 'text', text: 'Prior answer' } });
  app.S.cur = first.id;
  app.Chat.renderThread();
  app.window.FileReader = class DelayedReader {
    readAsDataURL(file) { this.result = `data:${file.type};base64,ZmFrZQ==`; app.window.setTimeout(() => this.onload(), 25); }
  };
  app.Modes.set('physics');
  app.Chat.addFile(new app.window.File(['x'], 'brief.txt', { type: 'text/plain' }));
  app.Chat.setDraft('attachment query');
  const request = app.Chat.submit();
  assert.equal(app.Chat.isBusy(), true);
  const second = app.Chat.submit('raced second send');
  assert.equal(typeof second.then, 'function');
  app.Chat.newChat();
  await second;
  await request;
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].chatId, first.id);
  assert.equal(app.requests[0].mode, 'physics');
  assert.equal(app.requests[0].history.some(x => x.text === 'Prior question' || x.text === 'Prior answer'), true);
  assert.equal(first.msgs.filter(m => m.role === 'user' && m.text === 'raced second send').length, 0);
});

test('untimed task export omits scheduling aliases and is accepted by a fake native importer', async t => {
  let imported;
  const app = makeHarness({ native: true, nativeOverrides: {
    recordsList: () => JSON.stringify({ ok: true, records: [] }),
    recordsImport: payload => { imported = JSON.parse(payload); return JSON.stringify({ ok: true }); }
  }});
  t.after(() => app.close());
  const exported = app.Productivity.safeRecord({ id: 'untimed', kind: 'task', title: 'No schedule', text: 'No schedule', created: 1, at: 0, due: null, ts: 99, done: false });
  assert.equal(exported.at, undefined);
  assert.equal(exported.due, undefined);
  assert.equal(exported.ts, undefined);
  const result = app.Productivity.importRecords([exported]);
  assert.equal(result.ok, true);
  assert.equal(imported.records[0].id, 'untimed');
  assert.equal('at' in imported.records[0], false);
  assert.equal('due' in imported.records[0], false);
  assert.equal('ts' in imported.records[0], false);
});

test('native migration excludes an existing canonical ID so the native mirror wins over a newer legacy browser copy', async t => {
  let imported;
  const mirror = { id: 'same-id', kind: 'task', title: 'Newer browser mirror', text: 'Newer browser mirror', created: Date.now() + 100000, updated: Date.now() + 100000, done: false };
  const canonical = { id: 'same-id', kind: 'task', title: 'Canonical native task', created: 1, done: false };
  const app = makeHarness({ native: true, storage: { [STORAGE_KEY]: { tasks: [mirror], settings: { ui4: 1 } } }, nativeOverrides: {
    recordsList: () => JSON.stringify({ ok: true, records: [canonical] }),
    recordsImport: payload => { imported = JSON.parse(payload); return JSON.stringify({ ok: true }); }
  }});
  t.after(() => app.close());
  assert.equal(app.S.tasks.length, 1);
  assert.equal(app.S.tasks[0].title, 'Canonical native task');
  assert.equal(imported.records.some(r => r.id === 'same-id'), false);
});


test('old-chat context filters local-only commands and action replies even when explicitly enabled', async t => {
  const app = makeHarness(); t.after(() => app.close());
  app.S.settings.aiAccess = { ...app.Productivity.access(), personalOnline: true, oldChats: true };
  app.S.chats = [{ id: 'current', msgs: [] }, { id: 'old', msgs: [
    { role: 'user', text: 'SECRETLOCAL save this note', localOnly: true },
    { role: 'ai', reply: { type: 'actions', text: 'SECRETLOCAL record saved', origin: 'local-rule', steps: [] } },
    { role: 'user', text: 'SECRETLOCAL ordinary conversation' }
  ] }];
  const context = app.Productivity.modelContext('old chat SECRETLOCAL', 'current');
  assert.equal(context.oldChats.length, 1);
  assert.equal(context.oldChats[0].text, 'SECRETLOCAL ordinary conversation');
  assert.equal(JSON.stringify(context).includes('record saved'), false);
  assert.equal(JSON.stringify(context).includes('save this note'), false);
});

test('voice submissions consume pasted answers once, and cross-chat Retry keeps the original source without switching selected mode', async t => {
  const app = makeHarness(); t.after(() => app.close());
  app.S.settings.source = 'manual'; app.Chat.sourceSheet();
  let shade = app.document.querySelector('.shade'); await clickButton(shade, 'Manual');
  let answer = shade.querySelector('[aria-label="Answer 1 text"]');
  answer.value = 'Only original A answer'; answer.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await clickButton(shade, 'Done');
  await app.Chat.submit('Question A', { voice: true });
  const chatA = app.Chat.cur();
  assert.equal(app.requests[0].answers[0].text, 'Only original A answer');
  await app.Chat.submit('Question without new paste', { voice: true });
  assert.equal(app.requests.length, 1); // no reused answer and no silent Auto request
  shade = app.document.querySelector('.shade'); await clickButton(shade, 'Done');
  app.S.settings.source = 'auto'; app.Chat.newChat(); app.Modes.set('coding');
  await app.Chat.submit('Question B');
  app.Chat.open(chatA.id); await clickButton(app.document.querySelector('#v-chat'), 'Retry');
  while (app.Chat.isBusy()) await settle(1);
  const retry = app.requests.at(-1);
  assert.equal(retry.text, 'Question A'); assert.equal(retry.source, 'manual');
  assert.equal(retry.answers[0].text, 'Only original A answer');
  assert.equal(retry.mode, 'coding'); assert.equal(app.Modes.current().id, 'coding');
});

test('safe-setting rule values execute end-to-end and successful local plans have no replay Retry button', async t => {
  const { spawnSync } = require('node:child_process');
  const app = makeHarness({ route: async req => {
    const root = path.resolve(UI, '..');
    const result = spawnSync('python3', ['-c', 'import json,sys; from actions.plan import plan; print(json.dumps(plan(sys.argv[1])))', req.text], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } }); t.after(() => app.close());
  await app.Chat.submit('settings voice rate 1.2'); assert.equal(app.S.settings.rate, 1.2);
  await app.Chat.submit('settings voice engine system'); assert.equal(app.S.settings.voiceEngine, 'device');
  await app.Chat.submit('settings haptics off'); assert.equal(app.S.settings.haptics, false);
  await app.Chat.submit('task add karo no duplicate'); assert.equal(app.S.tasks.length, 1);
  assert.equal(app.document.querySelector('#v-chat button[aria-label="Retry"]'), null);
});


test('updater checks on boot but only explicit buttons download and invoke the installer', async t => {
  const calls = []; let update = { ok: true, state: 'current', installedVersion: '1.0.1' };
  const app = makeHarness({ native: true, nativeOverrides: {
    updateStatus: () => JSON.stringify(update),
    updateCheck: force => { calls.push(['check', force]); return JSON.stringify(update); },
    updateDownload: () => { calls.push(['download']); update = { ...update, state: 'downloading', progress: 0 }; return JSON.stringify(update); },
    updateInstall: () => { calls.push(['install']); return JSON.stringify({ ...update, state: 'permission_required' }); }
  } }); t.after(() => app.close());
  assert.deepEqual(calls, [['check', false]]);
  app.App.show('settings'); await clickButton(app.document, 'App updates');
  await clickButton(app.document.querySelector('.shade'), 'Check for updates');
  assert.deepEqual(calls.at(-1), ['check', true]);
  app.window.__adarshUpdate({ ok: true, state: 'available', versionCode: 2, versionName: '1.0.2', notes: '<script>never execute</script>' });
  assert.equal(calls.some(x => x[0] === 'download'), false);
  const shade = app.document.querySelector('.shade'); await clickButton(shade, 'Update now');
  assert.equal(calls.filter(x => x[0] === 'download').length, 1);
  app.window.__adarshUpdate({ ok: true, state: 'ready', versionCode: 2 });
  assert.equal(calls.some(x => x[0] === 'install'), false);
  await clickButton(shade, 'Install update'); assert.equal(calls.filter(x => x[0] === 'install').length, 1);
});

test('background voice is off at boot, rejects Manual without switching, and snapshots selected mode without credentials', async t => {
  const starts = []; let status = { ok: true, active: false, state: 'stopped' };
  const app = makeHarness({ native: true, nativeOverrides: {
    backgroundVoiceStatus: () => JSON.stringify(status), backgroundVoicePeek: () => '[]',
    backgroundVoiceStart: raw => { const config = JSON.parse(raw); starts.push(config); status = { ok: true, active: true, state: 'listening', mode: config.mode }; return JSON.stringify(status); },
    backgroundVoiceStop: () => { status = { ok: true, active: false, state: 'stopped' }; return JSON.stringify(status); }, backgroundVoiceAck: () => '{"ok":true}'
  } }); t.after(() => app.close());
  assert.equal(starts.length, 0); app.S.settings.source = 'manual'; app.BackgroundVoice.start();
  assert.equal(starts.length, 0); assert.equal(app.S.settings.source, 'manual');
  app.S.settings.source = 'auto'; app.S.conn.token = 'PRIVATE_TOKEN'; app.S.lock = null;
  app.Modes.set('physics'); app.BackgroundVoice.start();
  assert.equal(starts.length, 1); assert.equal(starts[0].mode, 'physics'); assert.equal(starts[0].source, 'auto');
  assert.equal(JSON.stringify(starts[0]).includes('PRIVATE_TOKEN'), false);
  assert.equal(starts[0].access.personalOnline, false);
  app.Modes.set('coding'); assert.equal(app.BackgroundVoice.active(), false);
  app.BackgroundVoice.start(); app.App.show('settings'); assert.equal(app.BackgroundVoice.active(), false);
});

test('background inbox persists once, preserves mode/localOnly and never executes already completed actions', async t => {
  const actions = [], acks = []; let rows = [];
  const app = makeHarness({ native: true, nativeOverrides: {
    recordsList: () => '{"ok":true,"records":[]}', backgroundVoiceStatus: () => '{"active":false,"state":"stopped"}',
    backgroundVoiceStart: () => '{"ok":true,"active":true}', backgroundVoiceStop: () => '{"ok":true,"active":false}',
    backgroundVoicePeek: () => JSON.stringify(rows), backgroundVoiceAck: raw => { acks.push(JSON.parse(raw)); return '{"ok":true}'; },
    runActions: raw => { actions.push(raw); return '{"results":[]}'; }
  } }); t.after(() => app.close());
  rows = [{ id: 'turn1', chatId: 'voice-chat', text: 'task add private', mode: 'standard', ts: Date.now(), localOnly: true,
    reply: { ...plan([step('s1', 'task.add', { title: 'private' })]), run: { state: 'done', results: { s1: { id: 's1', ok: true, message: 'saved' } } } } }];
  app.BackgroundVoice.sync(); app.BackgroundVoice.sync();
  assert.equal(actions.length, 0); assert.equal(app.S.chats[0].msgs.length, 2); assert.equal(acks.length, 2);
  assert.equal(app.S.chats[0].msgs[0].localOnly, true);
  assert.equal(app.S.chats[0].msgs[1].reply.uiMode, 'standard');
  assert.equal(JSON.stringify(app.Chat.history(app.S.chats[0])), '[]');
  assert.equal(JSON.parse(app.window.localStorage.getItem(STORAGE_KEY)).chats[0].msgs.length, 2);
});

test('background inbox remains unacknowledged on failed browser persistence', async t => {
  const acks = []; let rows = [];
  const app = makeHarness({ native: true, nativeOverrides: {
    backgroundVoiceStatus: () => '{"active":false}', backgroundVoiceStart: () => '{"ok":true}', backgroundVoiceStop: () => '{"ok":true,"active":false}',
    backgroundVoicePeek: () => JSON.stringify(rows), backgroundVoiceAck: raw => { acks.push(raw); return '{"ok":true}'; }
  } }); t.after(() => app.close());
  rows = [{ id: 'pending', chatId: 'v', text: 'question', mode: 'coding', reply: { type: 'text', text: 'answer' } }];
  const prototype = Object.getPrototypeOf(app.window.localStorage), original = prototype.setItem;
  prototype.setItem = () => { throw new Error('quota full'); };
  app.BackgroundVoice.sync(); assert.equal(acks.length, 0);
  prototype.setItem = original; app.BackgroundVoice.sync(); assert.equal(acks.length, 1);
  assert.equal(app.S.chats.find(c => c.id === 'v').msgs.length, 2);
});

test('background reply events preserve active state and permission starts remain cancellable on source changes', async t => {
  let stops = 0, rows = [], status = { ok: true, active: false, state: 'inactive' };
  const app = makeHarness({ native: true, nativeOverrides: {
    backgroundVoiceStatus: () => JSON.stringify(status),
    backgroundVoiceStart: () => { status = { ok: true, active: false, state: 'permission_required' }; return JSON.stringify(status); },
    backgroundVoiceStop: () => { stops++; return '{"ok":true,"active":false,"state":"stopped"}'; },
    backgroundVoicePeek: () => JSON.stringify(rows), backgroundVoiceAck: () => '{"ok":true}'
  } }); t.after(() => app.close());
  app.BackgroundVoice.start(); assert.equal(app.BackgroundVoice.active(), true);
  app.BackgroundVoice.open(); assert.ok(button(app.document.querySelector('.shade'), 'Stop background voice'));
  await clickButton(app.document.querySelector('.shade'), 'Close controls');
  app.Chat.sourceSheet(); await clickButton(app.document.querySelector('.shade'), 'Manual');
  assert.equal(stops, 1); assert.equal(app.BackgroundVoice.active(), false); assert.equal(app.S.settings.source, 'manual');
  await clickButton(app.document.querySelector('.shade'), 'Done');
  app.window.__adarshBackgroundVoice({ ok: true, active: true, state: 'listening', mode: 'coding' });
  rows = [{ id: 'reply-event', chatId: 'current', text: 'query', mode: 'coding', reply: { type: 'text', text: 'answer' } }];
  app.window.__adarshBackgroundVoice({ type: 'reply', record: rows[0] });
  assert.equal(app.BackgroundVoice.active(), true); assert.equal(app.BackgroundVoice.status().mode, 'coding');
  assert.equal(app.S.chats.find(c => c.id === 'current').msgs.length, 2);
  app.BackgroundVoice.stop(); assert.equal(app.BackgroundVoice.active(), false);
});

test('native background errors are visible and voice typing stops a competing session', async t => {
  let stops = 0;
  const app = makeHarness({ native: true, nativeOverrides: {
    backgroundVoiceStatus: () => '{"active":false}', backgroundVoicePeek: () => '[]',
    backgroundVoiceStart: () => '{"ok":false,"error":"Enable notifications before starting background voice"}',
    backgroundVoiceStop: () => { stops++; return '{"ok":true,"active":false,"state":"stopped"}'; }
  } }); t.after(() => app.close());
  // No manual start button any more: Standard live voice hands off on Back/Home; the error still shows in the sheet.
  assert.ok(!button(app.document, 'Start background voice'));
  app.BackgroundVoice.open(); app.BackgroundVoice.start();
  assert.ok(!button(app.document.querySelector('.shade'), 'Start background voice'));
  assert.equal(app.BackgroundVoice.active(), false);
  assert.match(textOf(app.document.querySelector('.shade')), /Enable notifications/);
  await clickButton(app.document.querySelector('.shade'), 'Close controls');
  app.window.__adarshBackgroundVoice({ active: true, state: 'listening' });
  await clickButton(app.document, 'Dictate'); assert.equal(stops, 1); assert.equal(app.BackgroundVoice.active(), false);
});

test('one foreground sync imports the complete bounded native inbox in acknowledged batches', async t => {
  let rows = [], ackCount = 0;
  const app = makeHarness({ native: true, nativeOverrides: {
    backgroundVoiceStatus: () => '{"active":false}', backgroundVoiceStart: () => '{"ok":true}', backgroundVoiceStop: () => '{"active":false}',
    backgroundVoicePeek: () => JSON.stringify(rows), backgroundVoiceAck: raw => {
      const ids = JSON.parse(raw); rows = rows.filter(r => !ids.includes(r.id)); ackCount++; return '{"ok":true}';
    }
  } }); t.after(() => app.close());
  rows = Array.from({ length: 64 }, (_, i) => ({ id: 'batch-' + i, chatId: 'batch-chat', text: 'q' + i, mode: 'standard', reply: { type: 'text', text: 'a' + i } }));
  app.BackgroundVoice.sync(); await settle(20);
  assert.equal(rows.length, 0); assert.equal(ackCount, 2);
  assert.equal(app.S.chats.find(c => c.id === 'batch-chat').msgs.length, 128);
});

test('background personal-context provenance remains excluded after online sharing is disabled', async t => {
  let rows = [];
  const app = makeHarness({ native: true, nativeOverrides: {
    backgroundVoiceStatus: () => '{"active":false}', backgroundVoiceStart: () => '{"ok":true}', backgroundVoiceStop: () => '{"active":false}',
    backgroundVoicePeek: () => JSON.stringify(rows), backgroundVoiceAck: () => '{"ok":true}'
  } }); t.after(() => app.close());
  app.S.settings.aiAccess = { ...app.Productivity.access(), personalOnline: true, localRead: true };
  rows = [{ id: 'private-derived', chatId: 'private-chat', text: 'Follow up on my earlier plan', mode: 'coding', personalContext: true, reply: { type: 'text', text: 'PRIVATE_DERIVED_CONTEXT' } }];
  app.BackgroundVoice.sync();
  const c = app.S.chats.find(c => c.id === 'private-chat');
  assert.equal(app.Chat.history(c).length, 2);
  app.S.settings.aiAccess.personalOnline = false;
  assert.equal(app.Chat.history(c).length, 0);
  assert.equal(c.msgs.every(m => m.personalContext === true), true);
});
test('live voice screen arms the outside-app handoff in any selected mode and disarms on close', async t => {
  const arms = [];
  const app = makeHarness({ native: true, nativeOverrides: {
    backgroundVoiceStatus: () => '{"active":false,"state":"stopped"}', backgroundVoicePeek: () => '[]',
    backgroundVoiceStart: () => '{"ok":true}', backgroundVoiceStop: () => '{"ok":true,"active":false}', backgroundVoiceAck: () => '{"ok":true}',
    backgroundVoiceArm: raw => { arms.push(raw); return JSON.stringify({ ok: true, armed: !!raw, notifications: true }); }
  } }); t.after(() => app.close());
  app.S.lock = null; app.S.settings.source = 'auto';
  app.Modes.set('physics'); app.Voice.open();
  const cfg = arms.filter(Boolean).map(r => JSON.parse(r)).at(-1);
  assert.ok(cfg, 'voice screen must hand a ready config to the phone');
  assert.equal(cfg.mode, 'physics'); assert.equal(cfg.source, 'auto');
  app.Voice.close(); assert.equal(arms.at(-1), '');
  app.S.settings.source = 'manual'; app.Voice.open(); assert.equal(arms.at(-1), '');
});
test('AI can change app settings on command but never API keys, chats or the PIN', async t => {
  const { spawnSync } = require('node:child_process');
  const app = makeHarness({ route: async req => {
    const root = path.resolve(UI, '..');
    const result = spawnSync('python3', ['-c', 'import json,sys; from actions.plan import plan; print(json.dumps(plan(sys.argv[1])))', req.text], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } }); t.after(() => app.close());
  await app.Chat.submit('web search off karo'); assert.equal(app.S.settings.webSearch, false);
  await app.Chat.submit('startup animation band kar do'); assert.equal(app.S.settings.bootAnim, false);
  await app.Chat.submit('council deep karo aur depth detailed karo'); assert.equal(app.S.settings.think, 'deep'); assert.equal(app.S.settings.depth, 'detailed');
  await app.Chat.submit('model calls dikhao'); assert.equal(app.S.settings.calls, 1);
  await app.Chat.submit('physics mode on karo'); assert.equal(app.Modes.current().id, 'physics');
  await app.Chat.submit('standard mode pe jao'); assert.equal(app.Modes.current().id, 'standard');
  const chats = app.S.chats.length, lock = app.S.settings.lockOnHide;
  await app.Chat.submit('sare chats delete karo'); await app.Chat.submit('api key change karo'); await app.Chat.submit('lock on hide off karo');
  assert.ok(app.S.chats.length >= chats); assert.equal(app.S.settings.lockOnHide, lock);
});
