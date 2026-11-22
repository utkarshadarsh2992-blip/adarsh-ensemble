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

  window.ADARSH_BACKEND = {
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
    ping: async () => {
      try { const s = JSON.parse(N.status()); return { ok: !!s.ready, label: s.ready ? 'On-device engine' : 'Engine starting…' }; }
      catch (e) { return { ok: false, label: 'Engine not reachable' }; }
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
      { id: 'NVIDIA_API_KEY', name: 'NVIDIA NIM', url: 'build.nvidia.com' }
    ],
    status() { try { return JSON.parse(N.keyStatus()); } catch (e) { return {}; } },
    save(id, value) { try { return JSON.parse(N.saveKey(id, value)); } catch (e) { return { ok: false, error: 'Could not save.' }; } },
    remove(id) { try { return JSON.parse(N.deleteKey(id)); } catch (e) { return { ok: false, error: 'Could not delete.' }; } }
  };
})();
