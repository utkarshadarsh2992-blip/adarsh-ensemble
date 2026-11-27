'use strict';
/* Change 1.5 (js/04-news.js): cloud news dashboard, setup, budget, debate, briefing lines. */
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
function mount({ settings, store, reply, native, fetchImpl, ls } = {}) {
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
  w.fetch = fetchImpl || (async () => { throw new Error('network disabled in test'); });
  for (const [k, v] of Object.entries(ls || {})) w.localStorage.setItem(k, v);
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
  new vm.Script('globalThis.TEST = { S, Chat, App, News, Briefing };').runInContext(ctx);
  return { dom, window: w, document: w.document, sent, ...w.TEST, close: () => dom.window.close() };
}
const URLN = 'https://abc.supabase.co/functions/v1/news-api';
const CFG = { 'adarsh.news.cfg': JSON.stringify({ url: URLN, secret: 'SECRET123' }) };
const item = (o = {}) => ({ id: 'i1', title: 'OpenAI naya model laya', points: ['Pehla point', 'Doosra point'], tag: 'AI', region: 'US', company: 'OpenAI', activity: 'model', score: 9, breaking: true, verified: 'confirmed', n_sources: 3, state_media: false, claim_tag: '', source: 'Reuters', url: 'https://example.com/a', created_at: new Date().toISOString(), read: false, saved: false, kind: 'news', ...o });
function api(over = {}) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, headers: init.headers, body });
    const h = over[body.action];
    const r = typeof h === 'function' ? h(body) : h;
    const res = r === undefined ? { ok: true } : r;
    return { ok: res.__status ? res.__status < 400 : true, status: res.__status || 200, json: async () => res };
  };
  return { f, calls };
}
const L = (items, more = false) => ({ ok: true, items, more });
async function open(m) { m.App.show('news'); await settle(30); }

test('not configured: setup card, no network call', async () => {
  const a = api(); const m = mount({ fetchImpl: a.f });
  await open(m);
  assert.match(text(m.document.querySelector('#v-news')), /Setup karo/);
  assert.equal(a.calls.length, 0);
  assert.equal(m.News.configured(), false);
  m.close();
});
test('right-half inward swipe opens News; controls, vertical motion and horizontal scrollers are ignored', () => {
  const m = mount();
  const phone = m.document.querySelector('#phone');
  phone.getBoundingClientRect = () => ({ left: 0, right: 480, top: 0, bottom: 900, width: 480, height: 900 });
  const pointer = (target, type, x, y) => {
    const ev = new m.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(ev, { clientX: { value: x }, clientY: { value: y }, pointerType: { value: 'touch' }, isPrimary: { value: true } });
    target.dispatchEvent(ev);
  };
  pointer(phone, 'pointerdown', 300, 220); pointer(phone, 'pointerup', 190, 224);
  assert.equal(m.App.view, 'news', 'a leftward swipe from anywhere in the app right half opens News');

  m.App.show('chat');
  pointer(phone, 'pointerdown', 220, 220); pointer(phone, 'pointerup', 110, 224);
  assert.equal(m.App.view, 'chat', 'a swipe starting in the left half is not hijacked');

  const control = m.document.createElement('button'); phone.append(control);
  pointer(control, 'pointerdown', 472, 220); pointer(control, 'pointerup', 370, 220);
  assert.equal(m.App.view, 'chat', 'a swipe that begins on an interactive control is ignored');

  pointer(phone, 'pointerdown', 472, 220); pointer(phone, 'pointerup', 360, 330);
  assert.equal(m.App.view, 'chat', 'vertical movement is not treated as navigation');

  const scroller = m.document.createElement('div'); scroller.style.overflowX = 'auto';
  Object.defineProperty(scroller, 'scrollWidth', { value: 320 }); Object.defineProperty(scroller, 'clientWidth', { value: 120 });
  phone.append(scroller);
  pointer(scroller, 'pointerdown', 472, 220); pointer(scroller, 'pointerup', 360, 220);
  assert.equal(m.App.view, 'chat', 'nested horizontal scrollers retain their own gesture');
  m.close();
});
test('Android touch events open News from the right half and claim the horizontal move', () => {
  const m = mount();
  const phone = m.document.querySelector('#phone');
  phone.getBoundingClientRect = () => ({ left: 0, right: 480, top: 0, bottom: 900, width: 480, height: 900 });
  const emit = (type, x, y) => {
    const point = { clientX: x, clientY: y, identifier: 1 };
    const ev = new m.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(ev, {
      touches: { value: type === 'touchend' ? [] : [point] },
      changedTouches: { value: [point] }
    });
    phone.dispatchEvent(ev);
    return ev;
  };
  emit('touchstart', 300, 220);
  assert.equal(emit('touchmove', 270, 222).defaultPrevented, true, 'WebView should not take over a clear leftward swipe');
  emit('touchend', 240, 224);
  assert.equal(m.App.view, 'news', 'Touch Events fallback opens News after a short right-half swipe');
  m.close();
});
test('reverse swipe closes News and chat header exposes a visible fallback button', () => {
  const m = mount();
  const phone = m.document.querySelector('#phone');
  phone.getBoundingClientRect = () => ({ left: 0, right: 480, top: 0, bottom: 900, width: 480, height: 900 });
  const pointer = (target, type, x, y) => {
    const ev = new m.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(ev, { clientX: { value: x }, clientY: { value: y }, pointerType: { value: 'touch' }, isPrimary: { value: true } });
    target.dispatchEvent(ev);
  };
  m.App.show('news');
  pointer(phone, 'pointerdown', 120, 220); pointer(phone, 'pointerup', 190, 224);
  assert.equal(m.App.view, 'chat', 'a dominant rightward swipe closes News');
  assert.ok(m.document.querySelector('#v-chat [aria-label="Open news"]'), 'chat has a tappable non-gesture fallback');
  m.close();
});

test('dashboard lists cards with badges, filter chips and the request body', async () => {
  const a = api({ list: (b) => L(b.filter === 'CN' ? [item({ id: 'c1', title: 'Xinhua daava', region: 'CN', state_media: true, claim_tag: 'sarkari daava', verified: 'state-only', breaking: false })] : [item(), item({ id: 'i2', title: 'Doosri khabar', breaking: false, verified: 'single' })]) });
  const m = mount({ fetchImpl: a.f, ls: CFG });
  await open(m);
  const v = m.document.querySelector('#v-news');
  assert.equal(v.querySelectorAll('.nw-card').length, 2);
  assert.match(text(v), /BREAKING/); assert.match(text(v), /PAKKA/); assert.match(text(v), /EK SOURCE/); assert.match(text(v), /Debate with AI/);
  assert.equal(v.querySelectorAll('.nw-chip').length, 18);
  assert.equal(a.calls[0].url, URLN); assert.equal(a.calls[0].headers['x-app-secret'], 'SECRET123');
  [...v.querySelectorAll('.nw-chip')].find(b => text(b) === 'China').click(); await settle(30);
  assert.equal(a.calls.filter(c => c.body.action === 'list').pop().body.filter, 'CN');
  assert.match(text(v), /SARKARI DAAVA/); assert.match(text(v), /SIRF SARKARI/);
  m.close();
});
test('card links are https only, text is never HTML', async () => {
  const a = api({ list: L([item({ title: '<img src=x onerror=alert(1)> hi', url: 'javascript:alert(1)' }), item({ id: 'i3', url: 'http://plain.example.com' })]) });
  const m = mount({ fetchImpl: a.f, ls: CFG });
  await open(m);
  const v = m.document.querySelector('#v-news');
  assert.equal(v.querySelectorAll('img').length, 0);
  assert.equal(v.querySelectorAll('a[href]').length, 0);
  assert.match(text(v), /<img src=x/);
  m.close();
});
test('Debate with AI opens a new chat and sends the news as data', async () => {
  const a = api({ list: L([item({ state_media: true, claim_tag: 'sarkari daava', verified: 'state-only' })]) });
  const m = mount({ fetchImpl: a.f, ls: CFG, settings: { mode: 'standard' } });
  await open(m);
  [...m.document.querySelectorAll('#v-news .nw-card .btn')].find(b => /Debate/.test(text(b))).click();
  await until(() => m.sent.length > 0);
  const msg = JSON.stringify(m.sent[0]);
  assert.match(msg, /OpenAI naya model laya/); assert.match(msg, /DATA/); assert.match(msg, /SARKARI DAAVA/); assert.match(msg, /counter-argument/);
  assert.ok(m.document.querySelector('#v-chat.on'));
  m.close();
});
test('Chat sits beside Debate on a card and starts an explanation chat with news/source context', async () => {
  const story = item({ url: 'https://example.com/article', sources: [{ title: 'Independent report', publisher: 'Reuters', url: 'https://reuters.com/world/story' }] });
  const a = api({ list: L([story]) });
  const m = mount({ fetchImpl: a.f, ls: CFG, settings: { mode: 'standard' } });
  await open(m);
  const card = m.document.querySelector('#v-news .nw-card');
  const actions = [...card.querySelectorAll('.nw-acts .btn')];
  assert.match(text(actions[0]), /Debate with AI/);
  assert.match(text(actions[1]), /^Chat$/);
  actions[1].click();
  await until(() => m.sent.length > 0);
  const msg = JSON.stringify(m.sent[0]);
  assert.match(msg, /OpenAI naya model laya/);
  assert.match(msg, /simple, saaf Hinglish/);
  assert.match(msg, /<news>/);
  assert.match(msg, /https:\/\/example\.com\/article/);
  assert.match(msg, /https:\/\/reuters\.com\/world\/story/);
  assert.match(msg, /untrusted DATA/);
  assert.match(msg, /DOI|URL/);
  assert.ok(m.document.querySelector('#v-chat.on'));
  m.close();
});
test('Chat action is also available beside Debate in the detail sheet with detailed sources', async () => {
  const detailed = item({ url: 'https://example.com/full', sources: [{ title: 'SEC filing', publisher: 'SEC', url: 'https://www.sec.gov/Archives/edgar/data/1/filing.htm' }] });
  const a = api({ list: L([item()]), get: { ok: true, item: detailed } });
  const m = mount({ fetchImpl: a.f, ls: CFG, settings: { mode: 'standard' } });
  await open(m);
  m.document.querySelector('#v-news .nw-title').click();
  await until(() => m.document.querySelector('.sheet .nw-chat'));
  const actions = [...m.document.querySelectorAll('.sheet .nw-acts .btn')];
  assert.match(text(actions[0]), /Debate with AI/);
  assert.match(text(actions[1]), /^Chat$/);
  actions[1].click();
  await until(() => m.sent.length > 0);
  const msg = JSON.stringify(m.sent[0]);
  assert.match(msg, /https:\/\/example\.com\/full/);
  assert.match(msg, /https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1\/filing\.htm/);
  assert.ok(m.document.querySelector('#v-chat.on'));
  m.close();
});
test('Save marks the item and calls mark', async () => {
  const a = api({ list: L([item()]) });
  const m = mount({ fetchImpl: a.f, ls: CFG });
  await open(m);
  [...m.document.querySelectorAll('#v-news .nw-card .btn')].find(b => /Save/.test(text(b))).click(); await settle(20);
  const c = a.calls.find(x => x.body.action === 'mark'); assert.deepEqual({ ...c.body }, { id: 'i1', saved: true, action: 'mark' });
  assert.match(text(m.document.querySelector('#v-news')), /Saved/);
  m.close();
});
test('offline: shows the cached list with a note', async () => {
  const good = api({ list: L([item({ title: 'Cache wali khabar' })]) });
  let m = mount({ fetchImpl: good.f, ls: CFG }); await open(m);
  const cache = m.window.localStorage.getItem('adarsh.news.cache'); assert.match(cache, /Cache wali/); m.close();
  m = mount({ fetchImpl: async () => { throw new Error('Failed to fetch'); }, ls: { ...CFG, 'adarsh.news.cache': cache } });
  await open(m);
  const t = text(m.document.querySelector('#v-news'));
  assert.match(t, /Cache wali khabar/); assert.match(t, /Internet nahi/); assert.match(t, /Purani list/);
  m.close();
});
test('error mapping speaks Hinglish', () => {
  const m = mount(); const f = m.News.friendly;
  assert.match(f('HTTP 401'), /APP_SECRET/); assert.match(f('HTTP 404'), /URL galat/); assert.match(f('Failed to fetch'), /Internet/); assert.match(f('timeout'), /der/);
  assert.match(f('Pehle bot ko /start bhejo'), /bot ko/);
  m.close();
});
test('setup: secret goes only to localStorage cfg in browser, never into app state', async () => {
  const a = api({ ping: { ok: true, version: 1, telegram: { linked: true }, fcm: { configured: false, devices: 0 }, tavily: true, groq: { keys: 2 } }, settings_set: { ok: true } });
  const m = mount({ fetchImpl: a.f });
  m.News.setupSheet(() => {}); await settle(10);
  const inputs = m.document.querySelectorAll('.sheet input');
  inputs[0].value = 'http://bad.example.com'; inputs[1].value = 'S3CRET-XYZ';
  [...m.document.querySelectorAll('.sheet .btn')].find(b => /Save \+ test/.test(text(b))).click(); await settle(20);
  assert.match(text(m.document.querySelector('.sheet')), /https/); assert.equal(m.window.localStorage.getItem('adarsh.news.cfg'), null);
  inputs[0].value = URLN;
  [...m.document.querySelectorAll('.sheet .btn')].find(b => /Save \+ test/.test(text(b))).click(); await until(() => /Connected/.test(text(m.document.querySelector('.sheet'))));
  assert.match(text(m.document.querySelector('.sheet')), /Groq keys: 2/);
  assert.equal(JSON.parse(m.window.localStorage.getItem('adarsh.news.cfg')).secret, 'S3CRET-XYZ');
  assert.ok(!JSON.stringify(m.S).includes('S3CRET-XYZ'));
  assert.ok(!(m.window.localStorage.getItem('adarsh.ui.v3') || '').includes('S3CRET-XYZ'));
  assert.ok(a.calls.some(c => c.body.action === 'settings_set' && c.body.digest_time));   // digest time synced after connecting
  m.close();
});
test('google-services.json autofill picks the right client and warns on wrong package', () => {
  const m = mount();
  const gs = (pkg) => JSON.stringify({ project_info: { project_number: '123456789', project_id: 'my-proj' }, client: [{ client_info: { mobilesdk_app_id: '1:123456789:android:abc', android_client_info: { package_name: 'other.app' } }, api_key: [{ current_key: 'AIzaOTHER' }] }, { client_info: { mobilesdk_app_id: '1:123456789:android:def', android_client_info: { package_name: pkg } }, api_key: [{ current_key: 'AIzaKEY' }] }] });
  const p = m.News.parseGoogleServices(gs('app.adarsh.ensemble'));
  assert.deepEqual({ ...p }, { apiKey: 'AIzaKEY', appId: '1:123456789:android:def', projectId: 'my-proj', senderId: '123456789', pkg: 'app.adarsh.ensemble', pkgOk: true });
  assert.equal(m.News.parseGoogleServices(gs('x.y')).pkgOk, false);
  assert.equal(m.News.parseGoogleServices('not json'), null);
  m.close();
});
test('Firebase JSON paste accepts BOM/fenced copies and reports syntax location without echoing config', () => {
  const m = mount();
  const gs = JSON.stringify({ project_info: { project_number: '123456789', project_id: 'my-proj' }, client: [{ client_info: { mobilesdk_app_id: '1:123456789:android:def', android_client_info: { package_name: 'app.adarsh.ensemble' } }, api_key: [{ current_key: 'AIzaDUMMY' }] }] });
  const pasted = m.News.parseGoogleServices('\uFEFF```json\n' + gs + '\n```');
  assert.equal(pasted.projectId, 'my-proj');
  const broken = '{\n  "project_info": {"project_number":"123","project_id":"p"},\n  "client": [{"api_key":[{"current_key":"AIza-DO-NOT-ECHO"}],}]\n}';
  const bad = m.News.inspectGoogleServices(broken);
  assert.equal(bad.config, null);
  assert.match(bad.error, /JSON syntax galat \(line \d+, column \d+\)/);
  assert.doesNotMatch(bad.error, /AIza|DO-NOT-ECHO/);
  const wrongFile = m.News.inspectGoogleServices(JSON.stringify({ type: 'service_account', private_key: 'PRIVATE-DO-NOT-ECHO' }));
  assert.match(wrongFile.error, /Service-account\/private-key JSON mat paste karo/);
  assert.doesNotMatch(wrongFile.error, /PRIVATE-DO-NOT-ECHO/);
  m.close();
});
test('News setup displays a safe Firebase JSON syntax hint instead of the pasted contents', () => {
  const native = { newsStatus: () => JSON.stringify({ configured: true, url: URLN }), newsCall() {}, fcmStatus: () => '{"configured":false}' };
  const m = mount({ native });
  try {
    m.News.setupSheet(() => {});
    const paste = m.document.querySelector('.nw-paste');
    paste.value = '{\n  "project_info":{"project_number":"123","project_id":"p"},\n  "client":[{"api_key":[{"current_key":"AIza-DO-NOT-SHOW"}],}]\n}';
    paste.dispatchEvent(new m.window.Event('input'));
    const out = paste.closest('.nw-sec').querySelector('.nw-out');
    assert.match(text(out), /JSON syntax galat \(line \d+, column \d+\)/);
    assert.doesNotMatch(text(out), /AIza|DO-NOT-SHOW/);
  } finally { m.close(); }
});
test('Android: secret is write-only, calls go through newsCall and the callback', async () => {
  const log = [];
  const native = {
    newsStatus: () => JSON.stringify({ configured: true, url: URLN }),
    newsSet: (j) => { log.push(['set', j]); return '{"ok":true}'; },
    newsCall: (id, j) => { const b = JSON.parse(j); log.push(['call', b.action]); setTimeout(() => m.window.__adarshNews(id, b.action === 'list' ? L([item()]) : { ok: true }), 5); },
    fcmSet: (j) => { log.push(['fcm', j]); return '{"ok":true}'; }, fcmStatus: () => JSON.stringify({ configured: true, gms: true, token: true, registered: true, error: '' })
  };
  const m = mount({ native });
  assert.equal(m.News.status().url, URLN);
  await open(m);
  assert.equal(m.document.querySelectorAll('#v-news .nw-card').length, 1);
  assert.ok(log.some(l => l[0] === 'call' && l[1] === 'list'));
  assert.equal(m.window.localStorage.getItem('adarsh.news.cfg'), null);
  m.News.setupSheet(() => {}); await settle(10);
  const ta = m.document.querySelector('.sheet textarea');
  ta.value = JSON.stringify({ project_info: { project_number: '55', project_id: 'p1' }, client: [{ client_info: { mobilesdk_app_id: '1:55:android:z', android_client_info: { package_name: 'app.adarsh.ensemble' } }, api_key: [{ current_key: 'AIzaK' }] }] });
  ta.dispatchEvent(new m.window.Event('input')); await settle(5);
  [...m.document.querySelectorAll('.sheet .btn')].find(b => /Save Firebase/.test(text(b))).click();
  const f = log.find(l => l[0] === 'fcm'); assert.deepEqual(JSON.parse(f[1]), { apiKey: 'AIzaK', appId: '1:55:android:z', projectId: 'p1', senderId: '55' });
  assert.equal(m.document.querySelector('.sheet input[type=password]').value, '');
  m.close();
});
test('Android: unknown action is refused and a native timeout/error is mapped', async () => {
  const native = { newsStatus: () => '{"configured":true,"url":"' + URLN + '"}', newsCall: () => { throw new Error('boom'); } };
  const m = mount({ native });
  assert.equal((await m.News.call('drop_tables')).ok, false);
  const r = await m.News.call('ping'); assert.equal(r.ok, false); assert.ok(r.error);
  m.close();
});
test('budget sheet shows bars and saves caps via settings_set', async () => {
  const a = api({ budget: { ok: true, groq: { tokens_used: 120000, tokens_cap: 150000, calls_used: 100, calls_cap: 400, frac: 0.8, state: 'warn' }, tavily: { month_used: 70, month_cap: 700, frac: 0.1 }, alerts: { today: 2, cap: 5 } },
    settings_get: { ok: true, settings: { groq_tokens_cap: 150000, groq_calls_cap: 400, tavily_month_cap: 700, alerts_per_day: 5, alert_min_score: 8 } }, settings_set: { ok: true } });
  const m = mount({ fetchImpl: a.f, ls: CFG });
  m.News.budgetSheet(); await until(() => m.document.querySelector('.sheet input[type=number]'));
  const t = text(m.document.querySelector('.sheet'));
  assert.match(t, /120K \/ 150K/); assert.match(t, /80%/); assert.match(t, /2 \/ 5/); assert.match(t, /80% par aur 100%/);
  const inputs = m.document.querySelectorAll('.sheet input[type=number]'); inputs[0].value = '90000';
  [...m.document.querySelectorAll('.sheet .seg')][0].querySelectorAll('button')[2].click();   // alerts/day = 3
  [...m.document.querySelectorAll('.sheet .btn')].find(b => text(b) === 'Save').click(); await settle(20);
  const s = a.calls.filter(c => c.body.action === 'settings_set').pop().body;
  assert.equal(s.groq_tokens_cap, 90000); assert.equal(s.alerts_per_day, 3); assert.equal(s.alert_min_score, 8);
  m.close();
});
test('briefing: news lines present when connected, empty when not or switched off', async () => {
  const a = api({ top: { ok: true, items: [item(), item({ id: 'x', title: 'TASS: kuch', state_media: true, claim_tag: 'sarkari daava', verified: 'state-only', region: 'RU', score: 7 })] } });
  const m = mount({ fetchImpl: a.f, ls: CFG });
  assert.deepEqual([...m.News.briefingLines()], []);
  await m.News.prefetchTop(2000);
  const l = [...m.News.briefingLines()];
  assert.equal(l.length, 2); assert.ok(l.every(x => x.length <= 240));
  assert.match(l[0], /^\[AI·US\] OpenAI naya model laya — Pehla point \(9\/10, PAKKA\)$/); assert.match(l[1], /^SARKARI DAAVA · /);
  assert.equal(m.Briefing.context().news.length, 2);
  m.S.settings.newsBriefing = false; assert.equal(m.News.briefingLines().length, 0);
  m.close();
  const off = mount(); assert.equal(off.Briefing.context().news.length, 0);
  await off.News.prefetchTop(50); assert.equal(off.News.briefingLines().length, 0); off.close();
});
test('Briefing.start stays synchronous when news is not configured, waits for news when it is', async () => {
  const gate = []; const a = api({ top: () => ({ ok: true, items: [item()] }) });
  const m = mount({ fetchImpl: a.f, ls: CFG, settings: { briefingConsent: true } });
  m.Briefing.start(); await until(() => m.sent.length > 0);
  assert.equal(m.sent[0].briefing.news.length, 1);
  assert.ok(a.calls.some(c => c.body.action === 'top'));
  await settle(300); m.close();
  const m2 = mount({ settings: { briefingConsent: true } });
  m2.Briefing.start(); assert.ok(m2.S.chats.some(c => c.briefing));   // chat created in the same tick
  await settle(300); m2.close();
});
test('__adarshOpen routes news targets: detail by id, budget, and plain news', async () => {
  const a = api({ get: { ok: true, item: { ...item({ id: 'abc', title: 'Notification wali' }), why: 'Reuters + AP dono', sources: [{ title: 'Reuters story', url: 'https://r.example/x', publisher: 'Reuters', state_media: false }, { title: 'Xinhua', url: 'http://x.cn', publisher: 'Xinhua', state_media: true }] } }, list: L([]), budget: { ok: true, groq: { frac: 0.1 }, tavily: { frac: 0 }, alerts: {} }, settings_get: { ok: true, settings: {} } });
  const m = mount({ fetchImpl: a.f, ls: CFG });
  m.window.__adarshOpen('news:abc');
  await until(() => /Reuters \+ AP dono/.test(text(m.document.querySelector('.sheet') || {})));
  const t = text(m.document.querySelector('.sheet'));
  assert.match(t, /Notification wali/); assert.match(t, /SARKARI/); assert.match(t, /Debate with AI/);
  assert.equal([...m.document.querySelectorAll('.sheet a')].filter(x => /x\.cn/.test(x.href)).length, 0);   // http link dropped
  assert.ok(m.document.querySelector('#v-news.on'));
  m.window.__adarshOpen('news:budget'); await until(() => /News AI budget/.test(text(m.document.querySelectorAll('.sheet')[1] || m.document.querySelector('.sheet'))));
  await settle(300); m.close();
});
test('Settings has the News group and Briefing time save syncs digest time', async () => {
  const a = api({ settings_set: { ok: true } });
  const m = mount({ fetchImpl: a.f, ls: CFG });
  m.App.show('settings'); await settle(20);
  const t = text(m.document.querySelector('#v-settings'));
  assert.match(t, /News dashboard/); assert.match(t, /News setup/); assert.match(t, /Briefing mein news/); assert.match(t, /News AI budget/);
  m.Briefing.timeSheet(() => {}); await settle(10);
  m.document.querySelector('.sheet input[type=time]').value = '22:15';
  [...m.document.querySelectorAll('.sheet .btn')].find(b => text(b) === 'Save').click(); await settle(20);
  const c = a.calls.filter(x => x.body.action === 'settings_set').pop();
  assert.equal(c.body.digest_time, '22:15'); assert.ok(c.body.tz);
  assert.equal(m.S.settings.newsTimeSynced.startsWith('22:15|'), true);
  m.close();
});
test('briefing copy goes to Telegram once a day and respects the switch', async () => {
  const a = api({ telegram_copy: { ok: true, chunks: 1 } });
  const m = mount({ fetchImpl: a.f, ls: CFG });
  m.News.copyBriefing({ text: 'Aaj ka hisaab…' }, '2026-11-25'); await settle(30);
  const c = a.calls.filter(x => x.body.action === 'telegram_copy'); assert.equal(c.length, 1); assert.match(c[0].body.text, /hisaab/);
  m.News.copyBriefing({ text: 'dobara' }, '2026-11-25'); await settle(30);
  assert.equal(a.calls.filter(x => x.body.action === 'telegram_copy').length, 1);
  m.S.settings.briefingTelegram = false; m.News.copyBriefing({ text: 'naya din' }, '2026-11-26'); await settle(30);
  assert.equal(a.calls.filter(x => x.body.action === 'telegram_copy').length, 1);
  m.close();
});


test('Patterns view renders validated cards, region links, cache time and refresh request', async () => {
  const pattern = { title: 'AI buildout wave', pattern: 'India aur China dono compute capacity badha rahe hain.', type: 'compute/datacentre buildout', signal: 'strong', generated_at: '2026-11-27T10:00:00.000Z', regions: [{ region: 'IN', what: 'India mein capacity move', item_ids: ['i1'] }, { region: 'CN', what: 'China mein parallel move', item_ids: ['i2'] }], why_it_matters: 'AGI compute race', watch_next: 'Next data-centre filings', assumption: 'Reported events complete nahi hain.', items: [{ id: 'i1', title: 'India compute news', url: 'https://example.com/in', source: 'Reuters', region: 'IN' }, { id: 'i2', title: 'China compute news', url: 'https://example.com/cn', source: 'FT', region: 'CN' }] };
  const a = api({ list: L([]), patterns: { ok: true, generated_at: pattern.generated_at, cached: true, patterns: [pattern] } });
  const m = mount({ fetchImpl: a.f, ls: CFG });
  await open(m);
  [...m.document.querySelectorAll('.nw-mode')].find(b => text(b) === 'Patterns').click();
  await until(() => m.document.querySelector('.nw-pattern-card'));
  const v = m.document.querySelector('#v-news');
  assert.equal(v.querySelectorAll('.nw-pattern-card').length, 1);
  assert.match(text(v), /AI buildout wave/); assert.match(text(v), /IN/); assert.match(text(v), /CN/); assert.match(text(v), /Assumption:/); assert.match(text(v), /Generated/);
  assert.equal(a.calls.filter(c => c.body.action === 'patterns').length, 1);
  v.querySelector('.nw-pattern-refresh').click(); await settle(20);
  assert.ok(a.calls.some(c => c.body.action === 'patterns' && c.body.refresh === true));
  m.close();
});

test('Patterns error state is visible and pattern Chat carries the linked evidence', async () => {
  const pattern = { title: 'Policy wave', pattern: 'Dono regions policy signal de rahe hain.', type: 'policy wave', signal: 'medium', regions: [{ region: 'US', what: 'US policy', item_ids: ['i1'] }, { region: 'EU', what: 'EU policy', item_ids: ['i2'] }], why_it_matters: 'AI governance', watch_next: 'Implementation', assumption: 'Timing inferred hai.', items: [{ id: 'i1', title: 'US policy news', url: 'https://example.com/us', source: 'Source A', region: 'US' }, { id: 'i2', title: 'EU policy news', url: 'https://example.com/eu', source: 'Source B', region: 'EU' }] };
  const a = api({ list: L([]), patterns: { ok: true, generated_at: new Date().toISOString(), patterns: [pattern] } });
  const m = mount({ fetchImpl: a.f, ls: CFG, settings: { mode: 'standard' } }); await open(m);
  [...m.document.querySelectorAll('.nw-mode')].find(b => text(b) === 'Patterns').click(); await until(() => m.document.querySelector('.nw-pattern-card'));
  m.document.querySelector('.nw-pattern-card .nw-chat').click(); await until(() => m.sent.length > 0);
  assert.match(JSON.stringify(m.sent[0]), /Policy wave/); assert.match(JSON.stringify(m.sent[0]), /US policy news/); assert.match(JSON.stringify(m.sent[0]), /untrusted DATA/); assert.ok(m.document.querySelector('#v-chat.on'));
  m.close();
  const err = api({ list: L([]), patterns: { ok: false, error: 'Pattern server down', __status: 500 } });
  const e = mount({ fetchImpl: err.f, ls: CFG }); await open(e); [...e.document.querySelectorAll('.nw-mode')].find(b => text(b) === 'Patterns').click(); await until(() => /Pattern server down/.test(text(e.document.querySelector('#v-news')))); e.close();
});
