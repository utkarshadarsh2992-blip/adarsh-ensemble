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
        b.append(h('p', { class: 'muted' }, 'Verified builds only · hash aur signature checked'), h('button', { class: 'btn ghost', on: { click: () => close() } }, 'Later'));
      };
      redraw = draw; draw();
      const observer = new MutationObserver(() => { if (!b.isConnected) { observer.disconnect(); if (redraw === draw) redraw = null; } });
      observer.observe($('#phone'), { childList: true });
    } });
  }
  window.__adarshUpdate = apply;
  /* Automatic update notice (Android job, every few hours with internet). The phone keeps the switch. */
  function notifyOn() { return S.settings.updateNotify !== false; }
  function setNotify(on) {
    S.settings.updateNotify = !!on; save();
    try { if (native().updateNotify) native().updateNotify(on ? 'on' : 'off'); } catch (e) {}
    return !!on;
  }
  /* Compose update taps with the Briefing/News notification router registered earlier. */
  const priorOpen = window.__adarshOpen;
  window.__adarshOpen = target => {
    if (target === 'updates') { if ($('#lock').hidden) open(); return; }
    if (typeof priorOpen === 'function') priorOpen(target);
  };
  function init() {
    if (!supported()) return;
    try { if (native().updateNotify) { const r = JSON.parse(native().updateNotify('')); if (r && typeof r.on === 'boolean') S.settings.updateNotify = r.on; } } catch (e) {}
    try { if (native().launchTarget && native().launchTarget() === 'updates') setTimeout(() => window.__adarshOpen('updates'), 0); } catch (e) {}
    call('updateStatus'); check(false);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { call('updateStatus'); check(false); } });
  }
  return { init, open, check, supported, notifyOn, setNotify, status: () => state };
})();

const BackgroundVoice = (() => {
  let state = { active: false, state: 'stopped' }, redraw = null, syncing = false, handedOff = false, notifHint = false, lastError = '';
  const N = () => window.AdarshNative;
  const supported = () => !!(N() && N().backgroundVoiceStart);
  const active = () => !!state.active || ['starting', 'permission_required'].includes(state.state);
  /* States in which the user is not mid-sentence and no reply is being prepared or spoken. */
  const QUIET = ['starting', 'listening', 'retrying'];
  function apply(value) {
    if (!value || typeof value !== 'object') return state;
    if (value.type === 'reply') return state;
    state = { ...value, message: value.message || value.error || '', state: value.state || (value.ok === false ? 'error' : value.active ? 'listening' : 'stopped') };
    if (state.state === 'error' && (value.error || value.message)) lastError = String(value.error || value.message);   // kept: the phone forgets it once the session ends
    if (redraw) redraw();
    Bus.emit('background:state', state);
    if (handedOff && !document.hidden) setTimeout(maybeResume, 0);
    return state;
  }
  function call(method, ...args) {
    try { return apply(JSON.parse(N()[method](...args))); }
    catch (e) { return apply({ active: false, state: 'error', message: 'Background voice nahi chala. App dobara kholo aur permissions check karo.' }); }
  }
  function configFor(c) {
    const access = Productivity.access();
    return {
      chatId: c ? c.id : uid('c'), mode: Modes.current().id, source: S.settings.source || 'auto', lang: S.settings.lang,
      access, history: c && access.currentChat ? Chat.history(c) : [],
      reply: { lang: S.settings.replyLang || 'auto', depth: S.settings.depth || 'normal', think: S.settings.think || 'fast', web: S.settings.webSearch === false ? 'off' : 'on', ...(S.philosophy ? { philosophy: String(S.philosophy).slice(0, 3000) } : {}) },
      voice: { engine: S.settings.voiceEngine || 'auto', name: S.settings.voiceName || 'Orus', deviceVoice: S.settings.deviceVoice || '', rate: S.settings.rate || 1 }
    };
  }
  function start() {
    if (!supported() || !Backend.isNative()) return toast('Outside-app voice ke liye embedded Android engine chahiye.');
    if (active()) return toast('Background voice is already starting or active. Stop it first.');
    if (!$('#lock').hidden) return toast('Pehle app unlock karo.');
    if (Chat.isBusy()) return toast('Current answer complete hone do.');
    if ((S.settings.source || 'auto') !== 'auto') return toast('Background voice ke liye Auto source chahiye.');
    const config = configFor(Chat.cur() || Chat.newChat());
    Voice.close(); STT.stop(); TTS.stop();
    const out = call('backgroundVoiceStart', JSON.stringify(config));
    if (!out.ok && out.message) toast(out.message);
    return out;
  }
  /* Live voice (any mode) keeps going after Back/Home/screen off: while the voice screen is open the phone holds a
     ready config, and the app starts the 30-minute background session at the moment it leaves the screen. */
  /* Any selected mode can continue outside the app (the session keeps that mode; phone actions stay Standard-only). */
  const canHandoff = () => supported() && !!N().backgroundVoiceArm && Backend.isNative() &&
    (S.settings.source || 'auto') === 'auto' && $('#lock').hidden && !active();
  function arm() {
    if (!canHandoff()) return disarm();
    try {
      const r = JSON.parse(N().backgroundVoiceArm(JSON.stringify(configFor(Chat.cur()))));
      if (r && r.armed && r.notifications === false && !notifHint) { notifHint = true; toast('App se bahar voice chalne ke liye notifications allow karo.'); }
    } catch (e) {}
  }
  function disarm() { try { if (N() && N().backgroundVoiceArm) N().backgroundVoiceArm(''); } catch (e) {} }
  /* Native started the session while the app was leaving: close the in-app screen without touching the session. */
  window.__adarshVoiceHandoff = value => {
    if (value && value.ok) { handedOff = true; lastError = ''; Voice.close({ keepBackground: true }); }
    else if (value && (value.error || value.message)) lastError = String(value.error || value.message);
    apply(value);
  };
  /* Back in the app: when the session is quiet, end it and continue the same conversation on the voice screen. */
  function maybeResume() {
    if (document.hidden || !$('#lock').hidden) return;
    if (lastError && !active()) { toast('Bahar voice ruk gayi: ' + lastError); lastError = ''; }
    if (!handedOff) return;
    if (active() && !QUIET.includes(state.state)) return;   // the user is speaking or a reply is on its way: wait for it
    handedOff = false;
    const wasActive = active();
    if (wasActive) call('backgroundVoiceStop');
    sync();
    if (wasActive) setTimeout(() => Voice.open({ listen: true }), 500);   // give the service a moment to release the mic
  }
  function stop(message) {
    if (!supported()) return;
    handedOff = false;
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
        b.append(h('p', {}, 'App ke bahar live · notification mein Stop'), h('p', { role: 'status', 'aria-live': 'polite' }, String(state.message || state.state || 'Stopped')),
          h('p', {}, 'Session mode: ' + (state.mode || Modes.current().name)));
        if (active()) b.append(h('button', { class: 'btn pri', on: { click: () => { close(); handedOff = false; call('backgroundVoiceStop'); sync(); setTimeout(() => Voice.open({ listen: true }), 500); } } }, 'App mein baat jaari rakho'),
          h('button', { class: 'btn ghost', on: { click: () => stop() } }, 'Stop background voice'));
        b.append(h('p', { class: 'muted' }, 'Back/Home par apne aap · max 30 min · Auto source'),
          h('p', { class: 'muted' }, 'Notes, tasks aur memory attach nahi hote.'),
          h('p', { class: 'muted' }, 'Recognition online ho sakta hai · recording save nahi hoti.'),
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
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { call('backgroundVoiceStatus'); sync(); maybeResume(); } });
    Bus.on('mode:changed', () => { if (active()) stop('Mode changed. Restart background voice in the selected mode.'); if (Voice.isOpen) arm(); });
    Bus.on('lock:unlocked', sync);
  }
  return { init, open, start, stop, sync, arm, disarm, active, supported, status: () => state };
})();
