'use strict';
/* 03-chat.js : chat screen, composer, send pipeline, side-effects of structured replies */

const Chat = (() => {
  let thread, col, ta, sendBtn, voiceBtn, micBtn, atts, titleEl, statusEl, hdrEl, modeBtn, jump, callsBtn, callsEl;
  let callRows = [];   // this answer's model calls: {stage, model, state: run|ok|fail|dead|stop, why, secs, asked}
  let busy = false, ctl = null, pending = [], thinkEl = null;
  const thumbs = new Map(); // attachment id -> object URL (session only)
  const MAX_REPLY_BYTES = 256 * 1024;
  const replyBytes = (v) => { try { return new TextEncoder().encode(JSON.stringify(v)).length; } catch (e) { return Infinity; } };
  function capReply(reply) {
    // A generated PDF is bytes, not text: it is kept out of the size caps below (a truncated base64 is a broken file).
    const pdfKeep = reply && typeof reply === 'object' && reply.pdf ? reply.pdf : null;
    if (pdfKeep) { reply = Object.assign({}, reply); delete reply.pdf; }
    let omitted = false;
    const copy = (v) => {
      if (typeof v === 'string') return v.length > 12000 ? (omitted = true, v.slice(0, 12000) + '…') : v;
      if (Array.isArray(v)) return v.length > 100 ? (omitted = true, v.slice(0, 100).map(copy)) : v.map(copy);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
      return v;
    };
    let out = copy(reply);
    const detailKeys = ['council', 'calls', 'steps', 'thinkLines', 'notes', 'prompt', 'output', 'draft', 'questions', 'patterns', 'stages'];
    for (const k of detailKeys) if (replyBytes(out) > MAX_REPLY_BYTES && out && Object.prototype.hasOwnProperty.call(out, k)) { delete out[k]; omitted = true; }
    const shrink = (v) => {
      if (typeof v === 'string') return v.length > 512 ? (omitted = true, v.slice(0, Math.max(256, Math.floor(v.length / 2))) + '…') : v;
      if (Array.isArray(v)) return v.length > 8 ? (omitted = true, v.slice(0, Math.max(1, Math.floor(v.length / 2))).map(shrink)) : v.map(shrink);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
      return v;
    };
    for (let i = 0; replyBytes(out) > MAX_REPLY_BYTES && i < 8; i++) out = shrink(out);
    if (replyBytes(out) > MAX_REPLY_BYTES) { out = { type: 'text', text: 'Jawab bahut bada tha, details hata di.' }; omitted = true; }
    if (omitted && out && typeof out === 'object') out._detailsOmitted = true;
    if (pdfKeep && out && typeof out === 'object') out.pdf = pdfKeep;
    return out;
  }

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
    statusEl = h('span', { class: 'status', role: 'button', title: 'Engine dobara check karne ko tap karo', on: { click: () => Backend.refresh() } }, h('i'), h('span', {}, ''));
    callsBtn = ibtn('search2', 'Model calls dikhao', toggleCalls, 'calls');
    hdrEl = h('header', { class: 'hdr pad' }, ibtn('menu', 'Open menu', () => App.drawer(true)), h('div', { class: 'ttl' }, titleEl, statusEl),
      h('div', { class: 'hdr-r' }, callsBtn, ibtn('edit', 'New chat', () => { newChat(); renderThread(); ta.focus(); })));
    thread = h('div', { class: 'scroll thread pad', on: { scroll: onScroll } }, col = h('div', { class: 'col' }));
    /* the moment the user takes the scroll, stop following: no fight between the finger and the ease */
    ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(t => thread.addEventListener(t, () => Motion.release(thread), { passive: true }));
    ta = h('textarea', { rows: 1, placeholder: Modes.current().placeholder, 'aria-label': 'Message', on: { input: onInput, keydown: onKey, paste: onPaste } });
    atts = h('div', { class: 'atts' });
    drawAtts();
    micBtn = h('button', { class: 'circ mic', 'aria-label': 'Dictate', on: { click: dictate } }, icon('mic'));
    sendBtn = h('button', { class: 'circ send', 'aria-label': 'Send', hidden: true, on: { click: () => (busy ? stop() : submit()) } }, icon('send'));
    voiceBtn = h('button', { class: 'circ voicebtn', 'aria-label': 'Voice mode', on: { click: () => Voice.open() } }, icon('voice'));
    const plus = h('button', { class: 'circ plus', 'aria-label': 'Add', on: { click: addSheet } }, icon('plus'));
    modeBtn = h('button', { class: 'modebtn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', on: { click: () => Modes.open(modeBtn) } });
    drawMode();
    jump = h('button', { class: 'jump', 'aria-label': 'Scroll to latest', on: { click: () => thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' }) } }, icon('arrowdown', 's'));
    callsEl = h('div', { class: 'mcalls', hidden: true });
    root.append(hdrEl, thread,
      h('div', { class: 'dock pad' }, jump, callsEl,
        h('div', { class: 'box' }, atts, ta, h('div', { class: 'row' }, plus, h('span', { class: 'sp' }), modeBtn, micBtn, sendBtn, voiceBtn))));
    Bus.on('ask:answer', onAsk); Bus.on('approve:decide', onApprove);
    Bus.on('memory:undo', ({ msg }) => { const r = msg.reply; S.memories = S.memories.filter(m => m.id !== r.memId); r.gone = true; save(); });
    Bus.on('task:undo', ({ msg }) => { const r = msg.reply; S.tasks = S.tasks.filter(t => t.id !== r.taskId); r.gone = true; save(); });
    Bus.on('mission:action', onMission);
    Bus.on('backend:status', setStatus);
    Bus.on('calls:changed', () => { drawCalls(); renderThread(); });
    Bus.on('mode:changed', onMode);
    Bus.on('std:changed', drawMode);
    renderThread(); drawCalls();
  }
  function drawMode() {
    const m = Modes.current();
    modeBtn.replaceChildren(icon(m.ic, 's'), h('span', { class: 'mn' }, Modes.label(m)), icon('caret', 's'));
    modeBtn.setAttribute('aria-label', 'Mode: ' + Modes.label(m) + '. Change mode');
    modeBtn.classList.toggle('on', m.id !== 'standard');
    if (ta) ta.placeholder = m.placeholder;
  }
  function onMode() { drawMode(); const c = cur(); if (!c || !c.msgs.length) renderThread(); }
  function onScroll() {
    const away = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    jump.classList.toggle('show', away > 220); hdrEl.classList.toggle('scrolled', thread.scrollTop > 6);
  }
  function useStarter(st) {
    ta.value = st.p; onInput();
    if (st.send) submit(); else { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
  function setStatus(s) {
    statusEl.className = 'status' + (s.demo ? ' demo' : ''); statusEl.lastChild.textContent = s.label;
    statusEl.firstChild.style.background = s.ok === false ? 'var(--bad)' : '';
    statusEl.title = s.hint ? s.hint + ' (tap to check again)' : 'Engine dobara check karne ko tap karo';
    if (s.hint && s.ok === false && s.label !== 'Offline') toast(s.label + ': ' + s.hint);
  }

  /* ---------- thread ---------- */
  function renderThread() {
    const c = cur(); col.textContent = '';
    /* only follow the newest line when the reader is already at the bottom; a page they scrolled up to stays put */
    const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 260;
    const has = !!(c && c.msgs.length);
    titleEl.className = has ? '' : 'wm'; titleEl.textContent = has ? (c.title || 'New chat') : 'ADARSH';
    if (!has) {
      const m = Modes.current();
      col.className = 'col empty';
      col.append(h('div', { class: 'hello' }, h('div', { class: 'mark' }, 'A'), h('h2', {}, greeting() + ', ' + (S.settings.name || 'Adarsh')),
        m.hello ? h('p', {}, m.hello) : h('div', { class: 'modetag' }, icon(m.ic, 's'), m.name + ' mode'),
        m.hello ? null : h('p', {}, m.desc),
        h('div', { class: 'starters' }, m.starters.map(st => h('button', { class: 'starter', on: { click: () => useStarter(st) } }, icon(st.ic || m.ic, 's'), h('span', {}, st.t))))));
    } else {
      col.className = 'col';
      c.msgs.forEach((m, i) => col.append(msgEl(m, i === c.msgs.length - 1)));
    }
    if (busy && thinkEl) col.append(thinkEl);
    if (near) scroll();
  }
  /* eased, not a jump: the thread glides to the newest line and keeps following while it grows */
  const scroll = () => Motion.glide(thread);

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
    const thought = Council.done(r);
    if (thought) wrap.append(thought);
    else if (r.type !== 'actions' && r.steps && r.steps.length) wrap.append(h('details', { class: 'steps' }, h('summary', {}, icon('chev', 'chev'), 'Worked through ' + r.steps.length + ' steps'), r.steps.map(s => h('div', { class: 'st-row' }, s))));
    if (callsOn() && r.calls && r.calls.length) {
      const bad = r.calls.filter(c => !c.ok).length;
      wrap.append(h('details', { class: 'steps mcalls-msg' }, h('summary', {}, icon('search2', 's'), 'Model calls: ' + r.calls.length + (bad ? ' · ' + bad + ' fail' : '')),
        h('div', { class: 'mcl' }, r.calls.map(c => callRowEl({ stage: c.stage, model: c.model, asked: c.asked, state: c.ok ? 'ok' : 'fail', secs: c.secs, fails: c.fails }, false)))));
    }
    wrap.append(renderReply(r, ctx));
    const pdfCard = pdfEl(m); if (pdfCard) wrap.append(pdfCard);
    if (r.notes && r.notes.items && r.notes.items.length) wrap.append(notesEl(r.notes));
    if (r.type === 'text') Learn.extras(m, ctx).forEach(el => wrap.append(el));   /* check questions, new words, Gehrai mein jao */
    if (r.type === 'text' && r.briefing) Briefing.extras(m, ctx).forEach(el => wrap.append(el));   /* KAL KA PLAN card */
    if (r.type === 'text' && r.truth) Usage.extras(m, ctx).forEach(el => wrap.append(el));   /* FACT-CHECK card */
    if (!['ask', 'approve', 'memory', 'task', 'image', 'video'].includes(r.type)) wrap.append(actionsEl(m, isLast));
    return wrap;
  }
  /* The report card: name, size and one button. Nothing is written to Downloads until it is pressed. */
  function pdfEl(m) {
    const f = m.reply && m.reply.pdfFile;
    if (!f) return null;
    return h('div', { class: 'pdfcard' }, icon('file', 's'),
      h('span', { class: 't' }, h('b', {}, f.name), h('small', {}, f.kb + ' KB · PDF')),
      h('button', { class: 'btn pri', on: { click: () => downloadPdf(f) } }, 'Download'));
  }
  function downloadPdf(f) {
    const held = PDFS.get(f.id);
    if (!held) return toast('PDF is session me nahi hai · dobara banao');
    if (!window.AdarshNative || !window.AdarshNative.savePdf) return toast('Download sirf Android app me');
    try {
      const out = JSON.parse(window.AdarshNative.savePdf(held.name, held.base64) || '{}');
      toast(out && out.ok ? 'PDF Downloads me: ' + (out.name || held.name) : 'Save fail: ' + ((out && out.message) || 'unknown'));
    } catch (e) { toast('PDF save nahi hua'); }
  }
  function actionsEl(m, isLast) {
    const txt = () => stripMd(speechOf(m.reply)) || '';
    const a = h('div', { class: 'actions' });
    a.append(h('button', { 'aria-label': 'Copy', on: { click: async () => { toast(await copyText(m.reply.text || speechOf(m.reply)) ? 'Copied' : 'Copy yahan available nahi'); } } }, icon('copy', 's')));
    if (TTS.ok()) a.append(h('button', { 'aria-label': 'Read aloud', on: { click: () => { if (TTS.speaking()) { TTS.stop(); return; } toast('Bol raha hoon… dobara tap = stop'); TTS.speak(m.reply.type === 'text' ? m.reply.text : txt()); } } }, icon('speaker', 's')));
    ['up', 'dn'].forEach(k => a.append(h('button', { 'aria-label': k === 'up' ? 'Good answer' : 'Bad answer', 'aria-pressed': String(m.fb === k), on: { click: (e) => { m.fb = m.fb === k ? null : k; save(); e.currentTarget.parentNode.replaceWith(actionsEl(m, isLast)); Bus.emit('feedback', { id: m.id, fb: m.fb }); if (m.reply && m.reply.master && m.fb) { if (m.fb === 'dn') Lessons.feedbackSheet(); else Lessons.good(m); } } } }, icon(k === 'up' ? 'thumbup' : 'thumbdn', 's'))));
    if (isLast && m.reply.type !== 'actions') a.append(h('button', { 'aria-label': 'Retry', title: 'Retry', on: { click: retry } }, icon('refresh', 's')));
    const used = m.reply && m.reply.uiMode && m.reply.uiMode !== 'standard' ? Modes.get(m.reply.uiMode) : null;
    if (used) a.append(h('span', { class: 'meta', title: 'Answered in ' + used.name + ' mode' }, icon(used.ic, 's'), used.name));
    else if (m.reply && (m.reply.std === '2.9' || m.reply.std === '9.2')) a.append(h('span', { class: 'meta', title: 'Answered in Standard ' + m.reply.std }, icon('sparkle', 's'), m.reply.std));
    return a;
  }

  /* ---------- model calls: which model is being asked, and which one failed ---------- */
  const STAGE_NAMES = { architect: 'Architect', judge: 'Judge', stripper: 'Claims', skeptic: 'Skeptic', refine: 'Refiner', classify: 'Question type', guard: 'Guard' };
  function stageName(s) {
    if (!s) return 'Model call';
    if (STAGE_NAMES[s]) return STAGE_NAMES[s];
    const [k, n] = s.split(':');
    if (k === 'panel') return (n || 'draft').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
    if (k === 'falsifier') return 'Falsifier ' + (n || '');
    if (k === 'debate') return 'Debate round ' + (n || '');
    if (k === 'review') return (n === 'method' ? 'Method review' : 'Evidence review');
    if (k === 'repair') return 'Format repair ' + (n || '');
    return s.replace(/[:1-9]/g, ' ').trim().replace(/^./, c => c.toUpperCase());
  }
  const secsTxt = (s) => (s == null ? '' : (s >= 10 ? Math.round(s) + 's' : (Math.round(s * 10) / 10) + 's'));
  const callsOn = () => !!S.settings.calls;
  function toggleCalls() {
    S.settings.calls = callsOn() ? 0 : 1; save();
    drawCalls(); renderThread();
    if (callsOn() && !callRows.length) toast('Model calls on: har model call yahan dikhega');
  }
  function onCallEvent(ev) {
    if (!ev || !ev.t) return;
    const stage = ev.stage || '', model = ev.model || '';
    if (ev.t === 'try') {
      callRows.push({ stage, model, provider: ev.provider, state: 'run' });
    } else {
      let row = null;
      for (let i = callRows.length - 1; i >= 0; i--) {
        const r = callRows[i];
        if (r.model === model && r.stage === stage && r.state === 'run') { row = r; break; }
      }
      if (!row) { row = { stage, model, provider: ev.provider, state: 'run' }; callRows.push(row); }
      if (ev.t === 'ok') { row.state = 'ok'; row.secs = ev.secs; if (ev.asked && ev.asked !== model) row.asked = ev.asked; }
      else if (ev.t === 'fail') { row.state = 'fail'; row.why = ev.why || ''; }
      else if (ev.t === 'dead') { row.state = 'dead'; row.why = ev.why || ''; }
    }
    drawCalls();
  }
  // Once a request is stopped or finished, the bridge drops its later events, so a row still marked 'run' would show
  // "chal raha…" forever. Settle those rows: 'rok diya' after Stop, 'ruk gaya' if the request ended without its result.
  function settleCalls(stopped) {
    let n = 0;
    for (const r of callRows) if (r.state === 'run') { r.state = 'stop'; r.note = stopped ? 'rok diya' : 'ruk gaya'; n++; }
    if (n) drawCalls();
    return n;
  }
  function callRowEl(r, live) {
    const why = r.why || (r.fails && r.fails.length ? r.fails[0] : '');
    const cls = r.state === 'ok' ? 'ok' : (r.state === 'fail' || r.state === 'dead') ? 'bad' : r.state === 'stop' ? 'stop' : 'run';
    return h('div', { class: 'mcr ' + cls },
      h('span', { class: 'st' }, stageName(r.stage)),
      h('span', { class: 'md' }, (r.asked && r.asked !== r.model ? r.asked + ' → ' : '') + r.model),
      live && r.state === 'run' ? h('span', { class: 'ms' }, 'chal raha…')
        : r.state === 'ok' ? h('span', { class: 'ms' }, secsTxt(r.secs) || 'ok')
          : r.state === 'stop' ? h('span', { class: 'ms' }, r.note || 'rok diya')
            : h('span', { class: 'ms' }, 'fail'),
      why ? h('span', { class: 'why' }, why) : null);
  }
  function drawCalls() {
    if (!callsEl) return;
    callsBtn.classList.toggle('on', callsOn());
    callsBtn.setAttribute('aria-pressed', String(callsOn()));
    callsEl.hidden = !callsOn() || !callRows.length;   // the box appears only once a call runs
    if (callsEl.hidden) return;
    callsEl.textContent = '';
    const run = callRows.filter(r => r.state === 'run').length;
    const bad = callRows.filter(r => r.state === 'fail' || r.state === 'dead').length;
    const stopped = callRows.filter(r => r.state === 'stop').length;
    callsEl.append(h('div', { class: 'mch' }, icon('search2', 's'), h('b', {}, 'Model calls'),
      h('span', { class: 'muted' }, callRows.length ? callRows.length + ' calls' + (run ? ' · ' + run + ' chal rahe' : '') + (stopped ? ' · ' + stopped + ' roke' : '') + (bad ? ' · ' + bad + ' fail' : '') : ''),
      h('span', { class: 'sp' }), h('button', { class: 'ib', 'aria-label': 'Model calls band karo', on: { click: toggleCalls } }, icon('x', 's'))));
    const list = h('div', { class: 'mcl' });
    callRows.slice(-40).forEach(r => list.append(callRowEl(r, true)));
    callsEl.append(list);
    list.scrollTop = list.scrollHeight;
  }

  /* ---------- answer source: auto / manual / hybrid ---------- */
  const SRC = {
    auto: ['Auto', 'Six models, each with its own way of thinking (logic, research, code, first principles, business, planning), write the answers.'],
    manual: ['Manual', 'You paste answers from other AIs such as ChatGPT, Gemini or Claude. Adarsh checks them against each other.'],
    hybrid: ['Hybrid', 'Your pasted answers and the six models together.']
  };
  const MAX_ANSWERS = 8, MAX_ANSWER_CHARS = 12000;
  let pasted = [];                       // [{source, text}] for the next question only. Never saved.
  const requestMeta = new WeakMap(); // per-user-message one-session retry data; pasted answers never persisted
  const srcMode = () => S.settings.source || 'auto';
  const validAnswers = () => pasted.map(a => ({ source: (a.source || '').trim().slice(0, 60), text: (a.text || '').trim().slice(0, MAX_ANSWER_CHARS) })).filter(a => a.text);
  function sourceSheet() {
    sheet({ title: 'Where answers come from', tall: true, build(b, close) {
      const host = h('div', { style: 'display:flex;flex-direction:column;gap:12px' }); b.append(host);
      const draw = () => {
        host.textContent = '';
        const mode = srcMode();
        host.append(h('div', { class: 'seg' }, Object.keys(SRC).map(k => h('button', { 'aria-pressed': String(mode === k), on: { click: () => {
          if (k !== mode && BackgroundVoice.active()) BackgroundVoice.stop('Answer source changed. Restart background voice explicitly.');
          S.settings.source = k; save();
          if (k !== 'auto' && !pasted.length) pasted.push({ source: '', text: '' });
          drawAtts(); draw();
        } } }, SRC[k][0]))));
        host.append(h('p', {}, SRC[mode][1]));
        if (mode !== 'auto') {
          pasted.forEach((a, i) => {
            const name = h('input', { type: 'text', placeholder: 'Which AI? (ChatGPT, Gemini, Claude…)', value: a.source || '', 'aria-label': 'Answer ' + (i + 1) + ' source', maxlength: '60', on: { input: (e) => { a.source = e.target.value; } } });
            const body = h('textarea', { class: 'ansbox', placeholder: 'Paste the full answer here', 'aria-label': 'Answer ' + (i + 1) + ' text', maxlength: String(MAX_ANSWER_CHARS), value: a.text || '', on: { input: (e) => { a.text = e.target.value; } } });
            host.append(h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, name, body,
              h('button', { class: 'btn ghost', on: { click: () => { pasted.splice(i, 1); drawAtts(); draw(); } } }, 'Remove answer ' + (i + 1))));
          });
          if (pasted.length < MAX_ANSWERS) host.append(h('button', { class: 'btn ghost', on: { click: () => { pasted.push({ source: '', text: '' }); draw(); } } }, 'Add another answer'));
          host.append(h('p', { class: 'muted' }, 'Up to ' + MAX_ANSWERS + ' answers. Pasted text is checked for prompt injection and treated only as data. It is used for the next question and then cleared.'));
        }
        host.append(h('button', { class: 'btn pri', on: { click: () => { pasted = pasted.filter(a => (a.text || '').trim()); drawAtts(); close(); } } }, 'Done'));
      };
      draw();
    } });
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
      b.append(row('image', 'Photo', 'From gallery or camera', () => $('#f-img').click()),
        row('sparkle', 'Generate image', 'NVIDIA FLUX 3 Image Klein', () => mediaPrompt('image')),
        row('video', 'Generate video', 'NVIDIA Cosmos3 Nano (backup: Cosmos 1.0) · MP4', () => mediaPrompt('video')),
        row('file', 'File', 'Documents, text, PDFs', () => $('#f-any').click()),
        row('sliders', 'Answer source', SRC[srcMode()][0] + ' · choose where answers come from', sourceSheet));
    } });
  }
  function mediaPrompt(kind) {
    if (!Backend.isNative()) return toast('NVIDIA media generation abhi Android app mein available hai.');
    const keys = window.AdarshKeys && window.AdarshKeys.status ? window.AdarshKeys.status() : {};
    if (!['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3'].some(k => keys[k] && keys[k].set)) return toast('Pehle Settings > API keys mein NVIDIA key save karo.');
    sheet({ title: kind === 'image' ? 'Generate image' : 'Generate video', tall: true, build(b, close) {
      const prompt = h('textarea', { rows: '4', maxlength: '2000', placeholder: kind === 'image' ? 'Describe the image…' : 'Describe the video…', 'aria-label': 'Generation prompt', style: 'width:100%;min-height:110px;padding:12px;border-radius:14px;background:var(--card);color:var(--fg);border:0;font:inherit;resize:vertical' });
      const frames = kind === 'video' ? h('select', { 'aria-label': 'Video duration', style: 'width:100%;padding:12px;border-radius:14px;background:var(--card);color:var(--fg);border:0;font:inherit' },
        [[25, 'About 1 second'], [49, 'About 2 seconds'], [73, 'About 3 seconds'], [121, 'About 5 seconds']].map(([v, label]) => h('option', { value: String(v), selected: v === 49 }, label))) : null;
      const note = h('p', { class: 'muted' }, kind === 'image'
        ? 'FLUX makes one 1024×1024 JPEG. NVIDIA API limits apply.'
        : 'Cosmos3 makes a 480p, 24 fps MP4. Agar aapke NVIDIA account par Cosmos3 band hai to backup Cosmos 1.0 ek 5 second 704p video banata hai. It may take several minutes; the request can be stopped.');
      const disclosure = h('p', { class: 'muted' }, 'Prompt NVIDIA ko bheja jayega; private info mat likho. Stop app request ko locally cancel karta hai, lekin NVIDIA ke accepted generation ya billing ko rokne ki guarantee nahi hai.');
      const go = h('button', { class: 'btn pri', style: 'width:100%', on: { click: () => {
        const text = prompt.value.trim();
        if (!text) { toast('Prompt likho.'); prompt.focus(); return; }
        close(); generateMedia(kind, text, frames ? Number(frames.value) : undefined);
      } } }, kind === 'image' ? 'Generate image' : 'Generate video');
      b.append(h('label', { class: 'l' }, 'Prompt'), prompt);
      if (frames) b.append(h('label', { class: 'l' }, 'Duration'), frames);
      b.append(note, disclosure, go);
      setTimeout(() => { if (prompt.isConnected) prompt.focus(); }, 0);
    } });
  }
  async function generateMedia(kind, prompt, frames) {
    if (busy) return;
    if (!Backend.isNative()) return toast('NVIDIA media generation abhi Android app mein available hai.');
    if (BackgroundVoice.active()) BackgroundVoice.stop('Media ke liye background voice band.');
    if (!$('#lock').hidden) return toast('Pehle app unlock karo.');
    if (!App || App.view !== 'chat') App.show('chat');
    const c = cur() || newChat();
    const userText = (kind === 'image' ? 'Generate image: ' : 'Generate video: ') + prompt;
    pushUser(c, { id: uid('m'), role: 'user', text: userText, ts: Date.now(), requestSource: 'media' });
    busy = true; ctl = new AbortController();
    const lv = Council.live(); thinkEl = lv.el; callRows = []; drawCalls();
    sendBtn.replaceChildren(icon('stop')); sendBtn.setAttribute('aria-label', 'Stop'); onInput(); renderThread(); Bus.emit('busy', true);
    try {
      const media = { kind, prompt };
      if (kind === 'video') media.frames = frames || 49;
      const result = await Backend.send({ media }, { signal: ctl.signal, onProgress: s => lv.push(s) });
      if (ctl.signal.aborted) return;
      const r = normReply(result);
      if (r.type !== 'text' && r.type !== kind) throw new Error('NVIDIA se expected media result nahi mila.');
      deliver(c, r);
    } catch (e) {
      if (ctl.signal.aborted || e.name === 'AbortError') toast('App request stopped; NVIDIA may continue processing.');
      else { console.error(e); deliver(c, { type: 'text', text: '⚠️ ' + (e && e.message ? e.message : 'NVIDIA media request fail hua.') }); }
    } finally {
      settleCalls(!!(ctl && ctl.signal.aborted));
      busy = false; ctl = null; thinkEl = null; sendBtn.replaceChildren(icon('send')); sendBtn.setAttribute('aria-label', 'Send'); onInput(); renderThread(); save(); Bus.emit('busy', false);
    }
  }
  function addFile(f) {
    if (f.size > 8 * 1024 * 1024) return toast(f.name + ' is over 8 MB');
    const a = { id: uid('a'), name: f.name || 'pasted', kind: f.type.startsWith('image/') ? 'image' : 'file', type: f.type, size: f.size, file: f };
    if (a.kind === 'image') { a.thumb = URL.createObjectURL(f); thumbs.set(a.id, a.thumb); }
    pending.push(a); drawAtts(); onInput();
  }
  function drawAtts() {
    atts.textContent = '';
    if (srcMode() !== 'auto') atts.append(h('button', { class: 'srcchip', 'aria-label': 'Change answer source', on: { click: sourceSheet } }, icon('sliders', 's'), h('span', {}, SRC[srcMode()][0] + ' · ' + validAnswers().length + ' pasted')));
    pending.forEach(a => atts.append(h('div', { class: 'att' }, a.kind === 'image' ? h('img', { src: a.thumb, alt: '' }) : h('span', { class: 'ic' }, icon('file', 's')), h('span', {}, a.name),
      h('button', { 'aria-label': 'Remove ' + a.name, on: { click: () => { pending = pending.filter(x => x !== a); drawAtts(); onInput(); } } }, icon('x', 's')))));
  }
  const readAtt = (a) => new Promise(res => { const r = new FileReader(); r.onload = () => res({ id: a.id, name: a.name, kind: a.kind, type: a.type, size: a.size, dataUrl: r.result }); r.onerror = () => res({ id: a.id, name: a.name, kind: a.kind, type: a.type, size: a.size }); r.readAsDataURL(a.file); });

  let dictating = false;
  function dictate() {
    if (dictating) { STT.stop(); return; }
    const usingBnr = !!S.settings.bnr;
    if (BackgroundVoice.active()) BackgroundVoice.stop('Voice typing ke liye background voice band.');
    let base = ta.value;
    const ok = STT.start({
      onPartial: (t) => { ta.value = (base + ' ' + t).replace(/ {2,}/g, ' ').trimStart(); onInput(); },
      onFinal: (t) => { base = (base + ' ' + t).replace(/ {2,}/g, ' ').trimStart(); ta.value = base; onInput(); },
      onState: (s) => { if (s && s.state === 'processing') { statusEl.lastChild.textContent = 'Cleaning audio…'; micBtn.setAttribute('aria-label', 'Cancel audio cleanup'); } },
      onEnd: () => { dictating = false; micBtn.classList.remove('live'); micBtn.setAttribute('aria-label', 'Dictate'); if (usingBnr) Backend.refresh(); },
      onError: (msg) => toast(msg)
    });
    if (ok) { dictating = true; micBtn.classList.add('live'); } else toast('Voice typing isn’t supported in this browser. Use Voice mode’s typed input or your keyboard mic.');
  }

  /* ---------- send pipeline ---------- */
  function stop() { if (ctl) { ctl.abort(); settleCalls(true); } }
  function histText(c = cur()) {
    const allowPersonal = Productivity.access().personalOnline && Productivity.access().localRead;
    return (c ? c.msgs : []).filter(m => !m.localOnly && m.requestSource !== 'media' && !(m.reply && ['actions', 'blocked', 'clarification', 'task', 'memory', 'image', 'video'].includes(m.reply.type)) && (!m.personalContext || allowPersonal)).slice(-14).map(m => m.role === 'user' ? { role: 'user', text: m.text || (m.answer ? m.answer.map(a => a.answer).join('; ') : (m.decision || '')) } : { role: 'assistant', text: speechOf(m.reply) });
  }
  async function submit(textOverride, meta) {
    const text = (textOverride != null ? textOverride : ta.value).trim(); const files = textOverride != null ? [] : pending;
    if ((!text && !files.length) || busy) return;
    if (BackgroundVoice.active()) BackgroundVoice.stop('Chat ke liye background voice band.');
    if (!meta && App.view !== 'chat') App.show('chat');
    const night = !!(meta && meta.briefing), open0 = cur();
    /* Gehrai mein jao = Standard 9.2. The night briefing and every follow-up in its chat stay in Standard (Groq only), as promised in the briefing consent. */
    const source = night ? 'auto' : srcMode(), modeId = (meta && meta.deeper) || night || (open0 && open0.briefing) ? 'standard' : Modes.current().id;
    const answers = source !== 'auto' ? validAnswers() : [];
    if (source !== 'auto' && !answers.length) { toast('Manual/Hybrid source selected hai. Answer paste karo; source Auto nahi kiya.'); sourceSheet(); return; }
    const c = cur() || newChat();  // continue the open chat: every message used to start a new one, so follow-ups never saw earlier context
    const um = { id: uid('m'), role: 'user', text, ts: Date.now(), requestSource: source, atts: files.map(a => ({ id: a.id, name: a.name, kind: a.kind })) };
    if (night) um.briefing = true;
    requestMeta.set(um, { source, answers });
    busy = true; // a second submission cannot race asynchronous FileReader work
    pushUser(c, um);
    pasted = []; // one-shot for every submission, including live voice / typed override
    if (textOverride == null) { ta.value = ''; pending = []; }
    drawAtts(); onInput();
    const attachments = await Promise.all(files.map(readAtt));
    await runBackend(c, { text, attachments, meta, source, answers, modeId });
  }
  function pushUser(c, um) {
    if (!c.msgs.length && um.text) c.title = um.text.slice(0, 42);
    c.msgs.push(um); c.ts = Date.now(); save(); Bus.emit('chats:changed'); renderThread();
  }
  async function runBackend(c, { text, attachments = [], meta, source = 'auto', answers = [], modeId = Modes.current().id }) {
    busy = true; ctl = new AbortController(); const t0 = Date.now();
    const lv = Council.live(); const steps = lv.steps; thinkEl = lv.el;
    callRows = []; drawCalls();
    const liveParts = [];  // Part k/N messages shown while the council still writes the next part
    sendBtn.replaceChildren(icon('stop')); sendBtn.setAttribute('aria-label', 'Stop'); onInput(); renderThread();
    Bus.emit('busy', true);
    try {
      const perms = Productivity.access();
      const personal = Productivity.modelContext(text, c.id);
      const res = await Backend.send({ chatId: c.id, mode: modeId, text, attachments, history: perms.currentChat ? histText(c).slice(0, -1) : [], access: perms, app_context: personal, meta, source, answers, learn: Learn.request(), briefing: Briefing.request(c, meta), truth: Usage.request(), reply: { lang: S.settings.replyLang || 'auto', depth: S.settings.depth || 'normal', think: S.settings.think || 'fast', web: S.settings.webSearch === false ? 'off' : 'on', research: S.settings.research === false ? 'off' : 'on', std: S.settings.stdStyle === '9.2' ? '9.2' : '2.9' } },
        { signal: ctl.signal, onProgress: (s) => {
          if (typeof s === 'string' && s.startsWith('\u0001part ')) {  // finished Part k/N (see config.emit_part)
            try {
              const ev = JSON.parse(s.slice(s.indexOf('{')));
              const r = normReply({ type: 'text', text: String(ev.text || ''), part: { n: ev.n, of: ev.of }, live: true });
              r.uiMode = modeId;
              deliver(c, r); liveParts.push(c.msgs[c.msgs.length - 1]); renderThread(); save();
            } catch (e) { /* ignore */ }
            return;
          }
          if (typeof s === 'string' && s.charCodeAt(0) === 1) {  // structured model-call event (see config.emit_call)
            try { onCallEvent(JSON.parse(s.slice(s.indexOf('{')))); } catch (e) { /* ignore */ }
            return;
          }
          lv.push(s);
        } });
      if (!Backend.isDemo() && Backend.markUp) Backend.markUp();
      const arr = (Array.isArray(res) ? res : [res]).filter(Boolean).map(normReply);
      // the final list carries every part again (checked, with steps / sources / notes): it replaces the live copies
      for (const m of liveParts) { const i = c.msgs.indexOf(m); if (i >= 0) c.msgs.splice(i, 1); }
      if (arr[0] && Array.isArray(arr[0].calls) && arr[0].calls.length) {  // final list from the engine (also for the HTTP backend, which sends no live events)
        callRows = arr[0].calls.map(c => ({ stage: c.stage, model: c.model, asked: c.asked, state: c.ok ? 'ok' : 'fail', secs: c.secs, fails: c.fails || [] }));
        drawCalls();
      }
      for (const [i, r] of arr.entries()) {
        r.uiMode = modeId;
        if (i === 0) { holdPdf(r); r.took = Math.round((Date.now() - t0) / 1000); r.thinkLines = steps.slice(); if (steps.length && r.type !== 'actions') r.steps = [...new Set([...steps, ...(Array.isArray(r.steps) ? r.steps : [])])]; }
        if (r.origin === 'local-rule' || ['blocked', 'clarification'].includes(r.type)) { const last = [...c.msgs].reverse().find(m => m.role === 'user' && m.text === text); if (last) last.localOnly = true; }
        if (personal) r.personalContext = true;
        // App-setting commands ("standard mode pe jao", "web search off karo") work from every mode; other actions stay Standard-only.
        const settingsOnly = r.type === 'actions' && (r.steps || []).length && r.steps.every(st => st.action === 'settings.update');
        if (r.type === 'actions' && r.origin === 'local-rule' && (modeId === 'standard' || settingsOnly)) await Actions.execute(r, false);
        deliver(c, r);
      }
    } catch (e) {
      if (ctl.signal.aborted) toast('Rok diya: engine ko bhi stop bhej diya');
      else { console.error(e); deliver(c, { type: 'text', text: '⚠️ ' + (e && e.message ? e.message : 'Backend se baat nahi ho payi.') }); }
    } finally {
      settleCalls(!!(ctl && ctl.signal.aborted));
      busy = false; ctl = null; thinkEl = null; sendBtn.replaceChildren(icon('send')); sendBtn.setAttribute('aria-label', 'Send'); onInput(); renderThread(); save();
      Bus.emit('busy', false);
    }
  }
  /* A report the backend built: hand the bytes to Kotlin, which writes them into Downloads. */
  /* Report bytes stay in memory (base64 is far too heavy for localStorage) and the chat keeps only a small
     {id, name, kb} card, so the download is a button the user presses instead of an automatic file. */
  const PDFS = new Map();
  function holdPdf(r) {
    const pdf = r && r.pdf;
    if (!pdf || !pdf.base64) return;
    const name = String(pdf.name || 'adarsh-report.pdf');
    const id = uid('pdf');
    PDFS.set(id, { name: name, base64: String(pdf.base64) });
    r.pdfFile = { id: id, name: name, kb: Math.max(1, Math.round(String(pdf.base64).length * 0.75 / 1024)) };
    delete r.pdf;
  }
  const normReply = (r) => capReply(typeof r === 'string' ? { type: 'text', text: r } : r && r.type ? r : { type: 'text', text: String((r && r.text) || '') });
  function deliver(c, r) {
    // Only the explicit local action layer may mutate productivity data. Model/demo reply shapes are display-only.
    if (r.type === 'memory' || r.type === 'task') r = { type: 'text', text: r.type === 'task' ? 'Task proposal: ' + (r.title || '') + '. Add karne ke liye Standard command bolo.' : 'Memory proposal: ' + (r.text || '') };
    if (r.type === 'mission') upsertMission(r);
    if (r.council) { r.councilId = uid('cn'); Council.put(r.councilId, r.council); delete r.council; }  // big: stored apart from the chat state
    if (r.learn) Learn.absorb(r);   // a word counts as learned as soon as it was explained
    if (r.briefing) Briefing.absorb(c, r);   // night briefing history (S.briefings)
    if (r.quota) Usage.absorb(c, r);   // Groq quota running low: one toast a day
    const m = { id: uid('m'), role: 'ai', ts: Date.now(), reply: r, personalContext: !!r.personalContext };
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
    const lastU = [...c.msgs].reverse().find(m => m.role === 'user');
    if (!lastU) return;
    const previous = c.msgs[c.msgs.length - 1];
    if (previous && previous.reply && previous.reply.type === 'actions') return toast('Safe kaam repeat nahi kiye. Failed step ka naya command bolo.');
    const extra = requestMeta.get(lastU) || { source: lastU.requestSource || srcMode(), answers: [] };
    if (extra.source !== 'auto' && !extra.answers.length) { toast('Original pasted answers is session mein nahi hain. Dobara paste karke send karo; Auto nahi kiya.'); sourceSheet(); return; }
    while (c.msgs.length && c.msgs[c.msgs.length - 1].role === 'ai') c.msgs.pop();
    // Retry is a new request in the currently selected mode, with this message's original source/answers.
    if (lastU.briefing) { renderThread(); return runBackend(c, { text: lastU.text || '', source: 'auto', answers: [], meta: { briefing: true }, modeId: 'standard' }); }   // fresh night context
    renderThread(); runBackend(c, { text: lastU.text || '', ...extra, modeId: c.briefing ? 'standard' : Modes.current().id });
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

  function importBackground(rows) {
    const ids = [];
    rows.slice(0, 40).forEach(row => {
      if (!row || typeof row.id !== 'string' || typeof row.chatId !== 'string' || typeof row.text !== 'string' || !row.reply) return;
      if (S.chats.some(c => c.msgs.some(m => m.backgroundId === row.id))) { ids.push(row.id); return; }
      let c = S.chats.find(x => x.id === row.chatId);
      if (!c) { c = { id: row.chatId, title: row.text.slice(0, 42) || 'Background voice', ts: row.ts || Date.now(), msgs: [] }; S.chats.unshift(c); if (!S.cur) S.cur = c.id; }
      if (!c.msgs.length) c.title = row.text.slice(0, 42) || 'Background voice';
      c.msgs.push({ id: 'bg-u-' + row.id, backgroundId: row.id, role: 'user', text: row.text, ts: row.ts || Date.now(), requestSource: 'auto', localOnly: !!row.localOnly, personalContext: !!row.personalContext });
      (Array.isArray(row.reply) ? row.reply : [row.reply]).filter(Boolean).forEach(value => {
        const r = normReply(value); r.uiMode = row.mode || 'standard'; r.personalContext = !!row.personalContext;
        // Native session already resolved its safe steps. Rendering/import never executes them again.
        c.msgs.push({ id: uid('bg-a'), role: 'ai', ts: row.ts || Date.now(), reply: r, personalContext: !!row.personalContext });
      });
      c.ts = row.ts || Date.now(); ids.push(row.id);
    });
    if (ids.length) { Bus.emit('chats:changed'); renderThread(); }
    return ids;
  }

  return {
    mount, renderThread, newChat, open, remove, cur, submit, sourceSheet,
    history: histText, importBackground,
    setDraft(t) { ta.value = t; onInput(); ta.focus(); }, addFile, isBusy: () => busy,
    push(r, { chatId } = {}) { const c = (chatId && S.chats.find(x => x.id === chatId)) || newChat(); deliver(c, normReply(r)); save(); Bus.emit('chats:changed'); renderThread(); }
  };
})();
