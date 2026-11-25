'use strict';
/* Adarsh Live (Step 5): Gemini Live over one WebSocket, driven from the voice screen.
   Checks: off by default, the socket carries model + philosophy, captions show both transcripts, a failure falls
   back to the old listen/answer/speak loop, and closing the screen ends the session (no background listening). */
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
const settle = (ms = 0) => new Promise(r => setTimeout(r, ms));
const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();

function mount({ settings = {}, native = {} } = {}) {
  const dom = new JSDOM(INDEX, { url: 'https://appassets.androidplatform.net/assets/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {};
  w.requestAnimationFrame = cb => { cb(Date.now()); return 1; };
  if (!w.crypto?.subtle) Object.defineProperty(w, 'crypto', { configurable: true, value: webcrypto });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.navigator.vibrate = () => true;
  w.fetch = async () => { throw new Error('network disabled in test'); };
  w.Notification = undefined; w.console = console;
  w.localStorage.setItem('adarsh.ui.v3', JSON.stringify({ settings: { ui4: 1, ...settings } }));
  w.AdarshNative = native;
  w.ADARSH_BACKEND = { async send() { return { type: 'text', text: 'ok' }; }, async ping() { return { ok: true }; } };
  const ctx = dom.getInternalVMContext();
  for (const f of ORDER) new vm.Script(fs.readFileSync(path.join(UI, 'src', f), 'utf8'), { filename: f }).runInContext(ctx);
  new vm.Script('globalThis.TEST = { S, Voice, Live, Chat };').runInContext(ctx);
  return { dom, window: w, document: w.document, ...w.TEST, close: () => dom.window.close() };
}

function bridge(calls) {
  return {
    liveStart: (json) => { calls.push(JSON.parse(json)); return JSON.stringify({ ok: true, state: 'connecting', model: JSON.parse(json).model }); },
    liveStop: () => { calls.push({ stop: true }); return JSON.stringify({ ok: true }); },
    liveSendText: (t) => { calls.push({ text: t }); return JSON.stringify({ ok: true }); },
    liveSwitch: (r) => { calls.push({ switch: r }); return JSON.stringify({ ok: true, model: r }); },
    speechStart: () => true
  };
}

test('Adarsh Live is off by default and the model list is the verified one', () => {
  const app = mount();
  try {
    assert.equal(app.S.settings.adarshLive, false, 'never on without the user');
    assert.equal(app.S.settings.liveModel, 'auto', 'auto routing is the default');
    assert.equal(app.Live.available(), false, 'no native bridge in a browser');
  } finally { app.close(); }
});

test('a live session sends the model, the chosen voice and the saved philosophy', async (t) => {
  const calls = [];
  const app = mount({ settings: { adarshLive: true, voiceName: 'Charon', lang: 'hi-IN' }, native: bridge(calls) });
  t.after(() => app.close());
  app.S.philosophy = 'Sach pehle, phir aaram.';
  assert.equal(app.Live.available(), true);
  app.Voice.open();
  await settle(20);
  const first = calls[0];
  assert.ok(first, 'liveStart called');
  assert.equal(first.model, 'auto', 'Kotlin resolves auto -> main voice');
  assert.equal(first.voice, 'Charon');
  assert.match(first.prompt, /Sach pehle, phir aaram\./);
  assert.match(first.prompt, /"Sir"/);
  assert.equal(first.key, undefined, 'the key never leaves Kotlin');
  // the socket pushes transcripts back into the captions
  app.window.__adarshLive({ type: 'user', text: 'kal ka mausam' });
  app.window.__adarshLive({ type: 'model', text: 'Sir, kal dhoop rahegi.' });
  await settle(400);   // the caption is typed out word by word, so give the reveal a moment
  const cap = text(app.document.querySelector('#voice .v-cap'));
  assert.match(cap, /kal ka mausam/);
  assert.match(cap, /dhoop rahegi/);
  app.Voice.close();
  assert.ok(calls.some(c => c.stop), 'closing the screen ends the session (no background listening)');
});

test('a failed live start falls back to the old voice loop instead of breaking the screen', async (t) => {
  const app = mount({ settings: { adarshLive: true }, native: {
    liveStart: () => JSON.stringify({ ok: false, message: 'Gemini API key nahi mili.' }),
    liveStop: () => JSON.stringify({ ok: true }), liveSendText: () => JSON.stringify({ ok: false })
  } });
  t.after(() => app.close());
  app.Voice.open();
  await settle(20);
  const cap = text(app.document.querySelector('#voice .v-cap'));
  assert.match(cap, /normal voice|Gemini API key/i);
  assert.equal(app.document.querySelector('#voice').hidden, false, 'screen still usable');
});

test('the sentence decides which Live model answers it', async (t) => {
  const app = mount();
  t.after(() => app.close());
  const { roleFor } = app.Live;
  // everyday talk stays on the main voice
  assert.equal(roleFor('kal ka mausam kaisa hai', 'main'), '');
  // deep reasoning upgrades to 3.8 extended thinking, instantly
  assert.equal(roleFor('samjhao ki entropy kyun badhti hai', 'main'), 'think');
  assert.equal(roleFor('why does this fail', 'main'), 'think');
  assert.equal(roleFor('x'.repeat(160), 'main'), 'think');
  // language asks use the translate model, dictation uses transcribe
  assert.equal(roleFor('isko hindi me karo', 'main'), 'translate');
  assert.equal(roleFor('translate this to english', 'main'), 'translate');
  assert.equal(roleFor('iski transcript likh ke do', 'main'), 'transcribe');
  // and a normal sentence afterwards brings the conversation back to the main voice
  assert.equal(roleFor('theek hai shukriya', 'think'), 'main');
  assert.equal(roleFor('', 'think'), '');
});

test('a live turn switches the model through the bridge', async (t) => {
  const calls = [];
  const app = mount({ settings: { adarshLive: true }, native: bridge(calls) });
  t.after(() => app.close());
  app.Voice.open();
  await settle(20);
  assert.equal(calls[0].model, 'auto');
  app.window.__adarshLive({ type: 'role', role: 'main', label: 'Main voice', model: 'gemini-3.8-live' });
  app.window.__adarshLive({ type: 'user', text: 'ye code debug kyun ho raha hai' });
  await settle(10);
  assert.ok(calls.some(c => c.switch === 'think'), 'deep question moves to extended thinking');
  assert.equal(app.Live.role, 'think');
  app.window.__adarshLive({ type: 'user', text: 'theek hai' });
  await settle(10);
  assert.ok(calls.some(c => c.switch === 'main'), 'plain talk returns to the main voice');
});
