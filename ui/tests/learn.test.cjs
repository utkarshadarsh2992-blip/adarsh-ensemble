'use strict';
/* Change 1.2 (js/03-learn.js): check questions checked on the phone, learned words, Standard 2.9 / 9.2. */
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

const LEARN = {
  concept: 'Inertia', heavy: true,
  checks: [
    { kind: 'mcq', q: 'Bus ruke to aage kyun girte ho?', options: ['Gravity', 'Inertia', 'Friction'], answer: 1, why: 'Body chalti rehna chahti hai.' },
    { kind: 'fill', q: 'Pehla law kis cheez ka hai?', answer: 'inertia', accept: ['jadatva'], why: 'Law of inertia.' }
  ],
  words: [{ w: 'Inertia', m: 'haalat na badalne ki aadat' }, { w: 'Force', m: 'dhakka ya kheench' }]
};

function mount({ settings, store, reply } = {}) {
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
  w.localStorage.setItem('adarsh.ui.v3', JSON.stringify({ ...(store || {}), settings: { ui4: 1, bootAnim: false, ...(settings || {}) } }));
  const sent = [];
  w.ADARSH_BACKEND = {
    async send(req) { sent.push(JSON.parse(JSON.stringify(req))); return typeof reply === 'function' ? reply(req) : (reply || { type: 'text', text: 'ok' }); },
    async ping() { return { ok: true, label: 'test' }; }
  };
  const ctx = dom.getInternalVMContext();
  for (const file of ORDER) new vm.Script(fs.readFileSync(path.join(UI, 'src', file), 'utf8'), { filename: path.join(UI, 'src', file) }).runInContext(ctx);
  new vm.Script('globalThis.TEST = { S, Chat, Learn, Modes, App };').runInContext(ctx);
  return { dom, window: w, document: w.document, sent, ...w.TEST, close: () => dom.window.close() };
}
const stdReply = () => ({ type: 'text', text: 'Inertia (jadatva) matlab...', std: '2.9', learn: JSON.parse(JSON.stringify(LEARN)), deeper: { q: 'Inertia kya hai?' } });

test('answer checking is local: MCQ index, fill-in spellings, numbers and short phrases', () => {
  const app = mount();
  try {
    const { Learn } = app;
    assert.equal(Learn.isRight(LEARN.checks[0], 1), true);
    assert.equal(Learn.isRight(LEARN.checks[0], 0), false);
    assert.equal(Learn.isRight(LEARN.checks[1], ' INERTIA '), true);
    assert.equal(Learn.isRight(LEARN.checks[1], 'jadatva'), true);
    assert.equal(Learn.isRight(LEARN.checks[1], 'inertia hai'), true);
    assert.equal(Learn.isRight(LEARN.checks[1], 'momentum'), false);
    assert.equal(Learn.isRight(LEARN.checks[1], ''), false);
    const n = { kind: 'fill', answer: '9.8', accept: [] };
    assert.equal(Learn.isRight(n, '9.81'), true);
    assert.equal(Learn.isRight(n, '12'), false);
    assert.equal(Learn.same('गुरुत्वाकर्षण', 'गुरुत्वाकर्षण'), true);   /* Devanagari matras are kept */
    assert.equal(Learn.same('गुरु', 'गुरुत्वाकर्षण'), false);
  } finally { app.close(); }
});

test('Standard request carries the style and the learned words; reply words are saved at once', async () => {
  const app = mount({ settings: { stdStyle: '9.2' }, store: { vocab: [{ id: 'w1', w: 'Mass', m: 'maal', ts: 5 }] }, reply: stdReply });
  try {
    await app.Chat.submit('Inertia kya hai?');
    await until(() => app.sent.length === 1 && !app.Chat.isBusy());
    const req = app.sent[0];
    assert.equal(req.reply.std, '9.2');
    assert.equal(req.learn.known.join(','), 'Mass');
    assert.equal(req.learn.checks, true);
    assert.equal(app.S.vocab.map(x => x.w).sort().join(','), 'Force,Inertia,Mass');
    const words = app.document.querySelector('.lwords');
    assert.match(text(words), /NAYE SHABD.*Inertia · Force/);
  } finally { app.close(); }
});

test('check card: MCQ tap and fill-in are checked without any backend call', async () => {
  const app = mount({ reply: stdReply });
  try {
    await app.Chat.submit('Inertia kya hai?');
    await until(() => !app.Chat.isBusy() && app.document.querySelector('.lcheck'));
    const card = () => app.document.querySelector('.lcheck');
    assert.match(text(card().querySelector('.lc-h')), /CHECK.*Inertia.*REASONING.*0\/2/);
    const wrong = [...card().querySelectorAll('.lc-opt')][0];
    wrong.click();
    assert.ok(card().querySelector('.lc-opt.wrong') && card().querySelector('.lc-opt.right'));
    assert.match(text(card()), /Galat\. Kyun: Body chalti rehna chahti hai\./);
    const inp = card().querySelector('.lc-in');
    inp.value = 'Jadatva'; inp.dispatchEvent(new app.window.Event('input'));
    card().querySelector('.lc-go').click();
    assert.match(text(card().querySelector('.lc-h')), /1\/2/);
    assert.match(text(card()), /Tumhara: Jadatva/);
    assert.equal(app.sent.length, 1, 'checking never calls the backend');
    assert.equal(app.S.learnLog.length, 2);
    assert.equal(app.S.learnLog.map(x => x.ok).sort().join(','), 'false,true');
  } finally { app.close(); }
});

test('no "Gehrai mein jao" / "Samajh gaya" buttons under a Standard 2.9 answer', async () => {
  const app = mount({ settings: { mode: 'standard', stdStyle: '2.9' }, reply: stdReply });
  try {
    await app.Chat.submit('Inertia kya hai?');
    await until(() => !app.Chat.isBusy() && app.document.querySelector('.msg'));
    assert.equal(app.document.querySelector('.ldeep'), null);
    assert.doesNotMatch(app.document.body.textContent, /Gehrai mein jao|Samajh gaya/);
  } finally { app.close(); }
});

test('mode picker shows Standard 2.9 and 9.2; choosing one changes only the style', () => {
  const app = mount({ settings: { mode: 'standard', stdStyle: '2.9' } });
  try {
    const btn = app.document.querySelector('.modebtn');
    assert.match(text(btn), /Standard 2\.9/);
    btn.click();
    const items = [...app.document.querySelectorAll('.pop-item')];
    const names = items.map(i => text(i.querySelector('b')));
    assert.equal(names.slice(0, 2).join(','), 'Standard 2.9,Standard 9.2');
    assert.equal(items[0].getAttribute('aria-checked'), 'true');
    items[1].click();
    assert.equal(app.S.settings.stdStyle, '9.2');
    assert.equal(app.S.settings.mode, 'standard');
    assert.match(text(app.document.querySelector('.modebtn')), /Standard 9\.2/);
  } finally { app.close(); }
});

test('check questions off is sent to the backend; Seekhe shabd sheet adds, finds and deletes', async () => {
  const app = mount({ settings: { checks: false } });
  try {
    await app.Chat.submit('hello there friend');
    await until(() => app.sent.length === 1 && !app.Chat.isBusy());
    assert.equal(app.sent[0].learn.checks, false);
    app.Learn.vocabSheet();
    const sh = app.document.querySelector('.sheet');
    const [word, meaning] = sh.querySelectorAll('.frow input');
    word.value = 'Orbit'; meaning.value = 'gol chakkar ka raasta';
    [...sh.querySelectorAll('button')].find(b => text(b) === 'Save word').click();
    assert.equal(app.S.vocab.map(x => x.w).join(','), 'Orbit');
    assert.match(text(sh), /1 shabd/);
    word.value = 'orbit';
    [...sh.querySelectorAll('button')].find(b => text(b) === 'Save word').click();
    assert.equal(app.S.vocab.length, 1, 'no duplicates, case-insensitive');
    sh.querySelector('.lvocab button[aria-label="Delete Orbit"]').click();
    assert.equal(app.S.vocab.length, 0);
  } finally { app.close(); }
});

test('backup import keeps learned words typed and capped', () => {
  const app = mount();
  try {
    const out = app.Learn.cleanImport({ vocab: [{ w: 'Force', m: 'push' }, { w: 'force', m: 'dup' }, { w: '', m: 'x' }, 'bad', { w: 'x'.repeat(90), m: 7 }], learnLog: [{ ts: 1, ok: 'yes', q: 'q' }] });
    assert.equal(out.vocab.map(x => x.w.length).join(','), '5,40');
    assert.equal(out.learnLog[0].ok, false);
  } finally { app.close(); }
});
