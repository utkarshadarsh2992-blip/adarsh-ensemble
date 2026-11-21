'use strict';
/* 05-voice.js : speech-to-text (platform dictation capability, else Web Speech), text-to-speech, voice-mode overlay */

const TTS = {
  ok: () => 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined',
  speak(text, onEnd) {
    if (!this.ok() || !text) { if (onEnd) onEnd(); return; }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.slice(0, 1200)); u.lang = S.settings.lang; u.rate = S.settings.rate || 1;
      const v = speechSynthesis.getVoices().find(x => x.lang === S.settings.lang) || speechSynthesis.getVoices().find(x => x.lang.startsWith(S.settings.lang.slice(0, 2)));
      if (v) u.voice = v;
      u.onend = u.onerror = () => { if (onEnd) onEnd(); };
      speechSynthesis.speak(u);
    } catch (e) { if (onEnd) onEnd(); }
  },
  stop() { try { if (this.ok()) speechSynthesis.cancel(); } catch (e) {} }
};

const STT = {
  dict: null, _stop: null,
  supported() { return !!(this.dict || window.SpeechRecognition || window.webkitSpeechRecognition); },
  /* Must be called synchronously from a click. Returns false when nothing can listen. */
  start(o) {
    if (this.dict) {
      const d = this.dict; const offs = [];
      offs.push(d.onPartial(e => o.onPartial && o.onPartial(e.text)));
      offs.push(d.onFinal(e => o.onFinal && o.onFinal(e.text)));
      offs.push(d.onState(e => { if (e.state === 'idle') { offs.forEach(f => f()); this._stop = null; if (o.onEnd) o.onEnd(e.reason); } }));
      this._stop = () => d.stop().catch(() => {});
      d.start({}).catch(err => {
        if (err && err.code === 'stopped') return;
        offs.forEach(f => f()); this._stop = null;
        if (o.onError) o.onError(err && err.code === 'not_granted' ? 'Microphone permission was declined.' : 'Voice typing failed. Please type instead.');
        if (o.onEnd) o.onEnd('error');
      });
      return true;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return false;
    const r = new SR(); r.lang = S.settings.lang; r.interimResults = true; r.continuous = false; let got = false;
    r.onresult = (e) => {
      let part = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) { got = true; if (o.onFinal) o.onFinal(' ' + t.trim()); } else part += t;
      }
      if (part && o.onPartial) o.onPartial(part);
    };
    r.onerror = (e) => { if (o.onError) o.onError(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Microphone is blocked here. Type instead, or allow the mic in browser settings.' : e.error === 'no-speech' ? 'Didn’t catch anything.' : 'Voice input error: ' + e.error); };
    r.onend = () => { this._stop = null; if (o.onEnd) o.onEnd(got ? 'final' : 'empty'); };
    try { r.start(); } catch (e) { return false; }
    this._stop = () => { try { r.stop(); } catch (e) {} };
    return true;
  },
  stop() { if (this._stop) this._stop(); }
};

const Voice = (() => {
  let el, orb, stateEl, cap, inp, handsfree = true, speakOn = true, openFlag = false, collected = [], micBtn;
  const LABEL = { idle: 'Tap to talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };
  const setState = (s) => { el.dataset.state = s; stateEl.textContent = LABEL[s]; if (micBtn) micBtn.textContent = s === 'listening' ? 'Stop' : s === 'speaking' ? 'Interrupt' : 'Talk'; };
  const caption = (u, a) => { cap.textContent = ''; if (u) cap.append(h('div', { class: 'u' }, u)); if (a) cap.append(h('div', {}, a)); cap.scrollTop = cap.scrollHeight; };

  function build() {
    el = $('#voice'); el.textContent = '';
    orb = h('button', { class: 'orb', 'aria-label': 'Talk to Adarsh', on: { click: toggle } }, h('span', { class: 'r r3' }), h('span', { class: 'r r2' }), h('span', { class: 'r r1' }), h('span', { class: 'arc' }), h('span', { class: 'core' }));
    stateEl = h('p', { class: 'v-state', 'aria-live': 'polite' }, LABEL.idle); cap = h('div', { class: 'v-cap' });
    inp = h('input', { type: 'text', placeholder: 'Or type here', 'aria-label': 'Type a message', on: { keydown: (e) => { if (e.key === 'Enter') typed(); } } });
    micBtn = h('button', { class: 'chipbtn', on: { click: toggle } }, 'Talk');
    const hf = h('button', { class: 'chipbtn', 'aria-pressed': String(handsfree), on: { click: () => { handsfree = !handsfree; hf.setAttribute('aria-pressed', String(handsfree)); } } }, 'Hands-free');
    const sp = h('button', { class: 'chipbtn', 'aria-pressed': String(speakOn), on: { click: () => { speakOn = !speakOn; sp.setAttribute('aria-pressed', String(speakOn)); if (!speakOn) TTS.stop(); } } }, 'Voice replies');
    el.append(h('div', { class: 'v-top pad' }, h('span', { class: 'tag' }, 'VOICE · ' + S.settings.lang), ibtn('x', 'Close voice mode', close)),
      h('div', { class: 'v-mid' }, orb, stateEl, cap),
      h('div', { class: 'v-foot pad' }, h('div', { class: 'v-btns' }, micBtn, hf, sp), h('div', { class: 'v-type' }, inp, h('button', { class: 'circ send', 'aria-label': 'Send', on: { click: typed } }, icon('send')))));
  }
  function open() {
    if (openFlag) return; openFlag = true; build(); el.hidden = false; setState('idle');
    caption('', STT.supported() ? 'Tap the orb and speak. Hindi, English or Hinglish.' : 'Speech input isn’t available in this browser. Type below, replies can still be spoken.');
    document.addEventListener('keydown', onEsc);
  }
  function close() {
    if (!openFlag) return; openFlag = false; STT.stop(); TTS.stop(); el.hidden = true; document.removeEventListener('keydown', onEsc);
  }
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  function toggle() {
    const s = el.dataset.state;
    if (s === 'listening') return STT.stop();
    if (s === 'speaking') { TTS.stop(); setState('idle'); return; }
    if (s === 'thinking') return;
    listen();
  }
  function listen() {
    let text = '';
    const ok = STT.start({
      onPartial: (t) => { if (openFlag) caption((text + ' ' + t).trim()); },
      onFinal: (t) => { text = (text + t).trim(); caption(text); },
      onEnd: () => { if (!openFlag) return; if (text) say(text); else setState('idle'); },
      onError: (m) => { caption('', m); }
    });
    if (!ok) { caption('', 'Speech input isn’t available here. Type below.'); return; }
    setState('listening'); vibe();
  }
  function typed() { const t = inp.value.trim(); if (!t) return; inp.value = ''; STT.stop(); TTS.stop(); say(t); }

  async function say(text) {
    setState('thinking'); caption(text); collected = [];
    const un = Bus.on('reply', ({ msg }) => collected.push(msg.reply));
    try { await Chat.submit(text); } finally { un(); }
    if (!openFlag) return;
    const structured = collected.find(r => r.type === 'ask' || r.type === 'approve');
    const spoken = collected.map(speechOf).filter(Boolean).join(' ');
    caption(text, spoken || 'Done.');
    if (structured) {
      if (speakOn) TTS.speak(spoken); toast('Adarsh needs your answer in chat');
      setTimeout(close, speakOn ? 1800 : 400); return;
    }
    if (speakOn && spoken && TTS.ok()) { setState('speaking'); TTS.speak(spoken, () => { if (!openFlag) return; setState('idle'); if (handsfree && STT.supported()) listen(); }); }
    else { setState('idle'); if (handsfree && STT.supported() && !spoken) listen(); }
  }
  return { open, close };
})();
