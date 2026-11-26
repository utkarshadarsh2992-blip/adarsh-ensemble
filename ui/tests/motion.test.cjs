'use strict';
/* Motion: the answer is typed out word by word at speaking pace, and the chat glides instead of jumping. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const UI = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(UI, 'src/index.html'), 'utf8');
const APP_CSS = fs.readFileSync(path.join(UI, 'src/css/app.css'), 'utf8');
const ORDER = [...INDEX.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)].map(m => m[1]);
const settle = (ms = 0) => new Promise(r => setTimeout(r, ms));

function mount() {
  const dom = new JSDOM(INDEX, { url: 'https://appassets.androidplatform.net/assets/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {};
  w.requestAnimationFrame = cb => { cb(Date.now()); return 1; };
  if (!w.crypto?.subtle) Object.defineProperty(w, 'crypto', { configurable: true, value: webcrypto });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.navigator.vibrate = () => true;
  w.fetch = async () => { throw new Error('network disabled in test'); };
  w.console = console;
  w.ADARSH_BACKEND = { async send() { return { type: 'text', text: 'ok' }; }, async ping() { return { ok: true }; } };
  const ctx = dom.getInternalVMContext();
  for (const f of ORDER) new vm.Script(fs.readFileSync(path.join(UI, 'src', f), 'utf8'), { filename: f }).runInContext(ctx);
  new vm.Script('globalThis.TEST = { Motion, Chat, App, S };').runInContext(ctx);
  return { window: w, document: w.document, ...w.TEST, close: () => dom.window.close() };
}

test('an answer is typed out word by word, never in one block', async (t) => {
  const app = mount();
  t.after(() => app.close());
  const host = app.document.createElement('div');
  app.document.body.append(host);
  const rev = app.Motion.reveal(host, { pace: 60, quick: 60, fast: 10 });
  const full = 'Sir, kal Delhi mein dhoop rahegi aur hawa saaf rahegi.';
  rev.set(full);
  await settle(30);
  const early = host.textContent;
  assert.ok(early.length > 0, 'the first words are already there');
  assert.ok(early.length < full.length, 'the whole answer is not printed at once');
  assert.ok(full.startsWith(early), 'what is shown is a prefix of the answer');
  rev.finish();
  assert.equal(host.textContent, full, 'finish shows the rest');
  rev.stop();
});

test('a growing transcript only ever moves forward and a new turn resets it', async (t) => {
  const app = mount();
  t.after(() => app.close());
  const host = app.document.createElement('div');
  app.document.body.append(host);
  const rev = app.Motion.reveal(host, { pace: 40, quick: 40, fast: 10 });
  rev.set('Sir, ek');
  rev.finish();
  rev.set('Sir, ek baat');            // the model streamed more of the same answer
  rev.finish();
  assert.equal(host.textContent, 'Sir, ek baat');
  rev.set('Naya jawab.');             // a different answer must not append to the old one
  assert.ok(!host.textContent.startsWith('Sir'), 'the old text is cleared');
  rev.finish();
  assert.equal(host.textContent, 'Naya jawab.');
  rev.stop();
});

test('the voice screen types the caption instead of dropping it in whole', () => {
  const src = fs.readFileSync(path.join(UI, 'src/js/05-voice.js'), 'utf8');
  assert.match(src, /Motion\.reveal\(capA/, 'the caption answer uses the revealer');
  assert.match(src, /capPace\(\)/, 'speaking switches to speaking pace');
  assert.match(src, /capFlush\(\)/, 'when the voice stops the rest follows quickly');
});

test('the chat thread glides to the newest line instead of jumping', () => {
  const chat = fs.readFileSync(path.join(UI, 'src/js/03-chat.js'), 'utf8');
  assert.match(chat, /const scroll = \(\) => Motion\.glide\(thread\)/, 'scroll uses the eased chase');
  assert.ok(!/thread\.scrollTop = thread\.scrollHeight/.test(chat), 'no instant jump left');
  assert.ok(!/\.thread\{scroll-behavior:smooth/.test(APP_CSS), 'native smooth scrolling would fight the chase');
  assert.match(APP_CSS, /\.v-cap \.a\{[^}]*line-height/);
});

test('glide eases towards the end and stops when it arrives', async (t) => {
  const app = mount();
  t.after(() => app.close());
  const box = app.document.createElement('div');
  box.style.overflowY = 'auto';
  app.document.body.append(box);
  Object.defineProperty(box, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(box, 'clientHeight', { value: 200, configurable: true });
  box.scrollTop = 0;
  app.Motion.glide(box);
  await settle(60);
  const mid = box.scrollTop;
  assert.ok(mid > 0 && mid < 800, 'it moves in steps, not straight to the bottom: ' + mid);
  await settle(900);
  assert.ok(box.scrollTop > mid, 'it keeps going');
});

test('a held speech caption waits for audio onset, then reveals only a word at a time', async (t) => {
  const app = mount();
  t.after(() => app.close());
  const host = app.document.createElement('div'); app.document.body.append(host);
  const rev = app.Motion.reveal(host, { mode: 'hold', pace: 100, quick: 40, fast: 10 });
  rev.set('Sir, audio ke saath shabd aayenge.');
  await settle(35);
  assert.equal(host.textContent, '', 'model transcript stays hidden before speech starts');
  rev.pace();
  assert.match(host.textContent, /^Sir,/);
  assert.ok(host.textContent.length < rev.full.length, 'the caption does not arrive as a whole block');
  rev.stop();
});

test('new ordinary chat answers reveal gradually without changing the full stored answer', async (t) => {
  const app = mount();
  t.after(() => app.close());
  const full = 'Sir, this answer should appear gradually one word at a time.';
  app.Chat.push({ type: 'text', text: full });
  const stored = app.S.chats.find(c => c.id === app.S.cur).msgs.at(-1).reply.text;
  const body = app.document.querySelector('#v-chat .msg[data-id] .prose');
  const shown = body.textContent;
  assert.equal(stored, full, 'the saved answer is not replaced by its visible prefix');
  assert.ok(shown.length > 0 && shown.length < full.length, 'only an initial prefix is visible');
  app.Chat.renderThread();
  assert.equal(app.document.querySelector('#v-chat .msg[data-id] .prose').textContent, shown, 'a rerender keeps typing progress');
});

test('a new reply preserves the reader position when the thread was scrolled up', (t) => {
  const app = mount();
  t.after(() => app.close());
  app.Chat.push({ type: 'text', text: 'Initial answer.' });
  const thread = app.document.querySelector('#v-chat .thread');
  app.Motion.release(thread);
  Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 1200 });
  Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 200 });
  thread.scrollTop = 450;
  app.Chat.push({ type: 'text', text: 'A second answer should not pull the reader away.' });
  assert.equal(thread.scrollTop, 450, 'DOM rebuilding does not reset or jump the reading position');
});
