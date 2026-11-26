'use strict';
/* 05-voice.js : speech-to-text (platform dictation capability, else Web Speech), text-to-speech, voice-mode overlay */

/* Text-to-speech. Two voices, picked per Settings > Voice & language > Engine:
   natural = the engine makes a WAV with Gemini TTS (confident, human-sounding; Hindi, English, Hinglish), played natively;
   device  = the phone's own TextToSpeech through the Android bridge (the WebView has no speechSynthesis), or the
             browser's speechSynthesis. "auto" = natural when available, device as instant fallback, so it never goes silent. */
const VOICES = [['Kore', 'Firm, confident · female'], ['Orus', 'Firm, confident · male'], ['Charon', 'Calm, informative · male'],
  ['Sulafat', 'Warm · female'], ['Achird', 'Friendly · male'], ['Iapetus', 'Clear · male'], ['Aoede', 'Breezy · female'],
  ['Puck', 'Upbeat · male'], ['Gacrux', 'Mature · female'], ['Sadaltager', 'Knowledgeable · male']];
/* What a person would say out loud: no markdown, code, links, citations, tags or confidence lines */
function speakable(text, max = 1200) {
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ').replace(/\[S\d+[^\]]*\]/g, '')
    .replace(/\[(PROVEN|REASONED|ASSUMED|UNSURE|VERIFIED)[^\]]*\]/gi, '').replace(/^\s*confidence\s*:.*$/gim, '')
    .replace(/^\s*\|.*\|\s*$/gm, '').replace(/^\s{0,3}#{1,6}\s*/gm, '').replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*\*[^*\n]{0,80}\*\s*$/gm, '').replace(/[*_~>#]+/g, '').replace(/\s*\n\s*/g, '. ').replace(/\.(\s*\.)+/g, '.').replace(/\s{2,}/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('। '));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim();
}
/* Voice mode speaks the core of the answer: the "Short answer"/"Direct" section when there is one */
function voiceText(text) {
  const s = String(text || '');
  const m = s.match(/(?:^|\n)\s*(?:#+\s*|\*\*|\d+\.\s*)?(short answer|direct core truth|seedha jawab|answer)\b[^\n]*\n?([\s\S]*?)(?=\n\s*(?:#+\s|\*\*[^*]+\*\*\s*\n|\d+\.\s+[A-Z])|$)/i);
  const core = m && m[2] && m[2].trim().length > 20 ? m[2] : s;
  return speakable(core, 700);
}
const TTS = (() => {
  const N = window.AdarshNative;
  const nativeDev = () => !!(N && N.ttsSpeak && (!N.ttsAvailable || N.ttsAvailable()));
  const webDev = () => 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  const natural = () => S.settings.voiceEngine !== 'device' && typeof Backend !== 'undefined' && Backend.canTts() && !Backend.isDemo();
  let cur = null, seq = 0, audio = null, naturalDown = 0;
  let devVoice = null; // last phone voice pushed to Kotlin
  const info = { last: '', why: '' };
  /* Kotlin -> page: ('start'|'done'|'error'|'stopped', id) */
  window.__adarshTts = (type, id) => {
    if (!cur || !cur.waiting || cur.waiting.id !== id) return;
    const w = cur.waiting;
    if (type === 'start') { if (!w.started) { w.started = true; if (w.start) { try { w.start(); } catch (e) {} } } return; }
    cur.waiting = null; w.done(type === 'done');
  };
  const rate = () => +S.settings.rate || 1;
  /* V6 offline neural voice (Piper on the phone): tried after the natural voice failed, before the phone's own voice */
  const neuralOk = () => { try { return !!(N && N.neuralSpeak && N.neuralReady && N.neuralReady()); } catch (e) { return false; } };
  function neural(job, text, onStart) {
    return new Promise((done) => {
      const id = 'tts' + (++seq);
      job.waiting = { id, done, start: onStart, started: false };
      try { N.neuralSpeak(id, text, S.settings.lang || 'en-IN', rate()); } catch (e) { job.waiting = null; done(false); }
    });
  }
  /* neural first when installed, then the phone voice. Resolves true when something spoke */
  async function fallback(job, text, onStart) {
    if (neuralOk()) {
      info.last = 'offline';
      const ok = await neural(job, text, onStart);
      if (job !== cur || ok) return ok;
    }
    info.last = 'device';
    return device(job, text, onStart);
  }
  /* play one piece on the device voice; resolves true when it finished speaking */
  function device(job, text, onStart) {
    return new Promise((done) => {
      if (nativeDev()) {
        const id = 'tts' + (++seq);
        job.waiting = { id, done, start: onStart, started: false };
        if (N.ttsSetVoice && S.settings.deviceVoice !== devVoice) {   // the voice picked in Settings (blank = automatic)
          devVoice = S.settings.deviceVoice || '';
          try { N.ttsSetVoice(devVoice); } catch (e) {}
        }
        try { N.ttsSpeak(id, text, S.settings.lang || 'en-IN', rate()); } catch (e) { job.waiting = null; done(false); }
        return;
      }
      if (!webDev()) return done(false);
      try {
        const u = new SpeechSynthesisUtterance(text); u.lang = S.settings.lang; u.rate = rate();
        const vs = speechSynthesis.getVoices(); const two = (S.settings.lang || 'en').slice(0, 2);
        const v = vs.find(x => x.lang === S.settings.lang && /natural|neural|google|online/i.test(x.name)) || vs.find(x => x.lang === S.settings.lang) || vs.find(x => x.lang.startsWith(two));
        if (v) u.voice = v;
        u.onstart = () => { if (onStart) onStart(); };
        u.onend = () => done(true); u.onerror = () => done(false);
        speechSynthesis.speak(u);
      } catch (e) { done(false); }
    });
  }
  /* play an engine clip: {file} natively on Android, {b64} with <audio> in the browser */
  function playClip(job, clip, onStart) {
    return new Promise((done) => {
      if (clip.file && N && N.ttsPlayFile) {
        const id = 'tts' + (++seq);
        job.waiting = { id, done, start: onStart, started: false };
        try { N.ttsPlayFile(id, clip.file, rate()); } catch (e) { job.waiting = null; done(false); }
        return;
      }
      if (!clip.b64) return done(false);
      try {
        audio = new Audio('data:' + (clip.mime || 'audio/wav') + ';base64,' + clip.b64); audio.playbackRate = rate();
        audio.onplay = () => { if (onStart) onStart(); };
        audio.onended = () => done(true); audio.onerror = () => done(false);
        audio.play().catch(() => done(false));
      } catch (e) { done(false); }
    });
  }
  const fetchClip = (text, ms) => Backend.tts({ text, voice: S.settings.voiceName || 'Orus', lang: S.settings.lang }, ms)
    .then(r => (r && r.type === 'audio' ? r : Promise.reject(new Error((r && r.error) || 'no audio'))));
  /* first sentence alone (so the voice starts fast), then the rest in one piece */
  function pieces(text) {
    const m = text.match(/^(.{20,180}?[.!?।])\s+(.+)$/s);
    return m ? [m[1], m[2]] : [text];
  }
  async function run(job, text, onStart) {
    const parts = natural() && Date.now() > naturalDown ? pieces(text) : null;
    if (parts) {
      const clips = parts.map((p, i) => fetchClip(p, i ? 45000 : 15000));   // all requested at once: the 2nd is ready when the 1st ends
      clips.forEach(c => c.catch(() => {}));
      for (let i = 0; i < parts.length; i++) {
        let clip = null;
        try { clip = await clips[i]; } catch (e) { info.why = String(e.message || e); }
        if (job !== cur) return;
        if (!clip) {
          if (S.settings.voiceEngine === 'natural' && !nativeDev() && !webDev()) return;
          naturalDown = Date.now() + 5 * 60e3;   // natural voice is down (no Gemini key / quota): device voice for 5 min
          await fallback(job, parts.slice(i).join(' '), onStart);
          return;
        }
        info.last = 'natural'; info.model = clip.model || info.model;
        const ok = await playClip(job, clip, onStart);
        if (job !== cur) return;
        if (!ok) { await fallback(job, parts.slice(i).join(' '), onStart); return; }
      }
      return;
    }
    if (S.settings.voiceEngine === 'device') { info.last = 'device'; await device(job, text, onStart); return; }
    await fallback(job, text, onStart);
  }
  return {
    VOICES, info, neuralOk,
    ok: () => natural() || nativeDev() || webDev(),
    /* speak(text, onEnd, onStart): callbacks bracket audible playback, never after stop() */
    speak(text, onEnd, onStart) {
      this.stop();
      const t = speakable(text);
      if (!t) { if (onEnd) onEnd(); return; }
      const job = { waiting: null }; cur = job;
      let started = false;
      const startedOnce = () => { if (started) return; started = true; if (onStart) { try { onStart(); } catch (e) {} } };
      run(job, t, startedOnce).catch(() => {}).finally(() => { if (cur === job) { cur = null; if (onEnd) onEnd(); } });
    },
    speaking: () => !!cur,
    pause() { try { if (N && N.neuralPause) N.neuralPause(); if (audio) audio.pause(); } catch (e) {} },
    resume() { try { if (N && N.neuralResume) N.neuralResume(); if (audio) audio.play(); } catch (e) {} },
    stop() {
      const j = cur; cur = null;
      if (j && j.waiting) { const w = j.waiting; j.waiting = null; w.done(false); }
      try { if (N && N.ttsStop) N.ttsStop(); } catch (e) {}
      try { if (audio) { audio.pause(); audio = null; } } catch (e) {}
      try { if (webDev()) speechSynthesis.cancel(); } catch (e) {}
    }
  };
})();
const STT = {
  dict: null, _stop: null,
  supported() { return !!(this.dict || window.SpeechRecognition || window.webkitSpeechRecognition); },
  /* Must be called synchronously from a click. Returns false when nothing can listen. */
  start(o) {
    if (this.dict) {
      const d = this.dict; const offs = [];
      const errorText = code => ({
        bnr_config: 'NVIDIA BNR ke liye NVIDIA API key aur BNR Function ID chahiye.',
        bnr_unsupported: 'NVIDIA BNR voice typing ko Android 13 ya uske baad ka version chahiye.',
        bnr_empty: 'Speech nahi mili. Dobara bolo ya BNR switch OFF karke normal dictation use karo.',
        bnr_failed: 'NVIDIA BNR fail hua. Internet, API key aur Function ID check karo; normal dictation available hai.',
        recognition_error: 'Phone ka recognition provider cleaned audio accept nahi kar saka. BNR-supported recognizer use karo ya setting OFF karo.',
        not_granted: 'Microphone permission nahi mili.',
        unavailable: 'Speech recognition is device par available nahi hai.'
      })[code] || 'Voice typing failed. Please type instead.';
      offs.push(d.onPartial(e => o.onPartial && o.onPartial(e.text)));
      offs.push(d.onFinal(e => o.onFinal && o.onFinal(e.text)));
      offs.push(d.onState(e => {
        if (o.onState) o.onState(e);
        if (e.state === 'idle') {
          if (e.message && o.onError) o.onError(errorText(e.message));
          else if (e.reason === 'recognition_error' && o.onError) o.onError(errorText(e.reason));
          offs.forEach(f => f()); this._stop = null; if (o.onEnd) o.onEnd(e.reason);
        }
      }));
      this._stop = () => d.stop().catch(() => {});
      d.start({}).catch(err => {
        if (err && err.code === 'stopped') return;
        offs.forEach(f => f()); this._stop = null;
        if (o.onError) o.onError(err && err.code === 'not_granted' ? 'Microphone permission was declined.' : errorText(err && err.code));
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

/* Adarsh Live (Step 5): the Gemini Live API over one WebSocket, spoken both ways. The socket, microphone and
   playback live in Kotlin (AdarshLive.kt) because a WebView has no raw-PCM capture; this file only drives the
   screen, shows both transcripts and falls back to the old listen/answer/speak loop on any error.
   Changing the live model or voice is one line here (LIVE_MODELS / default model). */
const LIVE_MODELS = [
  ['auto', 'Auto · need ke hisaab se'],
  ['gemini-3.8-live-extended-thinking', 'Gemini 3.8 Live Extended Thinking'],
  ['gemini-2.5-flash-native-audio-preview-12-2025', 'Gemini 2.5 Flash Native Audio Dialog'],
  ['gemini-3.1-flash-live-preview', 'Gemini 3.1 Flash Live'],
  ['gemini-3.5-live-translate-preview', 'Gemini 3.5 Live Translate'],
  ['gemini-3.5-transcribe-live', 'Gemini 3.5 Transcribe Live']
];
const LIVE_DEFAULT_MODEL = 'auto';
/* One Live model per job. Auto routing picks the role, so changing a model is one line here.
   Keep in sync with ROLE_MODEL in AdarshLive.kt. */
const LIVE_ROLES = {
  main: ['gemini-3.8-live', 'Main voice'],
  think: ['gemini-3.8-live-extended-thinking', 'Advanced reasoning'],
  transcribe: ['gemini-3.5-transcribe-live', 'Speech recognition'],
  translate: ['gemini-3.5-live-translate-preview', 'Translation'],
  backup: ['gemini-2.5-flash-native-audio-preview-12-2025', 'Backup'],
  test: ['gemini-3.1-flash-live-preview', 'Backup/testing']
};
/* What the user is asking for, decided from their own words (no extra model call, works offline). */
const LIVE_RE = {
  translate: /(translate|translation|tarjuma|hindi\s*(me|mein)|english\s*(me|mein)|angrezi|isko\s+(hindi|english)|अनुवाद)/i,
  transcribe: /(transcript|transcribe|likh\s*(ke|kar)|dictation|note\s*kar|type\s*kar)/i,
  think: /(kyun|kyu|why|samjha|explain|prove|proof|derive|compare|difference|plan\s*kar|design|architect|code|debug|calculate|reason|analys|analy[sz]e|kaise\s*kaam)/i
};
/* Gemini Live prebuilt voices. Orus/Charon/Fenrir are the deeper male ones, so Jarvis-like by default. */
const LIVE_VOICES = ['Orus', 'Charon', 'Fenrir', 'Puck', 'Kore', 'Aoede', 'Leda', 'Zephyr', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Sadaltager'];
const Live = (() => {
  const N = () => window.AdarshNative;
  let on = false, handlers = null, model = '';
  const native = () => { const n = N(); return !!(n && n.liveStart); };
  const available = () => native() && S.settings.adarshLive === true;
  const liveModel = () => { const m = S.settings.liveModel; return LIVE_MODELS.some(x => x[0] === m) ? m : LIVE_DEFAULT_MODEL; };
  let role = 'main';
  /* Which role a sentence needs; '' means "leave it alone", 'main' means "back to everyday voice". */
  function roleFor(text, current) {
    const t = String(text || '').trim();
    if (!t) return '';
    /* while dictating, the transcript is our own voice: never re-route on it, only leave when told to */
    if (current === 'transcribe') return /(stop|band|bas|normal|wapas|ruko|kaafi)/i.test(t) ? 'main' : '';
    if (LIVE_RE.translate.test(t)) return 'translate';
    if (LIVE_RE.transcribe.test(t)) return 'transcribe';
    if (LIVE_RE.think.test(t) || t.length > 140) return 'think';
    return (current && current !== 'main') ? 'main' : '';
  }
  /* "isko english me karo" -> translate into English; anything else -> Hindi. */
  const translateTarget = (t) => /(english|angrezi|अंग्रेज़ी)/i.test(String(t || '')) ? 'en' : 'hi';
  function switchTo(r, said) {
    if (!native() || !N().liveSwitch) return false;
    const ask = r === 'translate' ? 'translate:' + translateTarget(said) : r;
    try { const out = JSON.parse(N().liveSwitch(ask) || '{}'); if (out && out.ok) role = r; return !!(out && out.ok); } catch (e) { return false; }
  }
  const voice = () => { const v = String(S.settings.voiceName || 'Orus'); return LIVE_VOICES.includes(v) ? v : 'Orus'; };
  /* Jarvis rules + the user's Philosophy page; the key stays on the phone (Kotlin reads SecureKeys). */
  const ABOUT_SIR = 'You are ADARSH, Sir\'s AI assistant. Always address the user as "Sir".';
  const LEARNING_STYLE = 'Honor Sir\'s requested depth and format. If unspecified, follow the selected mode and answer concisely; expand only when asked. For learning, start from accessible basics and first principles, use one helpful intuition, define unfamiliar terms, and distinguish facts from assumptions. Derive only when asked or required by the selected mode. Do not repeat already learned words. No fluff.';
  function prompt() {
    const name = S.settings.name || 'Adarsh';
    const lang = S.settings.lang === 'en-US' ? 'English (US)' : S.settings.lang === 'en-IN' ? 'Indian English' : 'Hindi/Hinglish';
    const base = 'You are ' + name + ', a calm, confident on-device assistant. ' + ABOUT_SIR + ' ' + LEARNING_STYLE + ' '
      + 'Speak in ' + lang + ' — match the language the user speaks. Keep spoken replies short (1-3 sentences) unless asked for detail. '
      + 'No markdown, no lists, no emoji, no URLs. Never invent facts; if unsure, say so briefly. '
      + 'You cannot run code, install anything or send messages without the user confirming.';
    const philo = String(S.philosophy || '').trim();
    return (base + (philo ? '\n\nFollow the user\'s own principles:\n' + philo.slice(0, 3000) : '')).slice(0, 6000);
  }
  function start(h) {
    if (!native()) return false;
    handlers = h; on = true;
    let out = {};
    try { out = JSON.parse(N().liveStart(JSON.stringify({ model: liveModel(), voice: voice(), prompt: prompt(), target: translateTarget('') })) || '{}'); }
    catch (e) { out = { ok: false, message: e.message }; }
    if (out && out.ok === false) { on = false; if (h && h.onError) h.onError(out.message || 'Live start nahi hua.'); return false; }
    model = out.model || liveModel();
    return true;
  }
  function stop() {
    role = 'main';
    if (!on && !native()) return;
    on = false; handlers = null;
    try { N().liveStop(); } catch (e) {}
  }
  function probe(h) { if (!native() || !N().liveProbe) return false; handlers = h; try { N().liveProbe(); return true; } catch (e) { return false; } }
  function send(text) { if (!on || !native()) return false; try { return !!(JSON.parse(N().liveSendText(text)).ok); } catch (e) { return false; } }
  /* Kotlin pushes every event here: state / user / model / error / closed */
  window.__adarshLive = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    const h = handlers; if (!h) return;
    try {
      if (ev.type === 'state' && h.onState) h.onState(ev.state, ev.model, ev);
      else if (ev.type === 'notice' && h.onNotice) h.onNotice(ev.message);
      else if (ev.type === 'probe' && h.onProbe) h.onProbe(ev.message);
      else if (ev.type === 'role') { role = ev.role || 'main'; if (h.onRole) h.onRole(ev.role, ev.label, ev.model); }
      else if (ev.type === 'user' && h.onUser) h.onUser(ev.text);
      else if (ev.type === 'model' && h.onModel) h.onModel(ev.text);
      else if (ev.type === 'error') { on = false; if (h.onError) h.onError(ev.message || 'Live error'); }
      else if (ev.type === 'closed' && h.onClosed) h.onClosed();
    } catch (e) {}
  };
  return { available, native, start, stop, send, probe, roleFor, switch: switchTo,
    get role() { return role; }, model: () => model, get isOn() { return on; } };
})();

const Voice = (() => {
  let el, orb, stateEl, cap, capU, capA, capRev, inp, handsfree = false, speakOn = S.settings.voiceReplies !== false, openFlag = false, micBtn;
  let session = 0, releasePrompt = null, releaseAsk = null;
  const active = token => openFlag && token === session;
  const LABEL = { idle: 'Tap to talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…', connecting: 'Connecting…', live: 'Live · just speak' };
  let liveOn = false, liveUser = '', liveModel = '';
  const setState = (s) => { el.dataset.state = s; stateEl.textContent = LABEL[s] || s; if (micBtn) micBtn.textContent = liveOn ? (s === 'speaking' ? 'Interrupt' : 'End') : s === 'listening' ? 'Stop' : s === 'speaking' ? 'Interrupt' : 'Talk'; };
  /* The caption is the user's line, then the answer typed out one word at a time at speaking pace, so nothing
     runs ahead of the voice; once the voice stops the rest follows quickly. */
  function capBuild() {
    if (!cap) return;
    cap.textContent = '';
    capU = h('div', { class: 'u' });
    capA = h('div', { class: 'a' });
    capRev = Motion.reveal(capA, { pace: 320, quick: 85, fast: 28, onTick: () => Motion.glide(cap) });
    cap.append(capU, capA);
  }
  function caption(u, a) {
    if (!capRev) capBuild();
    if (!capRev) return;
    if (u !== undefined) capU.textContent = u || '';
    if (a === undefined) { capRev.finish(); capRev.set(''); }   /* a new turn: the old answer goes at once */
    else capRev.set(a);
    Motion.glide(cap);
  }
  const capFlush = () => { if (capRev) capRev.flush(); };
  const capHold = () => { if (capRev) capRev.hold(); };
  const capNow = () => { if (capRev) capRev.finish(); };   /* errors and closures read at once, no typing */
  const capPace = () => { if (capRev) capRev.pace(); };

  function build() {
    el = $('#voice'); el.textContent = '';
    orb = h('button', { class: 'orb', 'aria-label': 'Talk to Adarsh', on: { click: toggle } }, h('span', { class: 'r r3' }), h('span', { class: 'r r2' }), h('span', { class: 'r r1' }), h('span', { class: 'arc' }), h('span', { class: 'core' }));
    stateEl = h('p', { class: 'v-state', 'aria-live': 'polite' }, LABEL.idle); cap = h('div', { class: 'v-cap' });
    capRev = null; capU = null; capA = null;   /* the reveal is rebuilt with the screen */
    inp = h('input', { type: 'text', placeholder: 'Or type here', 'aria-label': 'Type a message', on: { keydown: (e) => { if (e.key === 'Enter') typed(); } } });
    micBtn = h('button', { class: 'chipbtn', on: { click: toggle } }, 'Talk');
    const hf = h('button', { class: 'chipbtn', 'aria-pressed': String(handsfree), on: { click: () => { handsfree = !handsfree; hf.setAttribute('aria-pressed', String(handsfree)); } } }, 'Hands-free');
    speakOn = S.settings.voiceReplies !== false;
    const sp = h('button', { class: 'chipbtn', 'aria-pressed': String(speakOn), on: { click: () => { speakOn = !speakOn; S.settings.voiceReplies = speakOn; save(); sp.setAttribute('aria-pressed', String(speakOn)); if (!speakOn) TTS.stop(); } } }, 'Voice replies');
    el.append(h('div', { class: 'v-top pad' }, h('span', { class: 'tag' }, (S.settings.adarshLive && Live.native() ? 'ADARSH LIVE' : 'VOICE') + ' · ' + S.settings.lang + (TTS.ok() ? '' : ' · no speech output')), ibtn('x', 'Close voice mode', close)),
      h('div', { class: 'v-mid' }, orb, stateEl, cap),
      h('div', { class: 'v-foot pad' }, h('div', { class: 'v-btns' }, micBtn, hf, sp), h('div', { class: 'v-type' }, inp, h('button', { class: 'circ send', 'aria-label': 'Send', on: { click: typed } }, icon('send')))));
  }
  /* opts.listen: coming back from the background session, so start listening right away */
  function open(opts = {}) {
    if (BackgroundVoice.active()) return BackgroundVoice.open();
    if (openFlag) return; session++; openFlag = true; if (opts.listen && STT.supported()) handsfree = true; build(); el.hidden = false; setState('idle');
    caption('', STT.supported() ? (opts.listen ? 'Wapas app mein. Bolo, main sun raha hoon.' : 'Tap the orb and speak. Hindi, English or Hinglish.') : 'Speech input isn’t available in this browser. Type below, replies can still be spoken.');
    document.addEventListener('keydown', onEsc);
    BackgroundVoice.arm();
    if (S.settings.adarshLive && Live.native()) { if (startLive()) return; }   // falls through to the old loop on failure
    if (opts.listen && STT.supported()) listen();
  }
  /* One Live session per screen: audio is only captured while this screen is visible. Any failure returns false so
     the caller can use the proven listen -> answer -> speak loop instead. */
  function startLive() {
    const token = session;
    liveUser = ''; liveModel = '';
    capHold();
    setState('connecting');
    caption('', 'Adarsh Live jud raha hai…');
    const ok = Live.start({
      onState: (s, m, ev) => {
        if (!active(token)) return;
        if (s === 'speaking') { setState('speaking'); capPace(); }
        else if (s === 'listening') { setState('listening'); capPace(); stateEl.textContent = 'Live · just speak' + (m ? ' · ' + m.replace('gemini-', '') : ''); }
        else if (s === 'connecting') {
          setState('connecting');
          /* say which attempt is running, so a slow start is visible instead of a dead "Connecting…" */
          const n = ev && ev.attempt ? ' ' + ev.attempt + '/' + ev.total : '';
          stateEl.textContent = 'Connecting…' + n;
        }
      },
      onNotice: (m) => { if (active(token)) caption(liveUser, m); },
      onUser: (t) => {
        if (!active(token)) return;
        if (capRev) capRev.finish();
        liveUser = (liveUser + ' ' + t).trim().slice(-600); liveModel = '';
        capHold(); caption(liveUser, liveModel);
        /* auto role routing: the sentence itself decides which Live model should answer it */
        const want = Live.roleFor(t, Live.role);
        if (want && want !== Live.role && Live.switch(want, t)) setState('thinking');
      },
      onRole: (r, label) => {
        if (!active(token)) return;
        if (r && r !== 'main' && label) { setState('thinking'); stateEl.textContent = label; }
        else if (r === 'main') stateEl.textContent = 'Live · just speak';
      },
      onModel: (t) => { if (!active(token)) return; liveModel = (liveModel + ' ' + t).trim().slice(-1200); caption(liveUser, liveModel); },
      onError: (m) => {
        if (!active(token)) return;
        liveOn = false;
        caption('', 'Adarsh Live: ' + m + ' — normal voice par ja raha hoon.'); capNow();
        toast('Adarsh Live off: ' + m);
        setTimeout(() => { if (active(token)) { setState('idle'); listen(); } }, 900);
      },
      onClosed: () => { if (active(token) && liveOn) { liveOn = false; setState('idle'); capNow(); } }
    });
    if (!ok) { liveOn = false; setState('idle'); return false; }
    liveOn = true; setState('connecting');
    return true;
  }
  /* opts.keepBackground: the phone already moved this conversation to the background session */
  function close(opts = {}) {
    if (!openFlag) return; openFlag = false; session++;
    if (!opts.keepBackground) BackgroundVoice.disarm();
    if (releaseAsk) releaseAsk(''); if (releasePrompt) releasePrompt();
    liveOn = false; if (capRev) capRev.stop(); capRev = null; Live.stop();
    STT.stop(); TTS.stop(); el.hidden = true; document.removeEventListener('keydown', onEsc);
  }
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  function toggle() {
    if (liveOn) {
      if (el.dataset.state === 'speaking') { Live.stop(); liveOn = false; setState('idle'); return; }   // interrupt, stay open
      Live.stop(); liveOn = false; close(); return;   // end the live session
    }
    const s = el.dataset.state;
    if (s === 'listening') return STT.stop();
    if (s === 'speaking') { session++; if (releasePrompt) releasePrompt(); TTS.stop(); setState('idle'); return; }
    if (s === 'thinking') return;
    listen();
  }
  function listen() {
    let text = ''; const token = session;
    const ok = STT.start({
      onPartial: (t) => { if (active(token)) caption((text + ' ' + t).trim()); },
      onFinal: (t) => { if (active(token)) { text = (text + t).trim(); caption(text); } },
      onEnd: () => { if (!active(token)) return; if (text) say(text); else setState('idle'); },
      onError: (m) => { if (active(token)) caption('', m); }
    });
    if (!ok) { caption('', 'Speech input isn’t available here. Type below.'); return; }
    setState('listening'); vibe();
  }
  function typed() {
    const t = inp.value.trim(); if (!t) return;
    if (liveOn) { if (Live.send(t)) { inp.value = ''; liveUser = t; caption(liveUser, liveModel); } return; }   // same socket, no new turn machinery
    if (Chat.isBusy()) return; inp.value = ''; session++; if (releaseAsk) releaseAsk(''); if (releasePrompt) releasePrompt(); STT.stop(); TTS.stop(); say(t); }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  /* Standard-mode actions run on the phone after the card mounts: wait for them so we speak the result, not the plan */
  async function waitDone(list, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (list.every(a => a.run && a.run.state !== 'running')) return true;
      await sleep(80);
    }
    return false;
  }
  /* one short yes/no turn, used when a sensitive action needs a spoken confirmation */
  function prompt(text, token) {
    return new Promise(resolve => {
      let done = false; const timer = setTimeout(() => { TTS.stop(); fin(); }, 20000);
      const fin = () => { if (done) return; done = true; clearTimeout(timer); releasePrompt = null; resolve(); };
      releasePrompt = fin;
      if (!active(token)) return fin();
      TTS.speak(text, fin, () => { if (active(token)) { setState('speaking'); capPace(); } });
    });
  }
  function askOnce(ms, token) {
    return new Promise((resolve) => {
      if (!active(token) || !STT.supported()) return resolve('');
      let got = '', done = false, timer;
      const fin = (v) => { if (done) return; done = true; clearTimeout(timer); releaseAsk = null; try { STT.stop(); } catch (e) {} resolve(v); };
      releaseAsk = fin;
      const ok = STT.start({
        onPartial: (t) => { if (active(token)) caption(t); },
        onFinal: (t) => { if (active(token)) got = (got + ' ' + t).trim(); },
        onEnd: () => fin(got),
        onError: () => fin(got)
      });
      if (!ok) return fin('');
      setState('listening');
      timer = setTimeout(() => fin(got), ms);
    });
  }

  async function say(text) {
    if (!openFlag || Chat.isBusy()) return;
    const token = ++session, collected = [];
    setState('thinking'); caption(text);
    const un = Bus.on('reply', ({ msg }) => collected.push(msg.reply));
    try { await Chat.submit(text, { voice: true }); } finally { un(); }   // voice: the engine answers short and speakable
    if (openFlag) BackgroundVoice.arm();   // the background session must continue with this turn in its history
    if (!active(token)) return;
    if (!collected.length) { caption(text, 'Message send nahi hua. Chat mein source/connection check karo.'); setState('idle'); return; }
    const structured = collected.find(r => r.type === 'ask' || r.type === 'approve');
    const acts = collected.filter(r => r && r.type === 'actions');
    const risky = acts.filter(a => a.run && a.run.state === 'pending' && (a.steps || []).some(s => ['message.draft', 'call.dial'].includes(s.action)));
    if (risky.length) {   // "Sir, message bhejne se pehle confirm chahiye. Haan bolo to kar dunga."
      const a = risky[0];
      const q = 'Sir, ' + ((a.steps.find(s => s.risk !== 'safe') || {}).detail || 'ye kaam') + ' ke liye confirm chahiye. Haan bolo to kar dunga.';
      if (speakOn && TTS.ok()) capHold();
      caption(text, q);
      if (speakOn && TTS.ok()) { await prompt(q, token); capFlush(); }
      if (!active(token)) return;
      const ans = (await askOnce(7000, token)).trim().replace(/[.!?।]+$/g, '').toLowerCase();
      if (!active(token)) return;
      const yes = /^(haan|han|ha|yes|yep|ok|okay|theek|theek hai|kar do|kardo|karo|sure|हाँ|हां|ठीक है)( sir)?$/.test(ans);
      const no = /^(nahi|nahin|no|nope|cancel|mat karo|rehne do|नहीं|नही)( sir)?$/.test(ans);
      const c = Actions.ctx(a);
      if (yes) { setState('thinking'); await Actions.execute(a, true, c && c.redraw); }
      else if (no) Actions.cancel(a, c && c.redraw);
      else { caption(text, 'Clear Haan/Nahi nahi mila. Kaam pending hai; chat card par confirm ya cancel karo.'); setState('idle'); return; }
    }
    if (!active(token)) return;
    const spoken = collected.map(r => (r && r.type === 'text' ? voiceText(r.text) : speechOf(r))).filter(Boolean).join(' ');
    const audible = !!(speakOn && spoken && TTS.ok());
    if (audible) capHold();
    caption(text, spoken || 'Done.');
    if (structured) {
      if (audible) TTS.speak(spoken, capFlush, () => { if (active(token)) { setState('speaking'); capPace(); } });
      toast('Adarsh needs your answer in chat');
      setTimeout(() => { if (active(token)) close(); }, audible ? 1800 : 400); return;
    }
    if (audible) { TTS.speak(spoken, () => { capFlush(); if (!active(token) || el.dataset.state !== 'speaking') return; setState('idle'); if (handsfree && STT.supported()) listen(); }, () => { if (active(token)) { setState('speaking'); capPace(); } }); }
    else { capFlush(); setState('idle'); if (handsfree && STT.supported() && !spoken) listen(); }
  }
  /* Settings > Speak replies: read every new chat answer aloud (voice mode speaks on its own) */
  Bus.on('reply', ({ msg }) => {
    if (openFlag || !S.settings.speak || document.hidden || !msg || !msg.reply) return;
    const r = msg.reply; const t = r.type === 'text' ? voiceText(r.text) : speechOf(r);
    if (t && TTS.ok()) setTimeout(() => TTS.speak(t), 50);
  });
  return { open, close, get isOpen() { return openFlag; } };
})();
