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
  for (const f of ORDER) new vm.Script(fs.readFileSync(path.join(UI, 'src', f), 'utf8'), { filename: path.join(UI, 'src', f) }).runInContext(ctx);
  new vm.Script('globalThis.TEST = { S, Voice, Live, Chat, TTS };').runInContext(ctx);
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

function cameraBridge(calls) {
  const native = bridge(calls);
  native.liveCameraStart = () => { calls.push({ cameraStart: true }); return JSON.stringify({ ok: true, state: 'starting' }); };
  native.liveCameraStop = () => { calls.push({ cameraStop: true }); return JSON.stringify({ ok: true, state: 'off' }); };
  return native;
}

async function connectedCamera(t) {
  const calls = [];
  const app = mount({ settings: { adarshLive: true }, native: cameraBridge(calls) });
  t.after(() => app.close());
  app.Voice.open();
  await settle(20);
  const button = app.document.querySelector('#voice .camera-toggle');
  assert.ok(button, 'explicit Camera button is present');
  assert.equal(button.disabled, true, 'camera waits for Live connection');
  button.click();
  assert.equal(calls.filter(c => c.cameraStart).length, 0, 'no camera start while Live is connecting');
  app.window.__adarshLive({ type: 'state', state: 'listening', model: 'gemini-3.8-live' });
  assert.equal(button.disabled, false, 'camera becomes available once Live is connected');
  button.click();
  assert.equal(calls.filter(c => c.cameraStart).length, 1, 'connected Android Live starts the native camera');
  app.window.__adarshLive({ type: 'camera', state: 'on' });
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(text(app.document.querySelector('#voice .camera-status')), /frames shared with Gemini Live/);
  return { app, calls, button };
}

test('Adarsh Live is off by default and the model list is the verified one', () => {
  const app = mount();
  try {
    assert.equal(app.S.settings.adarshLive, false, 'never on without the user');
    assert.equal(app.S.settings.liveModel, 'auto', 'auto routing is the default');
    assert.equal(app.Live.available(), false, 'no native bridge in a browser');
  } finally { app.close(); }
});

test('a live session sends model, voice, saved philosophy and web-search preference', async (t) => {
  const calls = [];
  const app = mount({ settings: { adarshLive: true, voiceName: 'Charon', lang: 'hi-IN', webSearch: true }, native: bridge(calls) });
  t.after(() => app.close());
  app.S.philosophy = 'Sach pehle, phir aaram.';
  assert.equal(app.Live.available(), true);
  app.Voice.open();
  await settle(20);
  const first = calls[0];
  assert.ok(first, 'liveStart called');
  assert.equal(first.model, 'auto', 'Kotlin resolves auto -> main voice');
  assert.equal(first.voice, 'Charon');
  assert.equal(first.webSearch, true, 'Google Search grounding is enabled when the app setting is on');
  assert.match(first.prompt, /Sach pehle, phir aaram\./);
  assert.match(first.prompt, /"Sir"/);
  assert.match(first.prompt, /requested depth and format/);
  assert.doesNotMatch(first.prompt, /about 2 years|little support at home|overthinking/i);
  assert.equal(first.key, undefined, 'the key never leaves Kotlin');
  // model text waits for the first received audio before revealing
  app.window.__adarshLive({ type: 'user', text: 'kal ka mausam' });
  app.window.__adarshLive({ type: 'model', text: 'Sir, kal dhoop rahegi.' });
  await settle(80);
  let cap = text(app.document.querySelector('#voice .v-cap'));
  assert.match(cap, /kal ka mausam/);
  assert.doesNotMatch(cap, /Sir, kal dhoop rahegi\./, 'model text stays hidden before audio starts');
  app.window.__adarshLive({ type: 'state', state: 'speaking', model: 'gemini-3.8-live' });
  await settle(380);
  cap = text(app.document.querySelector('#voice .v-cap'));
  assert.match(cap, /Sir,/);
  assert.doesNotMatch(cap, /Sir, kal dhoop rahegi\./, 'caption continues at a steady speaking cadence');
  app.Voice.close();
  assert.ok(calls.some(c => c.stop), 'closing the screen ends the session (no background listening)');
});

test('Live passes web-search-off to native setup and exposes safe grounding sources as links', async t => {
  const calls = [];
  let opened = '';
  const native = bridge(calls);
  native.openExternal = url => { opened = url; return true; };
  const app = mount({ settings: { adarshLive: true, webSearch: false }, native });
  t.after(() => app.close());
  app.Voice.open();
  await settle(15);
  assert.equal(calls[0].webSearch, false, 'the saved global search setting is passed to Kotlin');
  const box = app.document.querySelector('#voice .live-sources');
  const button = app.document.querySelector('#voice .live-source-toggle');
  assert.equal(box.hidden, true, 'no empty source panel is shown');
  app.window.__adarshLive({ type: 'sources', sources: [
    { title: 'Google result', url: 'https://example.com/source' },
    { title: 'Unsafe result', url: 'javascript:alert(1)' }
  ] });
  assert.equal(box.hidden, false, 'grounded source becomes available in Live');
  assert.equal(button.textContent, 'Sources (1)', 'unsafe URLs are excluded');
  button.click();
  const link = app.document.querySelector('#voice .live-source-list a');
  assert.equal(link.href, 'https://example.com/source');
  link.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(opened, 'https://example.com/source', 'Android external-link bridge receives the HTTPS URL');
  app.window.__adarshLive({ type: 'sources', sources: [] });
  assert.equal(box.hidden, true, 'source panel resets at the next empty result');
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


test('native TTS start and completion reach the UI as separate callbacks', async (t) => {
  const calls = [];
  const app = mount({ native: {
    ttsAvailable: () => true,
    ttsSpeak: (id) => { calls.push(id); },
    ttsStop: () => {}
  } });
  t.after(() => app.close());
  let started = 0, ended = 0;
  app.TTS.speak('Namaste Sir.', () => { ended++; }, () => { started++; });
  await settle(20);
  assert.equal(calls.length, 1, 'native speech has been requested');
  assert.equal(started, 0, 'caption start waits while the audio is only queued');
  app.window.__adarshTts('start', calls[0]);
  assert.equal(started, 1, 'the native playback-start callback releases the caption');
  app.window.__adarshTts('done', calls[0]);
  await settle(10);
  assert.equal(ended, 1, 'completion remains a separate event');
});

test('the voice screen has a Google Live toggle that switches live <-> normal voice without closing', async (t) => {
  const calls = [];
  const app = mount({ settings: { adarshLive: false }, native: bridge(calls) });
  t.after(() => app.close());
  app.Voice.open();
  await settle(20);
  const chip = [...app.document.querySelectorAll('#voice .chipbtn')].find(b => text(b) === 'Google Live');
  assert.ok(chip, 'chip is on the voice screen');
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  assert.equal(chip.getAttribute('aria-disabled'), 'false', 'native Android Live can be toggled');
  assert.equal(calls.length, 0, 'live never starts on its own');
  assert.match(text(app.document.querySelector('#voice .tag')), /^VOICE/);
  chip.click();
  await settle(20);
  assert.equal(app.S.settings.adarshLive, true, 'setting saved');
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.ok(calls.some(c => c.model), 'Google Live socket started');
  assert.match(text(app.document.querySelector('#voice .tag')), /^ADARSH LIVE/);
  chip.click();
  await settle(20);
  assert.equal(app.S.settings.adarshLive, false);
  assert.ok(calls.some(c => c.stop), 'live socket closed when switched off');
  assert.equal(app.document.querySelector('#voice').hidden, false, 'screen stays open in normal voice');
  assert.match(text(app.document.querySelector('#voice .v-cap')), /Normal voice/);
  assert.match(text(app.document.querySelector('#voice .tag')), /^VOICE/);
});

test('Google Live stays visible in browser preview and is clearly Android-only', async (t) => {
  const app = mount();
  t.after(() => app.close());
  app.Voice.open();
  await settle(20);
  const chip = [...app.document.querySelectorAll('#voice .chipbtn')].find(b => text(b) === 'Google Live');
  assert.ok(chip, 'toggle remains visible in preview');
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  assert.equal(chip.getAttribute('aria-disabled'), 'true', 'preview cannot run the native socket');
  assert.equal(chip.dataset.previewOnly, 'true', 'UI labels the preview limitation');
  chip.click();
  await settle(20);
  assert.equal(app.S.settings.adarshLive, false, 'preview click does not save an unavailable setting');
});

test('camera is off by default and disabled in browser preview', async t => {
  const app = mount();
  t.after(() => app.close());
  app.Voice.open();
  await settle(15);
  const button = app.document.querySelector('#voice .camera-toggle');
  assert.ok(button, 'Camera control is explicit and visible');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.disabled, true, 'browser preview cannot start a camera');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(text(app.document.querySelector('#voice .camera-status')), 'Android app only');
  button.click();
  assert.equal(app.Live.isOn, false, 'camera control does not start Live or camera in preview');
});

test('camera stays disabled in Android until Gemini Live is connected', async t => {
  const calls = [];
  const app = mount({ native: cameraBridge(calls) });
  t.after(() => app.close());
  app.Voice.open();
  await settle(15);
  const button = app.document.querySelector('#voice .camera-toggle');
  assert.equal(button.disabled, true, 'normal voice mode is not camera-ready');
  button.click();
  assert.equal(calls.filter(c => c.cameraStart).length, 0, 'no camera start in not-ready mode');
  const live = [...app.document.querySelectorAll('#voice .chipbtn')].find(b => text(b) === 'Google Live');
  live.click();
  await settle(15);
  assert.equal(button.disabled, true, 'connecting is not yet ready');
  button.click();
  assert.equal(calls.filter(c => c.cameraStart).length, 0, 'connecting Live cannot start camera');
  app.window.__adarshLive({ type: 'state', state: 'listening', model: 'gemini-3.8-live' });
  assert.equal(button.disabled, false, 'connected Live enables the Android camera control');
});

test('camera start and stop events update accessible state only while connected', async t => {
  const { app, calls, button } = await connectedCamera(t);
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'native on event presses the control');
  button.click();
  assert.equal(calls.filter(c => c.cameraStop).length, 1, 'turning camera off calls the native status method');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  app.window.__adarshLive({ type: 'camera', state: 'off' });
  assert.match(text(app.document.querySelector('#voice .camera-status')), /Camera off/);
});

test('camera stops when Google Live mode is switched off', async t => {
  const { app, calls } = await connectedCamera(t);
  const live = [...app.document.querySelectorAll('#voice .chipbtn')].find(b => text(b) === 'Google Live');
  live.click();
  assert.equal(calls.filter(c => c.cameraStop).length, 1);
  assert.equal(app.document.querySelector('#voice .camera-toggle').disabled, true);
  assert.equal(app.document.querySelector('#voice').hidden, false, 'normal voice remains usable');
});

test('camera stops when the Voice screen closes', async t => {
  const { app, calls } = await connectedCamera(t);
  app.Voice.close();
  assert.equal(calls.filter(c => c.cameraStop).length, 1);
  assert.equal(app.document.querySelector('#voice').hidden, true);
});

test('camera stops on Live error and socket close', async t => {
  await t.test('error', async st => {
    const { app, calls } = await connectedCamera(st);
    app.window.__adarshLive({ type: 'error', message: 'Live failed' });
    assert.equal(calls.filter(c => c.cameraStop).length, 1);
    assert.equal(app.Live.isOn, false);
  });
  await t.test('closed', async st => {
    const { app, calls } = await connectedCamera(st);
    app.window.__adarshLive({ type: 'closed' });
    assert.equal(calls.filter(c => c.cameraStop).length, 1);
    assert.equal(app.document.querySelector('#voice').hidden, false);
  });
});

test('camera stops when Live switches into an audio-only role', async t => {
  const { app, calls, button } = await connectedCamera(t);
  app.window.__adarshLive({ type: 'role', role: 'transcribe', label: 'Speech recognition' });
  assert.equal(calls.filter(c => c.cameraStop).length, 1);
  assert.equal(button.disabled, true, 'audio-only role cannot use camera');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
});

test('camera permission denial leaves the connected Live UI usable', async t => {
  const { app, button, calls } = await connectedCamera(t);
  app.window.__adarshLive({ type: 'camera', state: 'permission_required', message: 'Camera permission denied' });
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.disabled, false, 'permission denial can be retried while Live remains connected');
  assert.match(text(app.document.querySelector('#voice .camera-status')), /permission needed/i);
  assert.equal(app.Live.isOn, true, 'camera permission denial does not stop Gemini Live');
  assert.equal(app.document.querySelector('#voice').hidden, false, 'Voice screen remains open and usable');
  assert.equal(calls.filter(c => c.stop).length, 0, 'Live socket remains open');
});
