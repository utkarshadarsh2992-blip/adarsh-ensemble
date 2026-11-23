'use strict';
/* 00-android-bridge.js : only active inside the Android app (window.AdarshNative is injected by the WebView).
   In a normal browser this file does nothing, so the same build still works with the HTTP backend or the demo.
   Messages go straight to the embedded Python engine: no localhost server. */
(function () {
  const N = window.AdarshNative;
  if (!N) return;

  const pending = {};
  let seq = 0;

  /* called by Kotlin when the engine finished: (id, jsonString) or (id, null, errorString) */
  window.__adarshResult = function (id, json, err) {
    const p = pending[id]; if (!p) return;
    delete pending[id];
    if (err) return p.rej(new Error(err));
    try { p.res(JSON.parse(json)); } catch (e) { p.rej(new Error('The engine returned something unreadable.')); }
  };
  window.__adarshProgress = function (id, text) {
    const p = pending[id]; if (p && p.onProgress && text) p.onProgress(text);
  };

  /* Voice typing: Android's SpeechRecognizer behind the same interface STT uses for platform dictation
     (onPartial / onFinal / onState / start / stop). The WebView itself has no Web Speech API. */
  if (N.speechStart) {
    const L = { partial: [], final: [], state: [] };
    let startWait = null;
    const on = (k, f) => { L[k].push(f); return () => { L[k] = L[k].filter(x => x !== f); }; };
    window.__adarshSpeech = function (type, text) {
      if (type === 'started') { if (startWait) { startWait.res(); startWait = null; } return; }
      if (type === 'error') { if (startWait) { startWait.rej({ code: text }); startWait = null; } else L.state.forEach(f => f({ state: 'idle', reason: 'error' })); return; }
      if (startWait) { startWait.res(); startWait = null; }
      if (type === 'partial') L.partial.forEach(f => f({ text }));
      else if (type === 'final') L.final.forEach(f => f({ text }));
      else if (type === 'state') L.state.forEach(f => f({ state: 'idle', reason: text }));
    };
    window.__adarshDictation = {
      onPartial: (f) => on('partial', f), onFinal: (f) => on('final', f), onState: (f) => on('state', f),
      start: () => new Promise((res, rej) => {
        startWait = { res, rej };
        setTimeout(() => { if (startWait) { startWait.rej({ code: 'timeout' }); startWait = null; } }, 15000);  // permission dialog counts
        try { N.speechStart((window.S && S.settings && S.settings.lang) || 'en-IN'); } catch (e) { startWait = null; rej({ code: 'unavailable' }); }
      }),
      stop: () => { try { N.speechStop(); } catch (e) {} return Promise.resolve(); }
    };
  }

  /* short engine jobs (natural voice): no foreground-service notification */
  const quiet = (req, ms) => new Promise((res, rej) => {
    const id = 'q' + (++seq) + '_' + Date.now();
    pending[id] = { res, rej };
    const t = setTimeout(() => { if (pending[id]) { delete pending[id]; try { N.cancel(id); } catch (e) {} rej(new Error('timeout')); } }, ms || 30000);
    const done = pending[id];
    pending[id] = { res: (v) => { clearTimeout(t); done.res(v); }, rej: (e) => { clearTimeout(t); done.rej(e); } };
    try { (N.sendQuiet || N.send).call(N, id, JSON.stringify(req)); } catch (e) { clearTimeout(t); delete pending[id]; rej(e); }
  });
  window.ADARSH_BACKEND = {
    native: true,
    /* {type:'audio', file} | {type:'error', error} */
    tts(req, ms) { return quiet({ tts: req }, ms); },
    status() { try { return JSON.parse(N.status()); } catch (e) { return { ready: false }; } },
    send(req, o) {
      return new Promise((res, rej) => {
        const id = 'r' + (++seq) + '_' + Date.now();
        pending[id] = { res, rej, onProgress: o && o.onProgress };
        if (o && o.signal) o.signal.addEventListener('abort', () => {
          if (!pending[id]) return;
          delete pending[id]; try { N.cancel(id); } catch (e) {}
          rej(new DOMException('Aborted', 'AbortError'));
        });
        /* attachments are not understood by the engine yet; do not push large data URLs across the bridge */
        const slim = Object.assign({}, req, { attachments: (req.attachments || []).map(a => ({ name: a.name, kind: a.kind, type: a.type, size: a.size })) });
        try { N.send(id, JSON.stringify(slim)); }
        catch (e) { delete pending[id]; rej(new Error('Could not reach the on-device engine.')); }
      });
    },
    /* lessons: quick synchronous file work on the device (no model call) */
    lessons(op) { try { return Promise.resolve(JSON.parse(N.lessons(JSON.stringify(op)))); } catch (e) { return Promise.resolve({ ok: false, error: 'Lessons nahi khule.' }); } },
    ping: async () => {
      /* Python (Chaquopy) needs a few seconds to start after the app opens: report "starting" so the UI asks again
         instead of showing Offline for good. A real start error, or no API key at all, gets its own label. */
      try {
        const s = JSON.parse(N.status());
        if (!s.ready) return s.error ? { ok: false, label: 'Engine error', error: s.error } : { ok: false, starting: true, label: 'Engine starting…' };
        const p = s.providers || {}, core = ['groq', 'gemini', 'openrouter'].filter(k => p[k]).length;
        if (!core) return { ok: false, label: 'No API keys', hint: 'Settings > API keys me Groq / Gemini / OpenRouter key daalo.' };
        return { ok: true, label: 'On-device engine', providers: p };
      } catch (e) { return { ok: false, starting: true, label: 'Engine starting…' }; }
    }
  };

  /* API keys live in Android Keystore-backed storage. JS only ever sees a short hint, never the key. */
  window.AdarshKeys = {
    providers: [
      { id: 'GROQ_API_KEY', name: 'Groq', url: 'console.groq.com/keys' },
      { id: 'GEMINI_API_KEY', name: 'Gemini', url: 'aistudio.google.com/apikey' },
      { id: 'OPENROUTER_API_KEY', name: 'OpenRouter', url: 'openrouter.ai/keys' },
      { id: 'CLOUDFLARE_API_TOKEN', name: 'Cloudflare token', url: 'dash.cloudflare.com/profile/api-tokens (Workers AI)' },
      { id: 'CLOUDFLARE_ACCOUNT_ID', name: 'Cloudflare Account ID', url: 'dash.cloudflare.com, Workers AI page', plain: true },
      { id: 'NVIDIA_API_KEY', name: 'NVIDIA NIM', url: 'build.nvidia.com' },
      { id: 'TAVILY_API_KEY', name: 'Tavily web search (optional)', url: 'app.tavily.com · without it, research uses Wikipedia only' }
    ],
    status() { try { return JSON.parse(N.keyStatus()); } catch (e) { return {}; } },
    save(id, value) { try { return JSON.parse(N.saveKey(id, value)); } catch (e) { return { ok: false, error: 'Could not save.' }; } },
    remove(id) { try { return JSON.parse(N.deleteKey(id)); } catch (e) { return { ok: false, error: 'Could not delete.' }; } }
  };
})();
