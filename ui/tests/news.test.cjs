'use strict';
/* Change 1.6 (js/04-news.js): Controller-managed config and native-only News reader. */
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
const openDoms = new Set();
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await settle(10); } }
test.after(() => { for (const dom of openDoms) { try { dom.window.close(); } catch (e) {} } openDoms.clear(); });
function mount({ settings, store, reply, native, fetchImpl, ls } = {}) {
  const dom = new JSDOM(INDEX, { url: 'https://appassets.androidplatform.net/assets/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  openDoms.add(dom);
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
  if (!native && fetchImpl) native = {
    newsStatus: () => JSON.stringify({ configured: true, url: URLN }),
    newsCall(id, json) {
      Promise.resolve().then(() => fetchImpl(URLN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json }))
        .then(async response => {
          const result = await response.json();
          const payload = !response.ok && !(result && result.error) ? { ok: false, error: 'HTTP ' + response.status } : result;
          w.__adarshNews(id, JSON.stringify(payload));
        }, () => w.__adarshNews(id, JSON.stringify({ ok: false, error: 'Failed to fetch' })));
      return '{}';
    }
  };
  if (native) w.AdarshNative = native;
  w.localStorage.setItem('adarsh.ui.v3', JSON.stringify({ ...(store || {}), settings: { ui4: 1, bootAnim: false, ...(settings || {}) } }));
  const sent = [];
  w.ADARSH_BACKEND = {
    async send(req) { sent.push(JSON.parse(JSON.stringify(req))); return typeof reply === 'function' ? reply(req) : (reply || { type: 'text', text: 'ok' }); },
    async ping() { return { ok: true, label: 'test' }; }
  };
  const ctx = dom.getInternalVMContext();
  for (const file of ORDER) new vm.Script(fs.readFileSync(path.join(UI, 'src', file), 'utf8'), { filename: path.join(UI, 'src', file) }).runInContext(ctx);
  // 00-android-bridge installs the real Android chat adapter whenever a native
  // mock is present. Keep its Controller methods, but isolate chat sends so
  // these UI tests can inspect requests without needing an engine callback.
  if (native) {
    const bridge = w.ADARSH_BACKEND || {};
    w.ADARSH_BACKEND = { ...bridge,
      async send(req) { sent.push(JSON.parse(JSON.stringify(req))); return typeof reply === 'function' ? reply(req) : (reply || { type: 'text', text: 'ok' }); },
      async ping() { return { ok: true, label: 'test' }; }
    };
  }
  new vm.Script('globalThis.TEST = { S, Chat, App, News, Briefing };').runInContext(ctx);
  return { dom, window: w, document: w.document, sent, ...w.TEST, close: () => { openDoms.delete(dom); dom.window.close(); } };
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

test('not configured: Controller pairing guidance, no phone setup or network call', async () => {
  const a = api();
  const m = mount({ native: { newsStatus: () => '{"configured":false,"url":""}', newsCall: () => { throw new Error('must not call'); } }, fetchImpl: a.f });
  await open(m);
  const view = text(m.document.querySelector('#v-news'));
  assert.match(view, /Controller/); assert.doesNotMatch(view, /Setup karo|APP_SECRET/);
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
  assert.equal(a.calls[0].url, URLN); assert.equal(a.calls[0].headers['x-app-secret'], undefined, 'the phone UI never sends a browser-side News secret');
  assert.equal(m.window.localStorage.getItem('adarsh.news.cfg'), null, 'legacy browser credential was erased');
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
test('error mapping directs configuration failures to Controller in Hinglish', () => {
  const m = mount(); const f = m.News.friendly;
  assert.match(f('HTTP 401'), /Controller/); assert.match(f('HTTP 404'), /Controller/); assert.match(f('Failed to fetch'), /Internet/); assert.match(f('timeout'), /der/);
  assert.match(f('Pehle bot ko /start bhejo'), /bot ko/);
  m.close();
});
test('mobile Settings has no key, News setup, budget, or briefing control; legacy News secret is erased', async () => {
  const native = { newsStatus: () => '{"configured":false,"url":""}' };
  const m = mount({ native, ls: CFG });
  await open(m);
  const news = text(m.document.querySelector('#v-news'));
  assert.match(news, /Controller/); assert.doesNotMatch(news, /Setup karo|APP_SECRET|News AI budget/);
  assert.equal(m.News.setupSheet, undefined); assert.equal(m.News.budgetSheet, undefined);
  assert.equal(m.window.AdarshKeys, undefined);
  assert.equal(m.window.localStorage.getItem('adarsh.news.cfg'), null);
  m.App.show('settings'); await settle(10);
  const settings = text(m.document.querySelector('#v-settings'));
  assert.match(settings, /Briefing privacy/); assert.match(settings, /News dashboard/);
  for (const label of ['API keys', 'News setup', 'News AI budget', 'Briefing mein news', 'Briefing ki copy Telegram par', 'Raat ki briefing', 'Briefing ka time']) assert.doesNotMatch(settings, new RegExp(label));
  assert.equal(m.document.querySelector('#v-settings input[type=time]'), null);
  m.close();
});

test('native News reader uses paired News bridge and disallows setup or budget actions', async () => {
  const log = [];
  const native = {
    newsStatus: () => JSON.stringify({ configured: true, url: URLN }),
    newsCall: (id, j) => { const b = JSON.parse(j); log.push(b.action); setTimeout(() => m.window.__adarshNews(id, JSON.stringify(b.action === 'list' ? L([item()]) : { ok: true })), 5); return '{}'; }
  };
  const m = mount({ native, ls: CFG });
  try {
    assert.equal(m.News.status().url, URLN);
    await open(m);
    assert.equal(m.document.querySelectorAll('#v-news .nw-card').length, 1);
    assert.ok(log.includes('list'));
    assert.equal(m.window.localStorage.getItem('adarsh.news.cfg'), null);
    assert.equal((await m.News.call('settings_set')).ok, false);
    assert.equal((await m.News.call('budget')).ok, false);
    assert.equal(m.window.AdarshKeys, undefined);
  } finally { m.close(); }
});
test('Android: unknown action is refused and a native timeout/error is mapped', async () => {
  const native = { newsStatus: () => '{"configured":true,"url":"' + URLN + '"}', newsCall: () => { throw new Error('boom'); } };
  const m = mount({ native });
  assert.equal((await m.News.call('drop_tables')).ok, false);
  const r = await m.News.call('ping'); assert.equal(r.ok, false); assert.ok(r.error);
  m.close();
});
test('mobile News dashboard has no budget sheet or budget controls', async () => {
  let m;
  const native = { newsStatus: () => JSON.stringify({ configured: true, url: URLN }), newsCall: (id, j) => {
    const body = JSON.parse(j);
    setTimeout(() => m.window.__adarshNews(id, JSON.stringify(body.action === 'list' ? L([]) : { ok: true })), 0);
    return '{}';
  } };
  m = mount({ native });
  await open(m);
  assert.equal(m.News.budgetSheet, undefined);
  assert.equal(m.document.querySelector('.nw-bud'), null);
  assert.doesNotMatch(text(m.document.querySelector('#v-news')), /AI budget dekho|News AI budget/);
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
test('__adarshOpen routes News notifications to details without a budget-settings route', async () => {
  const native = { newsStatus: () => JSON.stringify({ configured: true, url: URLN }), newsCall: (id, j) => {
    const body = JSON.parse(j); setTimeout(() => m.window.__adarshNews(id, JSON.stringify(body.action === 'get' ? { ok: true, item: { ...item({ id: body.id, title: 'Notification wali' }), why: 'Reuters + AP dono', sources: [{ title: 'Reuters story', url: 'https://r.example/x', publisher: 'Reuters', state_media: false }, { title: 'Xinhua', url: 'http://x.cn', publisher: 'Xinhua', state_media: true }] } } : { ok: true, items: [] })), 5); return '{}';
  } };
  const m = mount({ native });
  m.window.__adarshOpen('news:abc');
  await until(() => /Reuters \+ AP dono/.test(text(m.document.querySelector('.sheet') || {})));
  const t = text(m.document.querySelector('.sheet'));
  assert.match(t, /Notification wali/); assert.match(t, /SARKARI/); assert.match(t, /Debate with AI/);
  assert.equal([...m.document.querySelectorAll('.sheet a')].filter(x => /x\.cn/.test(x.href)).length, 0);
  assert.ok(m.document.querySelector('#v-news.on'));
  m.close();
});
test('Controller-managed briefing/news settings override only explicit preferences; phone privacy consent stays local', () => {
  const calls = [];
  const remote = { briefingOn: false, briefingTime: '22:15', newsBriefing: false, briefingTelegram: false, briefingConsent: true };
  const native = {
    controllerStatus: () => JSON.stringify({ linked: true, device_settings: remote }),
    briefingSet: (j) => { calls.push(JSON.parse(j)); return JSON.stringify({ ok: true, on: JSON.parse(j).on, time: JSON.parse(j).time, notify: true, exact: true }); },
    briefingStatus: () => JSON.stringify({ ok: true, notify: true, exact: true }), takeOpen: () => ''
  };
  const m = mount({ native, settings: { briefingOn: true, briefingTime: '20:00', newsBriefing: true, briefingTelegram: true, briefingConsent: false } });
  try {
    assert.equal(m.S.settings.briefingOn, false); assert.equal(m.Briefing.time(), '22:15');
    assert.equal(m.S.settings.newsBriefing, false); assert.equal(m.S.settings.briefingTelegram, false);
    assert.equal(m.S.settings.briefingConsent, false, 'remote settings cannot enable phone-local privacy consent');
    assert.equal(calls[0].time, '22:15'); assert.equal(calls[0].on, false);
    m.App.show('settings');
    const v = m.document.querySelector('#v-settings'), t = text(v);
    assert.match(t, /News dashboard/); assert.match(t, /Briefing privacy/);
    for (const label of ['News setup', 'News AI budget', 'Briefing mein news', 'Briefing ki copy Telegram par', 'Raat ki briefing', 'Briefing ka time']) assert.doesNotMatch(t, new RegExp(label));
    assert.equal(v.querySelector('input[type=time]'), null);
  } finally { m.close(); }
});
test('briefing Telegram copy runs only when enabled by Controller and sends once per day', async () => {
  const a = api({ telegram_copy: { ok: true, chunks: 1 } });
  const m = mount({ fetchImpl: a.f, ls: CFG, settings: { briefingTelegram: true } });
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
test('Pattern chat marks sarkari/unverified items as claims and forbids invented actors or forced mission links', async () => {
  const pattern = { title: 'Arctic strategy', pattern: 'Russia aur West Arctic par.', type: 'policy wave', signal: 'medium', regions: [{ region: 'RU', what: 'Strategy', item_ids: ['i1'] }, { region: 'US', what: 'Reaction', item_ids: ['i2'] }], why_it_matters: 'x', watch_next: 'y', assumption: 'z', items: [{ id: 'i1', title: 'Arctic share of GRP to reach 8.4% by 2035', url: 'https://tass.com/a', source: 'tass.com', region: 'RU', state_media: true, verified: 'none', n_sources: 1 }, { id: 'i2', title: 'US Arctic exercise', url: 'https://example.com/us', source: 'Reuters', region: 'US', state_media: false, verified: 'confirmed', n_sources: 3 }] };
  const a = api({ list: L([]), patterns: { ok: true, generated_at: new Date().toISOString(), patterns: [pattern] } });
  const m = mount({ fetchImpl: a.f, ls: CFG, settings: { mode: 'standard' } }); await open(m);
  [...m.document.querySelectorAll('.nw-mode')].find(b => text(b) === 'Patterns').click(); await until(() => m.document.querySelector('.nw-pattern-card'));
  assert.match(text(m.document.querySelector('.nw-pattern-card')), /sarkari daava/);
  const p = m.News.patternChatPrompt(m.News.normPattern(pattern));
  assert.match(p, /tass\.com \[SARKARI DAAVA · UNVERIFIED \/ single source\]/);
  assert.match(p, /Article URL: https:\/\/tass\.com\/a/);
  assert.match(p, /Article URL: https:\/\/example\.com\/us/);
  assert.match(p, /title, publisher, region, or verification badge alone is not evidence/);
  assert.doesNotMatch(p, /Reuters \[/);  // confirmed independent item carries no warning
  assert.match(p, /X ka daava/); assert.match(p, /actor.*mat jodo|mat jodo/); assert.match(p, /seedha link nahi/);
  m.close();
});


test('stale Patterns view keeps polling until the fresh cache arrives', async () => {
  const pattern = { title: 'Compute buildout', pattern: 'US and India are adding data-centre capacity in different ways.', type: 'compute/datacentre buildout', signal: 'medium', generated_at: '2026-11-27T10:00:00.000Z', regions: [{ region: 'US', what: 'Orbital data-centre plan', item_ids: ['u1'] }, { region: 'IN', what: 'Data-centre partnership talks', item_ids: ['i1'] }], items: [{ id: 'u1', title: 'US orbital data-centre plan', url: 'https://example.com/us', source: 'AP', region: 'US' }, { id: 'i1', title: 'India data-centre partnership', url: 'https://example.com/in', source: 'ET', region: 'IN' }] };
  let calls = 0;
  const a = api({ list: L([]), patterns: () => ++calls === 1
    ? { ok: true, generated_at: '2026-11-27T10:00:00.000Z', cached: true, reason: 'refreshing', patterns: [] }
    : { ok: true, generated_at: '2026-11-27T10:20:00.000Z', cached: false, reason: 'fresh-cache', patterns: [pattern] } });
  const m = mount({ fetchImpl: a.f, ls: CFG }); await open(m);
  const original = m.window.setTimeout.bind(m.window);
  m.window.setTimeout = (fn, ms, ...rest) => original(fn, ms >= 15000 ? 5 : ms, ...rest);
  [...m.document.querySelectorAll('.nw-mode')].find(b => text(b) === 'Patterns').click();
  await until(() => m.document.querySelector('.nw-pattern-card'));
  assert.ok(calls >= 2, 'a second cache read picks up the pattern that completed after the first 20 s poll');
  assert.match(text(m.document.querySelector('#v-news')), /Compute buildout/);
  m.close();
});
