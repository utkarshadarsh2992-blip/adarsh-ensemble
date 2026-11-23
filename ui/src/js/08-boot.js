'use strict';
/* 08-boot.js : start-up + the public hook object your backend can use to push things into the UI */
(function boot() {
  load();
  App.applyTheme();
  App.buildDrawer();
  Chat.mount($('#v-chat'));
  App.drawerList();

  /* Public surface for the architecture you add later:
       ADARSH_UI.push(reply[, {chatId}])  deliver an AI message (proactive alert, finished mission, question) into a chat
       ADARSH_UI.banner({title,text,onOpen}) top banner;  ADARSH_UI.toast(msg);  ADARSH_UI.send(text) type as the user */
  window.ADARSH_UI = {
    push: (r, o) => Chat.push(r, o), banner, toast, send: (t) => App.ask(t), open: (v) => App.show(v),
    on: Bus.on, version: 3
  };

  Backend.refresh();

  if (window.__adarshDictation) STT.dict = window.__adarshDictation;  // Android app: native SpeechRecognizer
  /* platform dictation (Chromium tabs / desktop app); Web Speech is the fallback inside STT */
  try { if (window.claude && claude.use) claude.use('dictation').then(d => { STT.dict = d || STT.dict || null; }).catch(() => {}); } catch (e) {}

  if (S.lock) Lock.lockNow();
})();
