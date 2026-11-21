'use strict';
/* 03-chat.js : chat screen, composer, send pipeline, side-effects of structured replies */

const Chat = (() => {
  let thread, col, ta, sendBtn, voiceBtn, micBtn, atts, titleEl, statusEl;
  let busy = false, ctl = null, pending = [], thinkEl = null;
  const thumbs = new Map(); // attachment id -> object URL (session only)

  const cur = () => S.chats.find(c => c.id === S.cur);
  function newChat() {
    const c0 = cur(); if (c0 && !c0.msgs.length) return c0;
    const c = { id: uid('c'), title: 'New chat', ts: Date.now(), msgs: [] };
    S.chats.unshift(c); S.cur = c.id; save(); return c;
  }
  function open(id) { S.cur = id; save(); App.show('chat'); renderThread(); }
  function remove(id) {
    const i = S.chats.findIndex(c => c.id === id); if (i < 0) return;
    const [gone] = S.chats.splice(i, 1);
    if (S.cur === id) S.cur = S.chats[0] ? S.chats[0].id : null;
    save(); renderThread(); Bus.emit('chats:changed');
    toast('Chat deleted', { action: () => { S.chats.splice(i, 0, gone); save(); Bus.emit('chats:changed'); renderThread(); } });
  }

  /* ---------- build ---------- */
  function mount(root) {
    titleEl = h('h1', { class: 'wm' }, 'ADARSH');
    statusEl = h('span', { class: 'status' }, h('i'), h('span', {}, ''));
    thread = h('div', { class: 'scroll thread pad' }, col = h('div', { class: 'col' }));
    ta = h('textarea', { rows: 1, placeholder: 'Message Adarsh', 'aria-label': 'Message', on: { input: onInput, keydown: onKey, paste: onPaste } });
    atts = h('div', { class: 'atts' });
    micBtn = h('button', { class: 'circ mic', 'aria-label': 'Dictate', on: { click: dictate } }, icon('mic'));
    sendBtn = h('button', { class: 'circ send', 'aria-label': 'Send', hidden: true, on: { click: () => (busy ? stop() : submit()) } }, icon('send'));
    voiceBtn = h('button', { class: 'circ voicebtn', 'aria-label': 'Voice mode', on: { click: () => Voice.open() } }, icon('voice'));
    const plus = h('button', { class: 'circ plus', 'aria-label': 'Add', on: { click: addSheet } }, icon('plus'));
    root.append(
      h('header', { class: 'hdr pad' }, ibtn('menu', 'Open menu', () => App.drawer(true)), h('div', { style: 'text-align:center;min-width:0' }, titleEl, h('div', {}, statusEl)),
        ibtn('plus', 'New chat', () => { newChat(); renderThread(); ta.focus(); })),
      thread,
      h('div', { class: 'dock pad' }, h('div', { class: 'box' }, atts, ta, h('div', { class: 'row' }, plus, h('span', { class: 'sp' }), micBtn, sendBtn, voiceBtn)),
        h('p', { class: 'fine' }, 'Adarsh can make mistakes. Check important info.')));
    Bus.on('ask:answer', onAsk); Bus.on('approve:decide', onApprove);
    Bus.on('memory:undo', ({ msg }) => { const r = msg.reply; S.memories = S.memories.filter(m => m.id !== r.memId); r.gone = true; save(); });
    Bus.on('task:undo', ({ msg }) => { const r = msg.reply; S.tasks = S.tasks.filter(t => t.id !== r.taskId); r.gone = true; save(); });
    Bus.on('mission:action', onMission);
    Bus.on('backend:status', setStatus);
    renderThread();
  }
  function setStatus(s) {
    statusEl.className = 'status' + (s.demo ? ' demo' : ''); statusEl.lastChild.textContent = s.label;
    statusEl.firstChild.style.background = s.ok === false ? 'var(--bad)' : '';
  }

  /* ---------- thread ---------- */
  function renderThread() {
    const c = cur(); col.textContent = '';
    if (!c || !c.msgs.length) {
      col.className = 'col empty';
      col.append(h('div', { class: 'hello' }, h('div', { class: 'mark' }, 'A'), h('h2', {}, greeting() + ', ' + (S.settings.name || 'Adarsh')),
        h('p', {}, 'What are we working on?'),
        h('div', { class: 'chips', style: 'justify-content:center;margin-top:8px' },
          ['Brief me on today', 'Research something', 'Add a task'].map(t => h('button', { class: 'chipbtn', on: { click: () => { ta.value = t === 'Research something' ? 'Research ' : t === 'Add a task' ? 'Remind me to ' : t; onInput(); if (t === 'Brief me on today') submit(); else ta.focus(); } } }, t)))));
    } else {
      col.className = 'col';
      c.msgs.forEach((m, i) => col.append(msgEl(m, i === c.msgs.length - 1)));
    }
    if (busy) col.append(thinkEl);
    scroll();
  }
  const scroll = () => requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });

  function msgEl(m, isLast) {
    if (m.role === 'user') {
      if (m.answer) return h('div', { class: 'msg user' }, h('div', { class: 'ans' }, h('span', { class: 'k' }, 'Your answer'), m.answer.map(a => h('div', {}, h('b', {}, (a.header || 'Q') + ': '), a.answer || 'Skipped'))));
      if (m.decision) return h('div', { class: 'msg user' }, h('div', { class: 'decision ' + m.decision }, icon(m.decision === 'allow' ? 'check' : 'x', 's'), (m.decision === 'allow' ? 'Allowed: ' : 'Denied: ') + (m.title || '')));
      const b = h('div', { class: 'bubble' });
      if (m.atts && m.atts.length) {
        const imgs = m.atts.filter(a => a.kind === 'image' && thumbs.get(a.id)); const rest = m.atts.filter(a => !imgs.includes(a));
        if (imgs.length) b.append(h('div', { class: 'thumbs' }, imgs.map(a => h('img', { src: thumbs.get(a.id), alt: a.name }))));
        rest.forEach(a => b.append(h('div', { class: 'fchip' }, icon('file', 's'), a.name), ' '));
        if (m.text) b.append(h('div', { style: 'margin-top:6px' }, m.text));
      } else b.textContent = m.text;
      return h('div', { class: 'msg user' }, b);
    }
    const wrap = h('div', { class: 'msg', 'data-id': m.id });
    const ctx = { msg: m, redraw: () => { wrap.replaceWith(msgEl(m, isLast)); } };
    const r = m.reply;
    if (r.steps && r.steps.length) wrap.append(h('details', { class: 'steps' }, h('summary', {}, icon('chev', 'chev'), 'Worked through ' + r.steps.length + ' steps'), r.steps.map(s => h('div', { class: 'st-row' }, s))));
    wrap.append(renderReply(r, ctx));
    if (r.type !== 'ask' && r.type !== 'approve' && r.type !== 'memory' && r.type !== 'task') wrap.append(actionsEl(m, isLast));
    return wrap;
  }
  function actionsEl(m, isLast) {
    const txt = () => stripMd(speechOf(m.reply)) || '';
    const a = h('div', { class: 'actions' });
    a.append(h('button', { 'aria-label': 'Copy', on: { click: async () => { try { await navigator.clipboard.writeText(m.reply.text || speechOf(m.reply)); toast('Copied'); } catch (e) { toast('Copy not available here'); } } } }, icon('copy', 's')));
    if (TTS.ok()) a.append(h('button', { 'aria-label': 'Read aloud', on: { click: () => TTS.speak(txt()) } }, icon('speaker', 's')));
    ['up', 'dn'].forEach(k => a.append(h('button', { 'aria-label': k === 'up' ? 'Good answer' : 'Bad answer', 'aria-pressed': String(m.fb === k), on: { click: (e) => { m.fb = m.fb === k ? null : k; save(); e.currentTarget.parentNode.replaceWith(actionsEl(m, isLast)); Bus.emit('feedback', { id: m.id, fb: m.fb }); } } }, icon(k === 'up' ? 'thumbup' : 'thumbdn', 's'))));
    if (isLast) a.append(h('button', { 'aria-label': 'Retry', on: { click: retry } }, icon('refresh', 's'), 'Retry'));
    return a;
  }

  /* ---------- composer ---------- */
  function onInput() {
    ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
    const has = ta.value.trim() || pending.length;
    sendBtn.hidden = !(has || busy); voiceBtn.hidden = !!(has || busy); micBtn.hidden = !!(has && !busy);
  }
  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); if (!busy) submit(); }
  }
  function onPaste(e) {
    const fs = [...(e.clipboardData ? e.clipboardData.files : [])]; if (fs.length) { e.preventDefault(); fs.forEach(addFile); }
  }
  function addSheet() {
    sheet({ title: 'Add', build(b, close) {
      const row = (ic, t, s, fn) => h('button', { class: 'opt-row', on: { click: () => { close(); fn(); } } }, icon(ic), h('span', { class: 't' }, h('b', {}, t), h('small', {}, s)));
      b.append(row('image', 'Photo', 'From gallery or camera', () => $('#f-img').click()), row('file', 'File', 'Documents, text, PDFs', () => $('#f-any').click()));
    } });
  }
  function addFile(f) {
    if (f.size > 8 * 1024 * 1024) return toast(f.name + ' is over 8 MB');
    const a = { id: uid('a'), name: f.name || 'pasted', kind: f.type.startsWith('image/') ? 'image' : 'file', type: f.type, size: f.size, file: f };
    if (a.kind === 'image') { a.thumb = URL.createObjectURL(f); thumbs.set(a.id, a.thumb); }
    pending.push(a); drawAtts(); onInput();
  }
  function drawAtts() {
    atts.textContent = '';
    pending.forEach(a => atts.append(h('div', { class: 'att' }, a.kind === 'image' ? h('img', { src: a.thumb, alt: '' }) : h('span', { class: 'ic' }, icon('file', 's')), h('span', {}, a.name),
      h('button', { 'aria-label': 'Remove ' + a.name, on: { click: () => { pending = pending.filter(x => x !== a); drawAtts(); onInput(); } } }, icon('x', 's')))));
  }
  const readAtt = (a) => new Promise(res => { const r = new FileReader(); r.onload = () => res({ id: a.id, name: a.name, kind: a.kind, type: a.type, size: a.size, dataUrl: r.result }); r.onerror = () => res({ id: a.id, name: a.name, kind: a.kind, type: a.type, size: a.size }); r.readAsDataURL(a.file); });

  let dictating = false;
  function dictate() {
    if (dictating) { STT.stop(); return; }
    let base = ta.value;
    const ok = STT.start({
      onPartial: (t) => { ta.value = (base + ' ' + t).replace(/ {2,}/g, ' ').trimStart(); onInput(); },
      onFinal: (t) => { base = (base + ' ' + t).replace(/ {2,}/g, ' ').trimStart(); ta.value = base; onInput(); },
      onEnd: () => { dictating = false; micBtn.classList.remove('live'); },
      onError: (msg) => toast(msg)
    });
    if (ok) { dictating = true; micBtn.classList.add('live'); } else toast('Voice typing isn’t supported in this browser. Use Voice mode’s typed input or your keyboard mic.');
  }

  /* ---------- send pipeline ---------- */
  function stop() { if (ctl) ctl.abort(); }
  function histText() {
    return (cur() ? cur().msgs : []).slice(-14).map(m => m.role === 'user' ? { role: 'user', text: m.text || (m.answer ? m.answer.map(a => a.answer).join('; ') : (m.decision || '')) } : { role: 'assistant', text: speechOf(m.reply) });
  }
  async function submit(textOverride, meta) {
    const text = (textOverride != null ? textOverride : ta.value).trim(); const files = textOverride != null ? [] : pending;
    if ((!text && !files.length) || busy) return;
    if (!meta && App.view !== 'chat') App.show('chat');
    const c = newChat();
    const um = { id: uid('m'), role: 'user', text, ts: Date.now(), atts: files.map(a => ({ id: a.id, name: a.name, kind: a.kind })) };
    pushUser(c, um);
    if (textOverride == null) { ta.value = ''; pending = []; drawAtts(); onInput(); }
    const attachments = await Promise.all(files.map(readAtt));
    await runBackend(c, { text, attachments, meta });
  }
  function pushUser(c, um) {
    if (!c.msgs.length && um.text) c.title = um.text.slice(0, 42);
    c.msgs.push(um); c.ts = Date.now(); save(); Bus.emit('chats:changed'); renderThread();
  }
  async function runBackend(c, { text, attachments = [], meta }) {
    busy = true; ctl = new AbortController(); const steps = [];
    const label = h('span', {}, 'Thinking'); thinkEl = h('div', { class: 'think', role: 'status' }, h('span', { class: 'dots' }, h('i'), h('i'), h('i')), label);
    sendBtn.replaceChildren(icon('stop')); sendBtn.setAttribute('aria-label', 'Stop'); onInput(); renderThread();
    Bus.emit('busy', true);
    try {
      const res = await Backend.send({ chatId: c.id, text, attachments, history: histText().slice(0, -1), meta },
        { signal: ctl.signal, onProgress: (s) => { steps.push(s); label.textContent = s; } });
      const arr = (Array.isArray(res) ? res : [res]).filter(Boolean).map(normReply);
      arr.forEach((r, i) => { if (i === 0 && steps.length) r.steps = steps.slice(); deliver(c, r); });
    } catch (e) {
      if (ctl.signal.aborted) toast('Stopped');
      else { console.error(e); deliver(c, { type: 'text', text: '⚠️ ' + (e && e.message ? e.message : 'Something went wrong talking to the backend.') }); }
    } finally {
      busy = false; ctl = null; thinkEl = null; sendBtn.replaceChildren(icon('send')); sendBtn.setAttribute('aria-label', 'Send'); onInput(); renderThread(); save();
      Bus.emit('busy', false);
    }
  }
  const normReply = (r) => (typeof r === 'string' ? { type: 'text', text: r } : r && r.type ? r : { type: 'text', text: String((r && r.text) || '') });
  function deliver(c, r) {
    if (r.type === 'memory') { const m = { id: uid('mem'), text: r.text, pin: false, ts: Date.now() }; S.memories.unshift(m); r.memId = m.id; }
    if (r.type === 'task') { const t = { id: uid('t'), title: r.title, due: r.due || null, done: false, ts: Date.now() }; S.tasks.push(t); r.taskId = t.id; }
    if (r.type === 'mission') upsertMission(r);
    const m = { id: uid('m'), role: 'ai', ts: Date.now(), reply: r };
    c.msgs.push(m); c.ts = Date.now();
    Bus.emit('reply', { chat: c, msg: m });
    if (document.hidden && S.settings.notif && window.Notification && Notification.permission === 'granted') { try { new Notification('Adarsh', { body: speechOf(r).slice(0, 120) }); } catch (e) {} }
  }
  function upsertMission(r) {
    const i = S.missions.findIndex(m => m.id === r.id);
    const rec = { id: r.id || uid('ms'), title: r.title, status: r.status || 'running', stages: r.stages || [], ts: Date.now() };
    r.id = rec.id; if (i >= 0) S.missions[i] = rec; else S.missions.unshift(rec);
  }
  function retry() {
    const c = cur(); if (!c || busy) return;
    while (c.msgs.length && c.msgs[c.msgs.length - 1].role === 'ai') c.msgs.pop();
    const lastU = c.msgs[c.msgs.length - 1]; if (!lastU || lastU.role !== 'user') return renderThread();
    renderThread(); runBackend(c, { text: lastU.text || '' });
  }

  /* structured-reply follow-ups */
  function onAsk({ askId, answers, skipped }) {
    const c = cur(); if (!c) return;
    pushUser(c, { id: uid('m'), role: 'user', answer: answers, ts: Date.now() });
    runBackend(c, { text: skipped ? '(skipped the question)' : answers.map(a => a.header + ': ' + a.answer).join('\n'), meta: { answer: { askId, answers, skipped } } });
  }
  function onApprove({ id, decision, title }) {
    const c = cur(); if (!c) return;
    pushUser(c, { id: uid('m'), role: 'user', decision, title, ts: Date.now() });
    runBackend(c, { text: (decision === 'allow' ? 'Allowed: ' : 'Denied: ') + title, meta: { approval: { id, decision } } });
  }
  async function onMission({ id, action }) {
    try {
      const r = Backend.missionAction ? await Backend.missionAction(id, action) : null;
      const rec = S.missions.find(m => m.id === id); if (!rec) return;
      if (r && r.status) { rec.status = r.status; if (r.stages) rec.stages = r.stages; } else rec.status = action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : 'running';
      S.chats.forEach(ch => ch.msgs.forEach(m => { if (m.reply && m.reply.type === 'mission' && m.reply.id === id) { m.reply.status = rec.status; m.reply.stages = rec.stages; } }));
      save(); renderThread(); Bus.emit('missions:changed');
    } catch (e) { toast('Mission update failed'); }
  }

  return {
    mount, renderThread, newChat, open, remove, cur, submit,
    setDraft(t) { ta.value = t; onInput(); ta.focus(); }, addFile, isBusy: () => busy,
    push(r, { chatId } = {}) { const c = (chatId && S.chats.find(x => x.id === chatId)) || newChat(); deliver(c, normReply(r)); save(); Bus.emit('chats:changed'); renderThread(); }
  };
})();
