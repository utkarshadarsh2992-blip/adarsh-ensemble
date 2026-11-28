'use strict';
/* Android Back + voice End button + scroll stability. (mount copied from boot suite) */
/* Startup animation (css/boot.css + js/07-splash.js): it plays over the boot, removes itself, can be skipped,
   turned off in Settings and replayed from Settings. Uses the real timeline (about 2.5 s). */
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

function mount({ settings, reducedMotion = false, hidden = false, native } = {}) {
  const dom = new JSDOM(INDEX, { url: 'https://appassets.androidplatform.net/assets/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = q => ({ matches: reducedMotion && /reduce/.test(q), addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.requestAnimationFrame = cb => { cb(Date.now()); return 1; };   // synchronous, like the other suites
  if (!w.crypto?.subtle) Object.defineProperty(w, 'crypto', { configurable: true, value: webcrypto });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  const buzz = [];
  w.navigator.vibrate = ms => { buzz.push(ms); return true; };
  w.open = () => null;
  w.fetch = async () => { throw new Error('network disabled in test'); };
  w.Notification = undefined;
  w.console = console;
  if (hidden) Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => true });
  if (settings) w.localStorage.setItem('adarsh.ui.v3', JSON.stringify({ settings: { ui4: 1, ...settings } }));
  if (native) w.AdarshNative = native;
  w.ADARSH_BACKEND = { async send() { return { type: 'text', text: 'ok' }; }, async ping() { return { ok: true }; } };
  const ctx = dom.getInternalVMContext();
  for (const file of ORDER) new vm.Script(fs.readFileSync(path.join(UI, 'src', file), 'utf8'), { filename: path.join(UI, 'src', file) }).runInContext(ctx);
  new vm.Script('globalThis.TEST = { S, App, Splash, Voice, sheet, Bus };').runInContext(ctx);
  return { dom, window: w, document: w.document, buzz, ...w.TEST, close: () => dom.window.close() };
}


test('Android Back steps back inside the app before leaving it', async (t) => {
  const app = mount({ settings: { bootAnim: false } });
  t.after(() => app.close());
  const w = app.window, d = app.document;
  await settle(50);
  assert.equal(typeof w.__adarshBack, 'function');
  // a sheet closes first
  app.sheet({ title: 'Test sheet', build: () => w.document.createElement('div') });
  assert.ok(d.querySelector('#phone > .shade'));
  assert.equal(w.__adarshBack(), true);
  await settle(400);
  assert.equal(d.querySelectorAll('#phone > .shade').length, 0, 'sheet closed by Back');
  // another view returns to chat
  app.App.show('settings');
  assert.equal(app.App.view, 'settings');
  assert.equal(w.__adarshBack(), true);
  assert.equal(app.App.view, 'chat');
  // idle chat: native side may leave the app
  assert.equal(w.__adarshBack(), false);
  // locked app never navigates
  d.getElementById('lock').hidden = false;
  app.App.show('settings');
  assert.equal(w.__adarshBack(), false);
});

test('voice screen has an End call button that closes it', async (t) => {
  const app = mount({ settings: { bootAnim: false } });
  t.after(() => app.close());
  await settle(50);
  app.Voice.open();
  await settle(50);
  assert.equal(app.Voice.isOpen, true);
  const end = app.document.querySelector('#voice .v-end, .voice .v-end');
  assert.ok(end, 'End button rendered');
  assert.equal(end.getAttribute('aria-label'), 'End call');
  end.click();
  await settle(400);
  assert.equal(app.Voice.isOpen, false);
});

test('Back closes the voice screen before leaving the app', async (t) => {
  const app = mount({ settings: { bootAnim: false } });
  t.after(() => app.close());
  await settle(50);
  app.Voice.open();
  await settle(50);
  assert.equal(app.window.__adarshBack(), true);
  await settle(400);
  assert.equal(app.Voice.isOpen, false);
});

test('event-driven view rebuild keeps its scroll position', async (t) => {
  const app = mount({ settings: { bootAnim: false } });
  t.after(() => app.close());
  await settle(50);
  app.App.show('tasks');
  const before = app.document.querySelector('#view .scroll') || [...app.document.querySelectorAll('.scroll')].pop();
  before.scrollTop = 240;
  app.Bus.emit('records:changed');
  await settle(20);
  const after = app.document.querySelector('#view .scroll') || [...app.document.querySelectorAll('.scroll')].pop();
  assert.notEqual(after, before, 'view was rebuilt');
  assert.equal(after.scrollTop, 240);
});
