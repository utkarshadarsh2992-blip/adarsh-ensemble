'use strict';
/* 08-boot.js : start-up + public UI hooks */
(function boot() {
  load();
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
  if (window.__adarshDictation) STT.dict = window.__adarshDictation;
  try { if (window.claude && claude.use) claude.use('dictation').then(d => { STT.dict = d || STT.dict || null; }).catch(() => {}); } catch (e) {}
  if (S.lock) Lock.lockNow();
})();
