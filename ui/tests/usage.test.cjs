'use strict';
/* Change 1.4 (js/04-usage.js): API usage screen, hallucination controls and the FACT-CHECK card. */
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
  new vm.Script('globalThis.TEST = { S, Chat, App, Usage };').runInContext(ctx);
  return { dom, window: w, document: w.document, sent, ...w.TEST, close: () => dom.window.close() };
}
const later = (days, hh = 0, mm = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hh, mm, 0, 0); return d; };
const key = (slot, o = {}) => ({ slot, set: true, state: 'ok', cool_s: 0, req: 0, tok: 0, models: [], ...o });
const model = (o = {}) => ({ model: 'openai/gpt-oss-120b', label: 'gpt-oss-120b', req: 12, tok: 41000, req_limit: 1000, tok_limit: 200000, frac: 0.205, out_s: 0, cool_s: 0, rpm: 25, tpm: 7200, min_req: 2, min_tok: 1800, ...o });
const REPORT = {
  day_utc: '2026-11-25', reset_in_s: 7260, margin: 0.95, reserve: 0.8,
  totals: { req: 1530, tok: 2300000 },
  standard: { state: 'tight', left: 0.31 },
  providers: [
    { id: 'groq', name: 'Groq', set: 2, req: 1530, tok: 2300000, limits: 'Har key alag account hai, sabki apni limit.', keys: [
      key(1, { state: 'out', req: 1000, tok: 2000000, models: [model({ req: 1000, tok: 2000000, frac: 1, out_s: 5400 })] }),
      key(2, { state: 'cool', cool_s: 600, req: 530, tok: 300000, models: [model({ model: 'openai/gpt-oss-20b', req: 530, tok: 300000, frac: 0.5 })] }),
      key(3, { set: false, state: 'nokey' })] },
    { id: 'gemini', name: 'Gemini', set: 0, req: 0, tok: 0, limits: '', keys: [key(1, { set: false, state: 'nokey' })] }
  ],
  features: { standard: 900, council: 400, factcheck: 230 },
  days: [{ day: '2026-11-23', req: 300, tok: 1, by: {} }, { day: '2026-11-24', req: 800, tok: 1, by: {} }, { day: '2026-11-25', req: 1530, tok: 1, by: {} }],
  truth: { answers: 4, ok: 9, shak: 2, galat: 1 }
};
const TRUTH = { checked: 3, ok: 1, shak: 1, galat: 1, basis: 'sources', level: 'strict', claims: [
  { c: 'Landing 23 August 2023 ko hui', v: 'ok', why: 'E1 mein yahi date', fix: '' },
  { c: 'Budget 615 crore', v: 'shak', why: 'evidence mein budget nahi', fix: 'ISRO report dekho' },
  { c: 'Rover ka naam Vikram', v: 'galat', why: 'Vikram lander hai', fix: 'Rover Pragyan hai' }] };
const answer = (extra = {}) => (req) => (req.usage ? { type: 'usage', usage: REPORT } : { type: 'text', text: 'Chandrayaan-3 ne landing ki.', uiMode: 'standard', ...extra });
test('defaults and request body remain local fallbacks while duplicate editors are removed from Settings', async () => {
  const app = mount({ reply: answer() });
  try {
    const { Usage, S } = app;
    assert.equal(S.settings.truthLevel, 'balanced');
    assert.equal(S.settings.factCheck, 'auto');
    assert.deepEqual(JSON.parse(JSON.stringify(Usage.request())), { level: 'balanced', check: 'auto' });
    assert.equal(Usage.summary(), 'Balanced · fact-check auto');
    app.App.show('settings');
    const v = app.document.querySelector('#v-settings');
    assert.doesNotMatch(text(v), /Hallucination control|API usage/);
    assert.equal(S.settings.truthLevel, 'balanced');
    assert.equal(S.settings.factCheck, 'auto');
    await app.Chat.submit('Chandrayaan-3 kab land hua?');
    await until(() => app.sent.length === 1 && !app.Chat.isBusy());
    assert.deepEqual(app.sent[0].truth, { level: 'balanced', check: 'auto' });
    assert.deepEqual(JSON.parse(JSON.stringify(Usage.request())), { level: 'balanced', check: 'auto' }, 'stored values remain the offline fallback');
  } finally { app.close(); }
});
test('FACT-CHECK card: open with verdicts when something is wrong, closed when all is fine', async () => {
  const app = mount({ reply: answer({ truth: TRUTH }) });
  try {
    await app.Chat.submit('Chandrayaan-3 kab land hua?');
    await until(() => app.document.querySelector('.fcheck'));
    const card = app.document.querySelector('.fcheck');
    assert.ok(card.classList.contains('bad'));
    assert.ok(card.hasAttribute('open'), 'a wrong claim opens the card');
    assert.match(text(card.querySelector('.fc-h')), /FACT-CHECK.*SOURCES SE.*1 galat/);
    const rows = [...card.querySelectorAll('.fc-row')];
    assert.deepEqual(rows.map(r => text(r.querySelector('.fc-v'))), ['PAKKA', 'SHAK', 'GALAT']);
    assert.match(text(rows[2]), /Rover ka naam Vikram.*Vikram lander hai.*→ Rover Pragyan hai/);
    assert.doesNotMatch(text(rows[0]), /→/);
    assert.match(text(card.querySelector('.fc-f')), /galti ho sakti hai/);
    const quiet = app.Usage.extras({ reply: { truth: { ...TRUTH, shak: 0, galat: 0, ok: 3, basis: 'model', claims: [TRUTH.claims[0]] } } })[0];
    assert.equal(quiet.hasAttribute('open'), false);
    assert.match(text(quiet.querySelector('.fc-h')), /BINA SOURCE.*sab pakka/);
    assert.equal(app.Usage.extras({ reply: { type: 'text' } }).length, 0);
    assert.equal(app.Usage.extras({ reply: { truth: { claims: [] } } }).length, 0);
  } finally { app.close(); }
});
test('low Groq quota is announced once a day, not on every answer', async () => {
  const app = mount({ reply: answer({ quota: { provider: 'groq', left: 0.12 } }) });
  try {
    const toasts = () => [...app.document.querySelectorAll('.toast')].filter(t => /quota ~12% bacha/.test(t.textContent)).length;
    await app.Chat.submit('Pehla sawaal');
    await until(() => app.sent.length === 1 && !app.Chat.isBusy());
    assert.equal(toasts(), 1);
    assert.equal(app.S.settings.quotaWarnDay, new Date().toISOString().slice(0, 10));
    await app.Chat.submit('Doosra sawaal');
    await until(() => app.sent.length === 2 && !app.Chat.isBusy());
    assert.equal(toasts(), 1, 'same day: no second toast');
    app.Usage.absorb(null, { quota: { left: 'x' } });
    app.Usage.absorb(null, {});
  } finally { app.close(); }
});
test('usage screen: totals, keys with state pills, models, features, days, hallucination controls', async () => {
  const app = mount({ reply: answer() });
  try {
    app.App.show('usage');
    const v = () => app.document.querySelector('#v-usage');
    await until(() => v().querySelector('.us-top'));
    assert.equal(app.sent[0].usage, true);
    const t = text(v().querySelector('.us-top'));
    assert.match(t, /1\.5K requests/);
    assert.match(t, /2\.3M tokens/);
    assert.match(t, /2h 1m baad/);
    assert.match(t, /Standard: Groq ~31% bacha/);
    assert.ok(v().querySelector('.us-top .pill.warn'));
    const prov = v().querySelector('.us-prov');
    assert.match(text(prov.querySelector('.k')), /GROQ · 2\/3 KEYS/);
    const keys = [...prov.querySelectorAll('.us-key')];
    assert.equal(keys.length, 2, 'the empty third slot is not listed');
    assert.match(text(keys[0].querySelector('.us-ksum')), /Key 1.*Limit khatam.*1\.0K req/);
    assert.match(text(keys[1].querySelector('.us-ksum')), /Key 2.*Ruka hua/);
    assert.ok(keys[0].hasAttribute('open') && keys[1].hasAttribute('open'), 'problem keys are open');
    assert.match(text(keys[0]), /gpt-oss-120b.*1000 \/ 1000 req.*2\.0M \/ 200K tok/);
    assert.match(text(keys[0]), /quota khatam; ~1h 30m baad/);
    assert.ok(keys[0].querySelector('.us-bar.bad'));
    assert.match(text(keys[1]), /ruka|10m ke liye/i);
    assert.match(text(keys[1]), /Pichhle 1 min: 2 \/ 25 req/);
    assert.match(text(prov.querySelector('.us-rules')), /Rate-limit niyam.*alag account/);
    assert.match(text(v()), /Key nahi: Gemini\./);
    assert.deepEqual([...v().querySelectorAll('.us-frow .us-fn')].map(x => text(x)), ['Standard jawab', 'Council modes', 'Fact-check']);
    assert.equal(v().querySelectorAll('.us-day').length, 3);
    assert.ok(v().querySelector('.us-day.today'));
    assert.equal(v().querySelector('.us-truth'), null, 'local report view retains counters but no duplicated quality editor');
  } finally { app.close(); }
});
test('usage history remains locally accessible without duplicate Settings navigation', async () => {
  let mode = 'ok';
  const app = mount({ reply: (req) => (req.usage ? (mode === 'ok' ? { type: 'usage', usage: REPORT } : { type: 'text', text: 'demo' }) : { type: 'text', text: 'ok' }) });
  try {
    app.App.show('settings');
    const v = app.document.querySelector('#v-settings');
    assert.doesNotMatch(text(v), /API usage/);
    app.App.show('usage');
    await until(() => app.document.querySelector('#v-usage .us-top'));
    assert.equal(app.document.querySelector('#v-usage').classList.contains('on'), true);
    assert.match(app.Usage.brief(), /Aaj 1\.5K requests · 2\.3M tokens/);
    mode = 'demo';
    [...app.document.querySelectorAll('#v-usage .sech button')].find(b => b.textContent === 'Refresh').click();
    await until(() => /usage nahi aata/.test(text(app.document.querySelector('#v-usage .us-load'))));
    assert.equal(app.sent.filter(r => r.usage).length, 2);
  } finally { app.close(); }
});
test('Android controller pairing exists only in its in-app sheet and clears the one-time code', async () => {
  const pairCodes = [], syncCalls = [];
  const native = {
    controllerStatus: () => JSON.stringify({ linked: false, revision: 0, config_cached: false }),
    controllerPair: (id, code) => { pairCodes.push(code); setTimeout(() => app.window.__adarshResult(id, JSON.stringify({ ok: true, revision: 7 }), null), 0); },
    controllerSync: id => { syncCalls.push(true); setTimeout(() => app.window.__adarshResult(id, JSON.stringify({ ok: true, revision: 8 }), null), 0); }
  };
  const app = mount({ native });
  try {
    app.App.show('settings');
    const settings = app.document.querySelector('#v-settings');
    assert.doesNotMatch(text(settings), /Hallucination control|API usage/);
    [...settings.querySelectorAll('.item')].find(b => /ADARSH Control Center/.test(b.textContent)).click();
    const sheet = app.document.querySelector('.sheet');
    const input = sheet.querySelector('input');
    assert.equal(input.getAttribute('autocomplete'), 'off');
    input.value = 'one-time-code-123456';
    [...sheet.querySelectorAll('button')].find(b => b.textContent === 'Pair phone').click();
    assert.equal(input.value, '', 'raw pairing input is cleared immediately');
    await until(() => /Phone pair hua/.test(text(sheet)));
    assert.deepEqual(pairCodes, ['one-time-code-123456']);
    [...sheet.querySelectorAll('button')].find(b => b.textContent === 'Sync now').click();
    await until(() => /Sync hua/.test(text(sheet)));
    assert.equal(syncCalls.length, 1);
  } finally { app.close(); }
});
test('Android bridge: the usage screen uses the quiet native path when it exists', async () => {
  const app = mount({});
  try {
    let n = 0;
    app.window.ADARSH_BACKEND.usage = async () => { n++; return { type: 'usage', usage: REPORT }; };
    const u = await app.Usage.load();
    assert.equal(n, 1);
    assert.equal(u.totals.req, 1530);
    assert.equal(app.sent.length, 0, 'nothing went through the normal chat send');
  } finally { app.close(); }
});
test('wiring: HTTP body carries truth + usage, the bridge has usage(), numbers format for the phone', () => {
  const backend = fs.readFileSync(path.join(UI, 'src/js/07-backend.js'), 'utf8');
  assert.match(backend, /truth: req\.truth \|\| null, usage: req\.usage === true \? true : null/);
  assert.match(fs.readFileSync(path.join(UI, 'src/js/00-android-bridge.js'), 'utf8'), /usage\(\) \{ return quiet\(\{ usage: true \}/);
  const app = mount({});
  try {
    const { Usage } = app;
    assert.deepEqual([0, 999, 1000, 12345, 1530000, 24000000].map(Usage.fmt), ['0', '999', '1.0K', '12K', '1.5M', '24M']);
    assert.deepEqual([0, 45, 61, 3600, 7260].map(Usage.dur), ['0s', '45s', '2m', '1h 0m', '2h 1m']);
  } finally { app.close(); }
});
