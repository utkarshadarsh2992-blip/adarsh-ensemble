'use strict';
/* Answer UI: delegated copy affordances and structured markdown behavior. */
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
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();

function mount() {
  const dom = new JSDOM(INDEX, { url: 'https://appassets.androidplatform.net/assets/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let copied = null;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.requestAnimationFrame = cb => { cb(Date.now()); return 1; };
  if (!w.crypto?.subtle) Object.defineProperty(w, 'crypto', { configurable: true, value: webcrypto });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.navigator.vibrate = () => true;
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
  w.fetch = async () => { throw new Error('network disabled in test'); };
  w.console = console;
  w.ADARSH_BACKEND = { async send() { return { type: 'text', text: 'ok' }; }, async ping() { return { ok: true }; } };
  const ctx = dom.getInternalVMContext();
  for (const file of ORDER) new vm.Script(fs.readFileSync(path.join(UI, 'src', file), 'utf8'), { filename: file }).runInContext(ctx);
  new vm.Script('globalThis.TEST = { S, Chat, md, plainText, sectionText };').runInContext(ctx);
  return { dom, window: w, document: w.document, get copied() { return copied; }, ...w.TEST, close: () => dom.window.close() };
}

function addToThread(app, node) {
  app.document.querySelector('#v-chat .col').append(node);
  return node;
}

test('tapping a user bubble shows one pill and copies the exact question', async t => {
  const app = mount(); t.after(() => app.close());
  const question = '  Sir, exact line\nwith spacing?  ';
  app.S.chats = [{ id: 'c1', title: 'Question', ts: 1, msgs: [{ id: 'u1', role: 'user', text: question, ts: 1 }] }];
  app.S.cur = 'c1'; app.Chat.renderThread();
  const bubble = app.document.querySelector('.bubble');
  assert.equal(bubble.getAttribute('role'), 'button');
  assert.equal(bubble.getAttribute('aria-label'), 'Copy question');
  bubble.click();
  const pill = app.document.querySelector('.copy-popover');
  assert.ok(pill && !pill.hidden, 'copy pill is visible');
  bubble.click();
  assert.ok(app.document.querySelector('.copy-popover').hidden, 'second tap hides the pill');
  bubble.click();
  pill.click(); await wait();
  assert.equal(app.copied, question);
  assert.match(text(app.document.querySelector('.toast')), /^Copied$/);
});

test('section extraction keeps heading, bullets, tab-separated tables, and code', t => {
  const app = mount(); t.after(() => app.close());
  const root = app.md('## Plan\n\nIntro line.\n\n- First\n- Second\n\n| Name | Value |\n| --- | --- |\n| A | 1 |\n\n```js\nconst x = 1;\n```\n\n## Next\n\nDo not include this.');
  const heading = root.querySelector('.answer-heading');
  assert.equal(app.sectionText(heading), 'Plan\nIntro line.\n- First\n- Second\nName\tValue\nA\t1\nconst x = 1;');
  assert.equal(app.plainText(root.querySelector('.copy-list ul')), '- First\n- Second');
  assert.equal(app.plainText(root.querySelector('.mdtable')), 'Name\tValue\nA\t1');
});

test('Sources blocks collapse into a counted card with clickable links', t => {
  const app = mount(); t.after(() => app.close());
  const root = app.md('Answer.\n\n**Sources**\n- [One](https://one.example/a)\n- [Two](https://two.example/b)');
  const card = root.querySelector('.source-fold');
  assert.ok(card);
  assert.equal(card.open, false);
  assert.match(text(card.querySelector('summary')), /Sources \(2\)/);
  assert.deepEqual([...card.querySelectorAll('a')].map(a => a.href), ['https://one.example/a', 'https://two.example/b']);
  const plain = app.md('Answer.\n\nSources:\n[S1] [One](https://one.example/a)\n[S2] Two https://two.example/b');
  assert.match(text(plain.querySelector('.source-fold summary')), /Sources \(2\)/);
  const mixed = app.md('Answer.\n\nSources:\n[S1] Provider: One — https://one.example/a\n[S2] Provider: Two — https://two.example/b\n\n**Sources**\n- [One again](https://one.example/a)\n- [Unsafe](javascript:alert(1))');
  const mixedCard = mixed.querySelector('.source-fold');
  assert.match(text(mixedCard.querySelector('summary')), /Sources \(3\)/);
  assert.deepEqual([...mixedCard.querySelectorAll('a')].map(a => a.getAttribute('href')), ['https://one.example/a', 'https://two.example/b']);
  assert.equal(mixedCard.querySelectorAll('a[href^="javascript:"]').length, 0);
  assert.match(text(mixedCard), /javascript:alert\(1\)/);
  assert.equal([...mixed.querySelectorAll('p')].some(p => /Provider: One/.test(text(p))), false);
});

test('normal paragraph taps do nothing, while code copy uses copyText', async t => {
  const app = mount(); t.after(() => app.close());
  const paragraph = addToThread(app, app.md('A normal paragraph must not open a copy pill.').querySelector('p').parentElement);
  paragraph.querySelector('p').click();
  assert.equal(app.document.querySelector('.copy-popover'), null);
  const code = addToThread(app, app.md('```python\nprint("safe")\n```'));
  code.querySelector('.cb-copy').click(); await wait();
  assert.equal(app.copied, 'print("safe")');
  assert.equal(text(code.querySelector('.cb-copy')), 'Copied');
});
