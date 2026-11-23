'use strict';
/* Android-only updates and explicit outside-app voice. No credentials are sent to GitHub. */
const MobileUpdates = (() => {
  let state = { state: 'idle' }, redraw = null;
  const announced = new Set();
  const native = () => window.AdarshNative;
  const supported = () => !!(native() && native().updateCheck);
  function apply(value) {
    if (!value || typeof value !== 'object') return state;
    state = value;
    if (redraw) redraw();
    if (state.state === 'available' && state.versionCode && !announced.has(state.versionCode) && !document.hidden && $('#lock').hidden) {
      announced.add(state.versionCode);
      banner({ title: 'ADARSH update available', text: String(state.versionName || '') + ' · verified APK download', label: 'Update now', onOpen: open, ms: 0 });
    }
    return state;
  }
  function call(method, ...args) {
    try { return apply(JSON.parse(native()[method](...args))); }
    catch (e) { return apply({ ok: false, state: 'error', message: 'Update check nahi hua. Internet aur GitHub availability check karo.' }); }
  }
  function check(force = true) { if (supported()) return call('updateCheck', !!force); }
  function open() {
    if (!supported()) return toast('App updates Android APK mein available hain.');
    const close = sheet({ title: 'App updates', tall: true, build(b) {
      const draw = () => {
        b.textContent = '';
        b.append(h('p', {}, 'Installed: ' + String(state.installedVersion || 'ADARSH')), h('p', { role: 'status', 'aria-live': 'polite' }, String(state.message || state.state || 'Ready')));
        if (state.versionName) b.append(h('p', {}, 'Published version: ' + state.versionName));
        if (state.notes) b.append(h('pre', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px' }, String(state.notes).slice(0, 3000)));
        if (state.state === 'downloading') b.append(h('p', {}, 'Download: ' + Math.max(0, Math.min(100, Number(state.progress) || 0)) + '%'));
        const running = ['checking', 'downloading'].includes(state.state);
        b.append(h('button', { class: 'btn ghost', disabled: running, on: { click: () => check(true) } }, 'Check for updates'));
        if (state.state === 'available') b.append(h('button', { class: 'btn pri', on: { click: () => { BackgroundVoice.stop(); Voice.close(); TTS.stop(); call('updateDownload'); } } }, 'Update now'));
        if (['ready', 'permission_required'].includes(state.state)) b.append(h('button', { class: 'btn pri', on: { click: () => { BackgroundVoice.stop(); call('updateInstall'); } } }, 'Install update'));
        b.append(h('p', { class: 'muted' }, 'Only successful published builds. APK hash, package, version and signing identity are checked. Android asks before installation; if permission is needed, allow it and tap Install update again. No uninstall or automatic installation.'), h('button', { class: 'btn ghost', on: { click: () => close() } }, 'Later'));
      };
      redraw = draw; draw();
      const observer = new MutationObserver(() => { if (!b.isConnected) { observer.disconnect(); if (redraw === draw) redraw = null; } });
      observer.observe($('#phone'), { childList: true });
    } });
  }
  window.__adarshUpdate = apply;
  function init() {
    if (!supported()) return;
    call('updateStatus'); check(false);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { call('updateStatus'); check(false); } });
  }
  return { init, open, check, supported, status: () => state };
})();

const BackgroundVoice = (() => {
  let state = { active: false, state: 'stopped' }, redraw = null, syncing = false;
  const N = () => window.AdarshNative;
  const supported = () => !!(N() && N().backgroundVoiceStart);
  const active = () => !!state.active || ['starting', 'permission_required'].includes(state.state);
  function apply(value) {
    if (!value || typeof value !== 'object') return state;
    if (value.type === 'reply') return state;
    state = { ...value, message: value.message || value.error || '', state: value.state || (value.ok === false ? 'error' : value.active ? 'listening' : 'stopped') };
    if (redraw) redraw();
    Bus.emit('background:state', state);
    return state;
  }
  function call(method, ...args) {
    try { return apply(JSON.parse(N()[method](...args))); }
    catch (e) { return apply({ active: false, state: 'error', message: 'Background voice nahi chala. App dobara kholo aur permissions check karo.' }); }
  }
  function start() {
    if (!supported() || !Backend.isNative()) return toast('Outside-app voice ke liye embedded Android engine chahiye.');
    if (active()) return toast('Background voice is already starting or active. Stop it first.');
    if (!$('#lock').hidden) return toast('Pehle app unlock karo.');
    if (Chat.isBusy()) return toast('Current answer complete hone do.');
    if ((S.settings.source || 'auto') !== 'auto') return toast('Background voice ko Auto source chahiye. Manual/Hybrid change nahi kiya; app mein answers paste karke use karo.');
    const c = Chat.cur() || Chat.newChat(), access = Productivity.access();
    const config = {
      chatId: c.id, mode: Modes.current().id, source: S.settings.source || 'auto', lang: S.settings.lang,
      access, history: access.currentChat ? Chat.history(c) : [],
      reply: { lang: S.settings.replyLang || 'auto', depth: S.settings.depth || 'normal', think: S.settings.think || 'fast' },
      voice: { engine: S.settings.voiceEngine || 'auto', name: S.settings.voiceName || 'Orus', deviceVoice: S.settings.deviceVoice || '', rate: S.settings.rate || 1 }
    };
    Voice.close(); STT.stop(); TTS.stop();
    const out = call('backgroundVoiceStart', JSON.stringify(config));
    if (!out.ok && out.message) toast(out.message);
    return out;
  }
  function stop(message) {
    if (!supported()) return;
    const was = active(); const out = call('backgroundVoiceStop');
    if (was && message) toast(message);
    return out;
  }
  function sync() {
    if (!supported() || syncing || !$('#lock').hidden) return;
    syncing = true;
    try {
      const rows = JSON.parse(N().backgroundVoicePeek());
      if (!Array.isArray(rows) || !rows.length) return;
      const ids = Chat.importBackground(rows);
      if (ids.length && saveNow()) {
        const ack = JSON.parse(N().backgroundVoiceAck(JSON.stringify(ids)));
        if (ack.ok && rows.length > ids.length) setTimeout(sync, 0);
      }
      Productivity.sync(); Bus.emit('records:changed');
    } catch (e) { /* Inbox is not acknowledged until UI persistence succeeds. */ }
    finally { syncing = false; }
  }
  function open() {
    if (!supported()) return toast('Background live voice Android APK mein available hai.');
    call('backgroundVoiceStatus');
    const close = sheet({ title: 'Background live voice', tall: true, build(b) {
      const draw = () => {
        b.textContent = '';
        b.append(h('p', {}, 'Start here, then use Home or another app. ADARSH keeps listening and speaking in this explicit session; the ongoing notification has Stop.'), h('p', { role: 'status', 'aria-live': 'polite' }, String(state.message || state.state || 'Stopped')),
          h('p', {}, 'Session mode: ' + (state.mode || Modes.current().name)));
        b.append(h('button', { class: 'btn ' + (active() ? 'ghost' : 'pri'), on: { click: () => active() ? stop() : start() } }, active() ? 'Stop background voice' : 'Start background voice'));
        b.append(h('p', { class: 'muted' }, 'Mic and notification permission required. Off by default; no boot restart. Up to 30 minutes per session. The mode and voice are captured at Start. Auto source only; other sources are not silently changed. Calls/messages and screen-only edits require reopening the app.'),
          h('p', { class: 'muted' }, 'Background sessions do not attach stored notes, tasks, memory or old chats as extra model context. Safe local commands can read allowed records on the phone. Current-chat history follows your sharing controls.'),
          h('p', { class: 'muted' }, 'Phone recognition may use the recognition provider online. AI/TTS use your existing configured providers. No raw recording is saved by ADARSH. Android battery restrictions and your installed recognizer can interrupt the session.'),
          h('button', { class: 'btn ghost', on: { click: () => close() } }, 'Close controls'));
      };
      redraw = draw; draw();
      const observer = new MutationObserver(() => { if (!b.isConnected) { observer.disconnect(); if (redraw === draw) redraw = null; } });
      observer.observe($('#phone'), { childList: true });
    } });
  }
  window.__adarshBackgroundVoice = value => { apply(value); if (!document.hidden) sync(); };
  function init() {
    if (!supported()) return;
    call('backgroundVoiceStatus'); sync();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { call('backgroundVoiceStatus'); sync(); } });
    Bus.on('mode:changed', () => { if (active()) stop('Mode changed. Restart background voice in the selected mode.'); });
    Bus.on('lock:unlocked', sync);
  }
  return { init, open, start, stop, sync, active, supported, status: () => state };
})();
