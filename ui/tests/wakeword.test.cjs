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
const ORDER = [...INDEX.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)].map(m => m[1]);
const settle = ms => new Promise(r => setTimeout(r, ms));

function mount({ settings = {}, native = {} } = {}) {
  const dom = new JSDOM(INDEX, { url: 'https://appassets.androidplatform.net/assets/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {};
  w.requestAnimationFrame = cb => { cb(Date.now()); return 1; };
  if (!w.crypto?.subtle) Object.defineProperty(w, 'crypto', { configurable: true, value: webcrypto });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.navigator.vibrate = () => true;
  w.fetch = async () => { throw new Error('network disabled in test'); };
  w.Notification = undefined; w.console = console;
  w.localStorage.setItem('adarsh.ui.v3', JSON.stringify({ settings: { ui4: 1, ...settings } }));
  w.AdarshNative = native;
  w.ADARSH_BACKEND = { async send() { return { type: 'text', text: 'ok' }; }, async ping() { return { ok: true }; } };
  const ctx = dom.getInternalVMContext();
  for (const f of ORDER) new vm.Script(fs.readFileSync(path.join(UI, 'src', f), 'utf8'), { filename: path.join(UI, 'src', f) }).runInContext(ctx);
  new vm.Script('globalThis.TEST = { S, App, Voice, Live, WakeWord, LIVE_MODELS };').runInContext(ctx);
  return { dom, window: w, document: w.document, ...w.TEST, close: () => dom.window.close() };
}

function nativeWake(calls) {
  let state = { ok: true, enabled: false, active: false, supported: true, onDevice: true, phrase: 'Hey Adarsh', state: 'off', message: 'Wake word is off' };
  return {
    liveStart: json => { calls.push({ liveStart: JSON.parse(json) }); return JSON.stringify({ ok: true, state: 'connecting', model: 'gemini-3.8-live' }); },
    liveSwitch: asked => { calls.push({ liveSwitch: asked }); return JSON.stringify({ ok: true, model: asked }); },
    liveStop: () => { calls.push({ liveStop: true }); return JSON.stringify({ ok: true }); },
    liveSendText: text => { calls.push({ liveSendText: text }); return JSON.stringify({ ok: true }); },
    wakeWordStatus: () => JSON.stringify(state),
    wakeWordSet: enabled => {
      calls.push({ wakeWordSet: enabled });
      state = { ...state, enabled, active: enabled, state: enabled ? 'listening' : 'off', message: enabled ? 'On-device listening' : 'Wake word is off' };
      return JSON.stringify(state);
    },
    wakeWordPause: reason => { calls.push({ wakeWordPause: reason }); return JSON.stringify({ ...state, state: 'paused' }); },
    wakeWordResume: reason => { calls.push({ wakeWordResume: reason }); return JSON.stringify(state); },
    backgroundVoiceStatus: () => JSON.stringify({ ok: true, active: false, state: 'inactive' }),
    backgroundVoiceArm: () => JSON.stringify({ ok: true, armed: false }),
    backgroundVoiceStop: () => JSON.stringify({ ok: true }),
    speechStart: () => true
  };
}

test('wake word is default-off and never auto-enables from page load', () => {
  const calls = [];
  const app = mount({ native: nativeWake(calls) });
  try {
    assert.equal(app.S.settings.wakeWordEnabled, false);
    assert.equal(calls.some(c => Object.hasOwn(c, 'wakeWordSet')), false);
    assert.equal(app.WakeWord.status().enabled, false);
    assert.equal(app.WakeWord.status().onDevice, true);
  } finally { app.close(); }
});

test('WakeWord set/status use the native switch contract and record no transcript data', () => {
  const calls = [];
  const app = mount({ native: nativeWake(calls) });
  try {
    const enabled = app.WakeWord.setEnabled(true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.state, 'listening');
    assert.equal(app.S.settings.wakeWordEnabled, true);
    assert.equal(app.WakeWord.status().enabled, true);
    app.WakeWord.setEnabled(false);
    assert.equal(app.S.settings.wakeWordEnabled, false);
    assert.deepEqual(calls.filter(c => Object.hasOwn(c, 'wakeWordSet')).map(c => c.wakeWordSet), [true, false]);
    assert.equal(JSON.stringify(calls).includes('transcript'), false);
  } finally { app.close(); }
});

test('wake event starts Google Live without turning on the saved Google Live switch or forwarding wake transcript', async t => {
  const calls = [];
  const app = mount({ settings: { adarshLive: false }, native: nativeWake(calls) });
  t.after(() => app.close());
  app.window.__adarshWakeWord({ type: 'wake', transcript: 'Hey Adarsh please upload this ambient speech' });
  await settle(20);
  assert.equal(app.S.settings.adarshLive, false);
  assert.ok(calls.some(c => c.liveStart), 'wake event opens a Google Live session');
  assert.equal(app.document.querySelector('#voice').classList.contains('wake-mini'), true, 'wake voice opens as the compact in-app panel');
  assert.ok(calls.some(c => c.wakeWordPause === 'voice'));
  assert.ok(calls.some(c => c.wakeWordResume === 'wake'));
  assert.equal(calls.some(c => c.liveSendText), false, 'detector transcript is not forwarded to Live');
  app.Voice.close();
  assert.equal(app.document.querySelector('#voice').classList.contains('wake-mini'), false, 'closing the panel restores normal voice mode');
  assert.ok(calls.some(c => c.wakeWordResume === 'voice'));
});


test('failed wake-triggered Google Live falls back to the normal listening voice loop', async t => {
  const calls = [];
  const native = nativeWake(calls);
  native.liveStart = json => { calls.push({ liveStartAttempt: JSON.parse(json).model }); return JSON.stringify({ ok: false, message: 'Gemini API key nahi mili.' }); };
  native.speechStart = () => { calls.push({ speechStart: true }); return true; };
  const app = mount({ native });
  t.after(() => app.close());
  app.window.__adarshWakeWord({ type: 'wake' });
  await settle(1_050);
  assert.ok(calls.some(c => c.liveStartAttempt), 'the wake route attempts Google Live first');
  assert.ok(calls.some(c => c.speechStart), 'Hey Adarsh still ends in a listening voice screen');
  assert.equal(app.Voice.isOpen, true);
});

test('Live picker shows only the chat model while specialist models auto-route in the background', t => {
  const calls = [];
  const app = mount({ settings: { adarshLive: false, liveModel: 'gemini-3.8-live' }, native: nativeWake(calls) });
  t.after(() => app.close());
  app.App.show('settings');
  app.document.querySelector('#v-settings [aria-label="Voice & language"]').click();
  const picker = app.document.querySelector('[aria-label="Adarsh Live model"]');
  assert.ok(picker, 'model picker is visible even before Live is switched on in Settings');
  assert.equal(picker.options.length, 2, 'only Auto and the everyday Live chat model are user-selectable');
  assert.equal(JSON.stringify(app.LIVE_MODELS.map(([id]) => id)), JSON.stringify(['auto', 'gemini-3.8-live']));
  picker.value = 'gemini-3.8-live';
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(app.S.settings.liveModel, 'gemini-3.8-live', 'the chosen model is saved to app settings');
  app.S.settings.adarshLive = true;
  app.Voice.open();
  assert.equal(calls.find(c => c.liveStart).liveStart.model, 'gemini-3.8-live');
  app.window.__adarshLive({ type: 'user', text: 'Translate this to Hindi please.' });
  assert.ok(calls.some(c => c.liveSwitch === 'translate:hi'), 'the translation model is selected automatically and stays out of the picker');
  app.window.__adarshLive({ type: 'user', text: 'Ruko, normal chat.' });
  assert.ok(calls.some(c => c.liveSwitch === 'main'), 'normal conversation returns to the Live chat model');
  app.window.__adarshLive({ type: 'user', text: 'Why does this work? Please explain.' });
  assert.ok(calls.some(c => c.liveSwitch === 'think'), 'reasoning specialist is automatically selected when useful');
});

test('Settings Hey Adarsh summary shows the exact native reason and live updates', () => {
  const calls = [];
  const native = nativeWake(calls);
  native.wakeWordStatus = () => JSON.stringify({ ok: false, enabled: false, active: false, supported: false, state: 'unsupported', message: 'Is phone par koi speech recognizer nahi mila.' });
  const app = mount({ native });
  try {
    app.App.show('settings');
    const toggle = [...app.document.querySelectorAll('#v-settings [role=switch]')].find(node => /Hey Adarsh/.test(node.textContent));
    assert.match(toggle.textContent, /speech recognizer nahi mila/);
    app.window.__adarshWakeWord({ type: 'status', ok: true, enabled: true, active: true, supported: true, engine: 'system', state: 'listening', message: 'Listening' });
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.match(toggle.textContent, /phone speech service/);
  } finally { app.close(); }
});
test('Settings exposes an off-by-default Hey Adarsh toggle wired to native on/off', () => {
  const calls = [];
  const app = mount({ native: nativeWake(calls) });
  try {
    app.App.show('settings');
    const toggle = [...app.document.querySelectorAll('#v-settings [role=switch]')].find(node => /Hey Adarsh/.test(node.textContent));
    assert.ok(toggle, 'Hey Adarsh appears as a Settings switch');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    toggle.click();
    assert.ok(calls.some(call => call.wakeWordSet === true));
    assert.equal(app.S.settings.wakeWordEnabled, true);
    app.App.show('settings');
    const onToggle = [...app.document.querySelectorAll('#v-settings [role=switch]')].find(node => /Hey Adarsh/.test(node.textContent));
    assert.equal(onToggle.getAttribute('aria-checked'), 'true');
    onToggle.click();
    assert.ok(calls.some(call => call.wakeWordSet === false));
    assert.equal(app.S.settings.wakeWordEnabled, false);
  } finally { app.close(); }
});
