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
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();

function mount({ route } = {}) {
  const dom = new JSDOM(INDEX, { url: 'https://appassets.androidplatform.net/assets/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.requestAnimationFrame = cb => { cb(Date.now()); return 1; };
  w.cancelAnimationFrame = () => {};
  w.URL.createObjectURL = () => 'blob:https://appassets.androidplatform.net/test';
  if (!w.crypto?.subtle) Object.defineProperty(w, 'crypto', { configurable: true, value: webcrypto });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.navigator.vibrate = () => true;
  w.open = () => null;
  w.fetch = async () => { throw new Error('network disabled in test'); };
  w.Notification = undefined;
  w.console = console;
  w.ADARSH_BACKEND = { async send(req, o = {}) { return route ? route(req, o) : { type: 'text', text: 'ok' }; }, async ping() { return { ok: true }; } };
  const ctx = dom.getInternalVMContext();
  for (const file of ORDER) new vm.Script(fs.readFileSync(path.join(UI, 'src', file), 'utf8'), { filename: path.join(UI, 'src', file) }).runInContext(ctx);
  new vm.Script('globalThis.TEST = { S, Chat, Council, Productivity, Backend, md, safeExternalUrl, load, saveNow };').runInContext(ctx);
  return { dom, window: w, document: w.document, ...w.TEST, close: () => dom.window.close() };
}

test('backend/model URLs never become unsafe anchors, while absolute HTTPS links remain usable', t => {
  const app = mount(); t.after(() => app.close());
  for (const bad of ['javascript:alert(1)', 'data:text/html,<svg>', 'vbscript:msgbox(1)', 'blob:https://evil.test/x', 'file:///etc/passwd', '//evil.test/x', 'not a URL']) assert.equal(app.safeExternalUrl(bad), null, bad);
  assert.equal(app.safeExternalUrl('https://example.com/a'), 'https://example.com/a');
  const root = app.md('[bad](javascript:alert(1)) [data](data:text/html,x) [good](https://example.com/a)');
  assert.equal(root.querySelectorAll('a').length, 1);
  assert.equal(root.querySelector('a').getAttribute('href'), 'https://example.com/a');
  assert.match(text(root), /javascript:alert\(1\)/);
});

test('research and council source URLs render unsafe values as text, not links', t => {
  const app = mount({ route: async () => ({ type: 'research', question: 'q', summary: 's', sources: [
    { n: 1, title: 'Bad source', url: 'javascript:alert(1)' },
    { n: 2, title: 'Good source', url: 'https://example.com/good' }
  ] }) });
  t.after(() => app.close());
  return app.Chat.submit('research this').then(async () => {
    await settle();
    const sourceLinks = [...app.document.querySelectorAll('.src a')];
    assert.equal(sourceLinks.length, 1);
    assert.equal(sourceLinks[0].getAttribute('href'), 'https://example.com/good');
    assert.match(text(app.document.querySelector('.src')), /javascript:alert/);

    app.Council.put('security-council', { question: 'q', roles: { sources: [
      { n: 1, title: 'Bad council source', url: 'javascript:alert(2)' },
      { n: 2, title: 'Good council source', url: 'https://example.com/council' }
    ] }, setup: {}, calls: [], drafts: [] });
    app.Council.open(app.Council.get('security-council'), [], true);
    assert.equal(app.document.querySelectorAll('.council a[href^="javascript:"]').length, 0);
    assert.equal(app.document.querySelectorAll('.council a[href="https://example.com/council"]').length, 1);
    assert.match(text(app.document.querySelector('.council')), /javascript:alert\(2\)/);
  });
});

test('oversized backend replies are bounded and visibly marked as omitted', t => {
  const app = mount({ route: async () => ({ type: 'text', text: 'x'.repeat(300000) }) });
  t.after(() => app.close());
  return app.Chat.submit('large reply').then(async () => {
    await settle();
    const reply = app.S.chats[0].msgs.at(-1).reply;
    assert.equal(reply._detailsOmitted, true);
    assert.ok(new TextEncoder().encode(JSON.stringify(reply)).length <= 256 * 1024);
    assert.match(app.document.body.textContent, /details omitted/i);
  });
});

test('backup import rejects oversized and wrong-type records before replacement', t => {
  const app = mount(); t.after(() => app.close());
  assert.equal(app.Productivity.importRecords([{ kind: 'note', text: 'x'.repeat(33000) }]).ok, false);
  assert.equal(app.Productivity.importRecords([{ kind: 'note', text: 42 }]).ok, false);
  assert.equal(app.Productivity.importRecords([{ kind: 'unknown', text: 'x' }]).ok, false);
});

test('browser backend rejects non-local HTTP and never sends bearer tokens over localhost HTTP', async t => {
  const app = mount(); t.after(() => app.close());
  const calls = [];
  app.window.ADARSH_BACKEND = undefined;
  app.window.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) }; };
  app.S.conn = { url: 'http://127.0.0.1:8000/api/chat', token: 'secret-token' };
  assert.equal((await app.Backend.ping()).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  app.S.conn.url = 'http://backend.example/api/chat';
  assert.equal((await app.Backend.ping()).ok, false);
  assert.equal(calls.length, 1);
});

test('CSP and native token migration keep secrets out of WebView storage', () => {
  const csp = (INDEX.match(/Content-Security-Policy" content="([^"]+)/) || [])[1] || '';
  for (const directive of ["default-src 'none'", "script-src 'self'", 'style-src', 'img-src', 'media-src', 'connect-src', 'font-src', "base-uri 'none'", "form-action 'none'", "frame-src 'none'"]) assert.ok(csp.includes(directive), directive);
  const bridge = fs.readFileSync(path.join(UI, 'src/js/00-android-bridge.js'), 'utf8');
  const core = fs.readFileSync(path.join(UI, 'src/js/01-core.js'), 'utf8');
  assert.match(bridge, /saveBackendToken/);
  assert.match(core, /legacyToken/);
  assert.match(core, /AdarshConnection\.saveToken/);
  assert.match(core, /k === 'token' && window\.AdarshConnection/);
});
