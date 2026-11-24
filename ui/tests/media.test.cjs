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
const APP_CSS = fs.readFileSync(path.join(UI, 'src/css/app.css'), 'utf8');
const ORDER = [...INDEX.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)].map(m => m[1]);
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();

test('generated media fits mobile cards without cropping or excessive zoom', () => {
  assert.match(APP_CSS, /\.generated-media>img,\.generated-media>video\{[^}]*width:100%[^}]*object-fit:contain[^}]*\}/);
  assert.match(APP_CSS, /\.generated-media>video\{aspect-ratio:16\/9\}/);
});

test('long chat titles stay within the header track beside action buttons', () => {
  assert.match(APP_CSS, /\.hdr\{[^}]*grid-template-columns:44px minmax\(0,1fr\) auto/);
  assert.match(APP_CSS, /\.hdr h1\{[^}]*width:100%;max-width:100%;[^}]*text-overflow:ellipsis/);
  assert.match(APP_CSS, /\.ttl\{[^}]*min-width:0;width:100%/);
});

function mount({ mediaReply, nativeMethods = {} } = {}) {
  const dom = new JSDOM(INDEX, { url: 'https://appassets.androidplatform.net/assets/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const mediaRequests = [];
  w.matchMedia = () => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
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
  let app;
  const overrides = { ...nativeMethods };
  const speechStartHook = overrides.speechStart;
  delete overrides.speechStart;
  w.AdarshNative = {
    status: () => JSON.stringify({ ready: true, providers: { groq: true } }),
    keyStatus: () => JSON.stringify({ NVIDIA_API_KEY: { set: true, hint: '…test' } }),
    recordsList: () => JSON.stringify({ ok: true, records: [] }),
    recordsImport: () => JSON.stringify({ ok: true }),
    recordsDelete: () => JSON.stringify({ ok: true }),
    runActions: () => JSON.stringify({ results: [] }),
    actionInfo: () => JSON.stringify({ notify: true, exact: true, dnd: true, enabled: true }),
    bnrSupported: () => true,
    speechStart: (lang, useBnr, functionId) => {
      if (speechStartHook) speechStartHook(lang, useBnr, functionId);
      w.setTimeout(() => w.__adarshSpeech && w.__adarshSpeech('started', ''), 0);
    },
    speechStop: () => { if (nativeMethods.speechStop) nativeMethods.speechStop(); },
    send: (id, json) => {
      const request = JSON.parse(json);
      mediaRequests.push(request);
      const reply = mediaReply ? mediaReply(request) : { type: 'text', text: 'unused test reply' };
      w.setTimeout(() => w.__adarshResult(id, JSON.stringify(reply), null), 0);
    },
    ...overrides
  };
  const ctx = dom.getInternalVMContext();
  for (const file of ORDER) {
    const source = fs.readFileSync(path.join(UI, 'src', file.replace(/^js\//, 'js/')), 'utf8');
    new vm.Script(source, { filename: path.join(UI, 'src', file) }).runInContext(ctx);
  }
  new vm.Script('globalThis.TEST = { S, App, Chat, STT, Voice, BackgroundVoice, Backend };').runInContext(ctx);
  app = { dom, window: w, document: w.document, requests: mediaRequests, ...w.TEST, close: async () => { try { w.STT.stop(); } catch {} try { w.Voice.close(); } catch {} dom.window.close(); await settle(); } };
  return app;
}

function button(root, label) {
  const result = [...root.querySelectorAll('button')].find(b => text(b) === label || b.getAttribute('aria-label') === label || [...b.querySelectorAll('b')].some(x => text(x) === label));
  assert.ok(result, `button ${JSON.stringify(label)} should exist`);
  return result;
}

async function click(root, label) { button(root, label).click(); await settle(0); }


test('image and video actions use dedicated NVIDIA media requests and save only opaque IDs in chat', async t => {
  const imageId = 'a'.repeat(32);
  const videoId = 'b'.repeat(32);
  const app = mount({ mediaReply: req => !req.media ? { type: 'text', text: 'Ordinary chat reply' } : req.media.kind === 'image'
    ? { type: 'image', mediaId: imageId, mime: 'image/jpeg', prompt: req.media.prompt }
    : { type: 'video', mediaId: videoId, mime: 'video/mp4', prompt: req.media.prompt, frames: req.media.frames, fps: 24 } });
  t.after(() => app.close());

  await click(app.document, 'Add');
  await click(app.document, 'Generate image');
  let prompt = app.document.querySelector('[aria-label="Generation prompt"]');
  assert.ok(prompt);
  assert.equal(app.document.activeElement, prompt);
  assert.ok(app.document.querySelector('.shade')?.textContent.includes('private info'));
  prompt.value = 'A blue mountain at sunrise';
  await click(app.document, 'Generate image');
  await settle(20);

  assert.equal(app.requests[0].media.kind, 'image');
  assert.equal(app.requests[0].media.prompt, 'A blue mountain at sunrise');
  assert.equal(app.document.querySelector('.generated-media img')?.getAttribute('src'), `/media/${imageId}.jpg`);

  await click(app.document, 'Add');
  await click(app.document, 'Generate video');
  prompt = app.document.querySelector('[aria-label="Generation prompt"]');
  prompt.value = 'A small robot waves';
  const duration = app.document.querySelector('[aria-label="Video duration"]');
  assert.ok(duration, [...app.document.querySelectorAll('[aria-label]')].map(el => el.getAttribute('aria-label')).join(' | '));
  duration.value = '73';
  await click(app.document, 'Generate video');
  await settle(20);

  assert.equal(app.requests[1].media.kind, 'video');
  assert.equal(app.requests[1].media.frames, 73);
  const video = app.document.querySelector('.generated-media video');
  assert.equal(video?.getAttribute('src'), `/media/${videoId}.mp4`);
  assert.ok(video?.hasAttribute('controls'));
  await settle(320);
  const saved = app.window.localStorage.getItem('adarsh.ui.v3');
  assert.ok(saved, 'chat state should be persisted to localStorage');
  assert.equal(saved.includes('base64'), false);
  assert.equal(saved.includes(imageId), true);
  assert.equal(saved.includes(videoId), true);

  await app.Chat.submit('Tell me the next step');
  const chatRequest = app.requests[2];
  assert.ok(Array.isArray(chatRequest.history));
  assert.ok(chatRequest.history.every(turn => !/A blue mountain|A small robot|Generate image:|Generate video:/.test(turn.text || '')));
});


test('BNR preference is off by default and opt-in/function ID are passed only to foreground dictation', async t => {
  const calls = [];
  const app = mount({ nativeMethods: {
    speechStart: (lang, useBnr, functionId) => calls.push({ lang, useBnr, functionId })
  } });
  t.after(() => app.close());
  assert.equal(app.S.settings.bnr, false);

  app.App.show('settings');
  await settle(0);
  const voiceLink = [...app.document.querySelectorAll('button')].find(b => text(b).includes('Voice & language'));
  assert.ok(voiceLink, 'Voice & language settings link should exist');
  voiceLink.click();
  await settle(0);
  const toggle = [...app.document.querySelectorAll('[role="switch"]')].find(b => text(b).includes('NVIDIA noise removal for voice typing'));
  assert.ok(toggle);
  assert.match(text(toggle), /online/i);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  toggle.click();
  const id = app.document.querySelector('[aria-label="NVIDIA BNR Function ID"]');
  id.value = 'd3f104cf-1234-5678-9abc-000000000000';
  id.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(app.S.settings.bnr, true);
  assert.equal(app.S.settings.bnrFunctionId, id.value);

  app.App.show('chat');
  button(app.document, 'Dictate').click();
  await settle(20);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lang, 'hi-IN');
  assert.equal(calls[0].useBnr, true);
  assert.equal(calls[0].functionId, id.value);
});


test('Stop cancels the engine request and no model-call row stays "chal raha"', async t => {
  const sent = [], cancelled = [];
  const app = mount({ nativeMethods: {
    send: (id, json) => { sent.push({ id, req: JSON.parse(json) }); },  // the engine never answers on its own
    cancel: id => cancelled.push(id)
  } });
  t.after(() => app.close());
  app.S.settings.calls = 1;
  const call = ev => '\u0001call ' + JSON.stringify(ev);

  const done = app.Chat.submit('Why is the sky blue?');
  await settle(10);
  assert.equal(sent.length, 1);
  const id = sent[0].id;
  const progress = app.window.__adarshProgress;
  progress(id, call({ t: 'try', stage: 'judge', model: 'nemotron-ultra', provider: 'openrouter' }));
  progress(id, call({ t: 'fail', stage: 'judge', model: 'nemotron-ultra', why: 'network error: ReadError' }));
  progress(id, call({ t: 'try', stage: 'judge', model: 'nemotron-ultra#3', provider: 'openrouter' }));
  const panel = () => text(app.document.querySelector('.mcalls'));
  assert.match(panel(), /1 chal rahe/);
  assert.match(panel(), /chal raha…/);

  await click(app.document, 'Stop');
  await done;
  await settle(10);
  assert.deepEqual(cancelled, [id], 'Stop must tell the native engine to cancel this request');
  assert.doesNotMatch(panel(), /chal rahe|chal raha…/);
  assert.match(panel(), /1 roke/);
  assert.match(panel(), /rok diya/);
  assert.match(panel(), /1 fail/);
  assert.equal(app.Chat.isBusy(), false);
  assert.ok(button(app.document, 'Send'));

  // Late engine output after Stop is ignored: no new rows, no reply in the chat.
  progress(id, call({ t: 'try', stage: 'judge', model: 'late-model', provider: 'nvidia' }));
  app.window.__adarshResult(id, JSON.stringify({ type: 'text', text: 'late answer' }), null);
  await settle(10);
  assert.doesNotMatch(panel(), /late-model|chal raha/);
  assert.equal(text(app.document.querySelector('.thread')).includes('late answer'), false);
});

test('a request that ends without a final call list does not leave rows running', async t => {
  let reply;
  const app = mount({ nativeMethods: { send: (id, json) => { reply = id; } } });
  t.after(() => app.close());
  app.S.settings.calls = 1;
  const done = app.Chat.submit('Explain entropy');
  await settle(10);
  app.window.__adarshProgress(reply, '\u0001call ' + JSON.stringify({ t: 'try', stage: 'stripper', model: 'nemotron-lightning', provider: 'openrouter' }));
  app.window.__adarshResult(reply, JSON.stringify({ type: 'text', text: 'Timeout: partial answer' }), null);
  await done;
  await settle(10);
  const panel = text(app.document.querySelector('.mcalls'));
  assert.doesNotMatch(panel, /chal rahe|chal raha…/);
  assert.match(panel, /ruk gaya/);
});
