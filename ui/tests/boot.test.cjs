'use strict';
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
  new vm.Script('globalThis.TEST = { S, App, Splash };').runInContext(ctx);
  return { dom, window: w, document: w.document, buzz, ...w.TEST, close: () => dom.window.close() };
}

test('index.html paints the boot layer first, before the app shell', () => {
  const dom = new JSDOM(INDEX);
  const first = dom.window.document.body.firstElementChild;
  assert.equal(first.id, 'boot');
  assert.equal(first.getAttribute('aria-hidden'), 'true');
  assert.ok(first.querySelector('.boot-logo path.fill') && first.querySelector('.boot-hud'));
  assert.match(INDEX, /href="css\/boot\.css"/);
  assert.ok(ORDER.indexOf('js/07-splash.js') >= 0 && ORDER.indexOf('js/07-splash.js') < ORDER.indexOf('js/08-boot.js'));
  dom.window.close();
});

test('the animation plays the full timeline and then removes itself', async (t) => {
  const app = mount();
  t.after(() => app.close());
  assert.equal(app.S.settings.bootAnim, true, 'on by default');
  const boot = app.document.getElementById('boot');
  assert.ok(boot && app.Splash.active());
  await settle(120);
  assert.ok(boot.classList.contains('go'), 'HUD started');
  await settle(1900);   // ready at 1.7 s
  assert.ok(boot.classList.contains('ready'));
  assert.equal(text(app.document.getElementById('boot-name')), 'ADARSH');
  assert.equal(text(app.document.getElementById('boot-state')), 'SYSTEM READY');
  assert.equal(text(app.document.getElementById('boot-pct')), '100%');
  const log = [...app.document.querySelectorAll('#boot-log .boot-ln')].map(text);
  assert.equal(log.length, 5);
  assert.match(log[0], /^INIT\s*adarsh core\s*OK$/);
  assert.match(log[2], /STANDARD/);
  assert.match(log[3], /wikipedia \+ web search/);
  assert.deepEqual(app.buzz, [14], 'one short buzz at ready (Haptics on)');
  await settle(800);    // out at 2.0 s, fade 0.46 s
  assert.equal(app.document.getElementById('boot'), null, 'layer removed');
  assert.equal(app.Splash.active(), false);
  assert.ok(app.document.getElementById('phone'), 'app shell untouched');
});

test('the boot log follows the settings (web search off, haptics off)', async (t) => {
  const app = mount({ settings: { webSearch: false, haptics: false } });
  t.after(() => app.close());
  await settle(2000);
  const log = [...app.document.querySelectorAll('#boot-log .boot-ln')].map(text);
  assert.match(log[3], /wikipedia research/);
  assert.doesNotMatch(log[3], /web search/);
  assert.deepEqual(app.buzz, []);
});

test('Settings off: the layer is removed before it is ever seen', (t) => {
  const app = mount({ settings: { bootAnim: false } });
  t.after(() => app.close());
  assert.equal(app.document.getElementById('boot'), null);
  assert.equal(app.Splash.active(), false);
});

test('a hidden start (app restored in the background) does not play it', (t) => {
  const app = mount({ hidden: true });
  t.after(() => app.close());
  assert.equal(app.document.getElementById('boot'), null);
});

test('a tap skips it at once', async (t) => {
  const app = mount();
  t.after(() => app.close());
  await settle(150);
  const boot = app.document.getElementById('boot');
  boot.dispatchEvent(new app.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.ok(boot.classList.contains('out') && boot.classList.contains('skip'));
  assert.equal(app.Splash.active(), false);
  await settle(320);
  assert.equal(app.document.getElementById('boot'), null);
});

test('reduced motion gets a short fade only', async (t) => {
  const app = mount({ reducedMotion: true });
  t.after(() => app.close());
  const boot = app.document.getElementById('boot');
  assert.ok(boot.classList.contains('calm'));
  await settle(1000);
  assert.equal(app.document.getElementById('boot'), null);
});

test('Settings: no startup-animation rows; Splash.replay still plays even with bootAnim off', async (t) => {
  const app = mount();
  t.after(() => app.close());
  app.Splash.skip();
  await settle(320);
  assert.equal(app.document.getElementById('boot'), null);
  app.App.show('settings');
  await settle(0);
  const labels = [...app.document.querySelectorAll('button')].map(text).join(' | ');
  for (const gone of ['Startup animation', 'Animation preview', 'Adarsh (Standard mode)', 'Tasks and Work', 'Architecture (read-only)', 'Notification permissions', 'Update notification'])
    assert.ok(!labels.includes(gone), gone + ' row removed');
  app.S.settings.bootAnim = false;
  app.Splash.replay();
  const again = app.document.getElementById('boot');
  assert.ok(again && app.Splash.active(), 'preview plays even while the switch is off');
  assert.equal(app.Splash.replay(), false, 'no second layer while one is playing');
  assert.equal(app.document.querySelectorAll('#boot').length, 1);
  await settle(120);
  assert.ok(again.classList.contains('go'));
  app.Splash.skip();
  await settle(320);
  assert.equal(app.document.getElementById('boot'), null);

});

test('Android: the system bars go dark with the layer and come back mid-fade', async (t) => {
  const calls = [];
  const app = mount({ native: { bootBars: dark => calls.push(dark) } });
  t.after(() => app.close());
  assert.deepEqual(calls, [true]);
  await until(() => calls.at(-1) === false);   // out at 2.0 s, bars back 0.18 s later
  assert.ok(app.Splash.active() === false);
  assert.ok(app.document.getElementById('boot'), 'layer still fading when the bars turn back');
  const log = [...app.document.querySelectorAll('#boot-log .boot-ln')].map(text);
  assert.match(log[4], /keystore/);
  await settle(500);
  assert.equal(app.document.getElementById('boot'), null);
  assert.equal(calls.filter(Boolean).length, 1);
});

test('Android with the animation off: the bars are turned back at once', (t) => {
  const calls = [];
  const app = mount({ settings: { bootAnim: false }, native: { bootBars: dark => calls.push(dark) } });
  t.after(() => app.close());
  assert.deepEqual(calls, [false]);
  assert.equal(app.document.getElementById('boot'), null);
});
