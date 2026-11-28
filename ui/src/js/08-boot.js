'use strict';
/* 08-boot.js : start-up + public UI hooks */
(function boot() {
  load();
  Mission.ensureDefaultGoal();
  Splash.start();   // startup animation over the boot (S.settings.bootAnim, AI command se)
  Productivity.init();
  App.applyTheme();
  App.buildDrawer();
  Chat.mount($('#v-chat'));
  App.drawerList();

  window.ADARSH_UI = {
    push: (r, o) => Chat.push(r, o), banner, toast, send: (t) => App.ask(t), open: (v) => App.show(v),
    on: Bus.on, version: 4
  };

  Backend.refresh();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) Backend.refresh(); });
  document.addEventListener('click', hapticTap, true);   // Settings > Haptics: small vibration on every tap
  if (window.__adarshDictation) STT.dict = window.__adarshDictation;
  try { if (window.claude && claude.use) claude.use('dictation').then(d => { STT.dict = d || STT.dict || null; }).catch(() => {}); } catch (e) {}
  if (S.lock) Lock.lockNow();
  MobileUpdates.init();
  try { Briefing.init(); } catch (e) { console.warn('briefing init', e); }   /* change 1.3 */
  try { News.init(); } catch (e) { console.warn('news init', e); }   /* change 1.5 */
  BackgroundVoice.init();
  /* Android Back: step back inside the app first; only an idle chat screen leaves the app. */
  const councilBack = window.__adarshBack;
  window.__adarshBack = () => {
    const lock = $('#lock'); if (lock && !lock.hidden) return false;
    const shades = $$('#phone > .shade'); const top = shades[shades.length - 1];
    if (top) { if (top._close) top._close(); else top.remove(); return true; }
    if (typeof councilBack === 'function' && councilBack()) return true;
    if (Voice.isOpen) { Voice.close(); return true; }
    if ($('#phone').classList.contains('open')) { App.drawer(false); return true; }
    if (App.view !== 'chat') { App.show('chat'); return true; }
    return false;
  };
})();
