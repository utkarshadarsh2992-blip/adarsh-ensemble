# ADARSH UI: architecture

Frontend only. No framework, no build step needed to edit (plain scripts). `python3 build.py` inlines everything into one page (`dist/adarsh.html`).

## 1. Design idea (Adarsh assistant style)

One person, one assistant, many ways to talk to it, and the assistant can reach back.

| Layer | What it is | Where |
|---|---|---|
| Talk | Chat + Voice mode (orb: idle, listening, thinking, speaking) | `03-chat.js`, `05-voice.js` |
| Ask-back | AI asks **you** with a structured card, never a loose sentence | `02-render.js` (`ask`, `approve`) |
| Know | Memory (things it remembers), Today (briefing) | `04-views.js` |
| Do | Tasks, Work, Reminders, Alarms & timers, Notes; Missions UI | `04-productivity.js`, `04-productivity-views.js`, `04-views.js` |
| Reach | Proactive push: `ADARSH_UI.push(...)`, banners, notifications | `08-boot.js` |
| Control | Abilities on/off, Connection, PIN lock | `04-views.js`, `06-lock.js` |

No slash commands anywhere. Your backend decides what a normal sentence means.

## 2. The seam

```
UI  --Backend.send(req, {onProgress, signal})-->  your architecture  -->  reply | reply[]
```

`req`:
```json
{ "chatId": "c…", "text": "…", "attachments": [{"name","kind","type","size","dataUrl"}],
  "history": [{"role":"user|assistant","text":"…"}], "abilities": ["research","memory", …],
  "lang": "hi-IN",
  "meta": null | {"answer": {"askId","answers":[{"header","question","answer"}],"skipped":false}}
               | {"approval": {"id","decision":"allow|deny"}} }
```

Plug in either way:

1. **In code (best):** before the scripts load, `window.ADARSH_BACKEND = { send, missionAction?, ping?, suggestions? }`.
2. **HTTP:** Settings > Connection. The app `POST`s the JSON above to your URL with `Authorization: Bearer <token>`, and expects JSON back: a reply object, an array of replies, or `{ "replies": [...] }`. A plain string response is shown as text. `POST {"ping":true}` must return 200 (used by the Test button).

Server rules: verify the token, keep your own allow-list (the Telegram `CHAT_ID` idea). The UI PIN is only a screen lock.

## 3. Reply contract (every type the UI can draw)

Always `{ "type": …, … }`. Unknown types fall back to text. Any reply may carry `steps: ["…"]` (shown folded as "Worked through N steps") and `notes: { title, items: [{ title, text }] }` (shown folded under the reply, e.g. what the falsifiers found). Progress lines may also be structured model-call events: a string starting with `\u0001call ` followed by JSON `{t: try|ok|fail|dead, stage, model, provider, why, secs, asked}`. The chat shows them in its "Model calls" panel (`03-chat.js`); unknown clients just show the raw line. Finished replies also carry `calls: [{stage, model, ok, secs, asked?, fails?}]`.

The request also carries `source` (`auto|manual|hybrid`), `answers` (`[{ source, text }]`, pasted from other AIs) and `reply: { lang: auto|hinglish|english|hindi, depth: simple|normal|detailed }`.

| type | fields | maps from ADARSH v6 |
|---|---|---|
| `text` | `text` (markdown-lite) | `agent.handle()` plain string |
| `research` | `question, summary, confidence 0..1, claims[{text,verdict,checks[{source,verdict,note}]}], sources[{n,title,url}], caveat` | `ResearchEngine` + `verify.py` verdicts |
| `debate` | `topic, pro, con, verdict` | `debater_pro`, `debater_con`, `moderator` |
| `patterns` | `title, patterns[{claim,strength,evidence[],so_what}]` | `pattern_finder` |
| `links` | `title, chains[{nodes[],why}]` | `connector` |
| `mission` | `id, title, status, stages[{label,status}]` | missions + `STAGE_TEMPLATES` |
| `ask` | `id, questions[{header,question,multi?,allowOther?,options[{label,description?}]}]` | new |
| `approve` | `id, title, detail, action, scope, risk: low|medium|high` | legacy display/follow-up only; no self-edit/delete capability |
| `memory` / `task` | legacy text / title proposals | display-only; cannot mutate local data |
| `actions` | `origin: local-rule, mode: standard, steps[{id,action,args,risk}], run` | offline Python parser, explicit allowlisted executor |
| `blocked` / `clarification` | `text` | non-executable, voice-readable local response |

Verdict strings (research): `SUPPORTED_BY_MULTIPLE_SOURCES, SUPPORTED_BY_ONE_SOURCE, PARTIALLY_SUPPORTED, CONTESTED, UNVERIFIED_NO_JUDGE, CONTRADICTED_BY_SOURCE, UNSUPPORTED_NO_VALID_EVIDENCE, UNSUPPORTED_UNRELATED`.

## 4. How the AI asks you things

Rule: if the AI needs a decision or missing info, it returns an `ask` or `approve` reply instead of a sentence.

* `ask`: one question per page, single or multi choice, always an "Something else" field and Skip. On submit the UI shows your answers as a message and calls `send()` again with `meta.answer`.
* Legacy `approve` is a display/follow-up card only. Code self-modification/deploy/delete/security commands are not capabilities. Local messages/calls use Actions' explicit confirmation before a composer/dialer opens.
* In voice mode the AI speaks the question and the overlay closes so you answer on the card.
* Suggested rule for the backend: never execute a `risk: high` action without a recorded `allow`.

## 5. Pushing from the backend (proactive Adarsh)

```js
ADARSH_UI.push({type:'text', text:'Your 5 pm reminder is due.'})   // lands in the current chat (or {chatId})
ADARSH_UI.banner({title:'Mission finished', text:'Laptop comparison', onOpen:()=>ADARSH_UI.open('missions')})
ADARSH_UI.send('Brief me on today')   // type as the user
```
For real push you will want a WebSocket or SSE connection in your backend adapter that calls these.

## 5b. Modes (v4)

The composer has a Claude-style mode menu: Standard, V, Physics, Math, Business, Coding. The list lives in `src/js/03-modes.js`
(`MODES`: id, name, icon, description, placeholder, starter prompts). Rename or edit there; nothing else changes.

* The selected id/source are captured before asynchronous attachment reads and sent on typed/voice requests. Python honours the selected mode; Standard is not promoted from classification. Other modes do not execute local commands; the user must select Standard.
* Each AI reply is tagged `uiMode` so the thread shows which mode answered. Retry uses the mode selected at that moment.
* Maths: `$…$`, `$$…$$`, `\(…\)`, `\[…\]` are drawn by `01-math.js` (fractions, roots, scripts, Greek, accents). It is a light renderer, not full TeX.
* Markdown now also draws tables, blockquotes, rules, and code blocks with a language label and Copy button.
* Demo backend (no server): each mode answers with a sample so the layouts can be previewed.

## 6. State

`localStorage['adarsh.ui.v3']`: chats, memory, productivity mirror, missions, settings/access flags, abilities, lock hash and connection. Android `ActionStore` is canonical for task/reminder/alarm/timer/note/work, with process lock, atomic replacement and retained fired records. Browser-only data uses localStorage. Migration imports only new native IDs; failures preserve the old mirror. Export uses canonical whitelist, not cache aliases (`due`, `ts`). Native import merges by ID/version, never absence-delete.

## 7. Files

```
src/index.html        markup skeleton
src/css/app.css       all styles (tokens at the top, dark default, light via data-theme)
src/js/01-core.js     helpers, icons, state, bus, toast, sheet, markdown-lite
src/js/02-render.js   one renderer per reply type
src/js/03-chat.js     chat screen, composer, send pipeline
src/js/04-views.js    shell, drawer, Today, Tasks, Missions, Memory, Abilities, Settings
src/js/05-voice.js    STT (dictation capability or Web Speech), TTS, voice overlay
src/js/06-lock.js     PIN lock
src/js/07-backend.js  demo backend, HTTP adapter, Backend facade
src/js/08-boot.js     start-up, window.ADARSH_UI
build.py              inline to dist/
```

## 8. Not built (needs your backend)

File understanding, multi-device sync, streaming token output and account login remain unimplemented here. Browser-only reminders do not fire reliably after closing the tab. Android uses AlarmManager, not a backend push service; notification/exact-alarm permission, battery restrictions and Force stop affect delivery.

## Privacy seam (Tasks + Work)

`req.access` contains booleans `localRead`, `localEdit`, `personalOnline`, `oldChats`, `currentChat`, `architecture`. Only the latter explicit settings controls decide access; models cannot turn them on. `personalOnline` and `oldChats` default off. `app_context` is an optional bounded whitelist of relevant records and snippets, never entire state, keys, PIN, env or connection credentials. Local command/result turns do not enter automatic model history; explicit record sharing is separate. Council web queries are disabled whenever private app/chat context is supplied.

`Chat.runBackend` awaits `Actions.execute` before delivering results; rendering/reloading a card never executes. Confirmation skips already-resolved safe steps. Native enforcement independently denies delete/clear/security/settings panels and derives message/call confirmation from the action, not `risk`. Safe UI setting edits are JS-only allowlisted display/voice options. `app_knowledge.py` is curated read-only facts/symbols/model-plan reference, not arbitrary source access.

Tests: `pnpm install --frozen-lockfile && pnpm test` from `ui/` (pinned dev-only jsdom), Python offline tests from repo root, then GitHub Android compile. Phone runtime behavior is not simulated by a build.

## Reply field: `council` (optional)
Backend may add `council` to the first text reply (see `council.py` for the shape). The UI then shows a "Thought for Ns" block instead of "Worked through N steps"; tapping it opens the full page (`js/03-council.js`). Live progress lines (`onProgress`) are stored as `thinkLines`. Only the newest 10 replies keep their `council`; it is left out of exports.


## Android update and outside-app voice seam

`05-mobile.js` exposes user controls only, never AI actions. `MobileUpdates` calls native updateStatus/updateCheck/updateDownload/updateInstall; `window.__adarshUpdate(object)` paints state. Boot checks are throttled, available builds show Update now/Later, download and installer requests require button clicks. The native manager validates a fixed public repository's published metadata, private APK cache and installed signing identity. No GitHub credential or app state is sent. CI publishes metadata and APK only as a complete successful release, with version and stale-build gates.

`BackgroundVoice` uses native backgroundVoiceStart/Stop/Status/Peek/Ack plus `window.__adarshBackgroundVoice(object)`. It starts only from a visible app and snapshots selected mode, Auto source, bounded current history and existing access/voice/reply settings. It never changes Manual/Hybrid to Auto. Settings/mode/source/PIN-lock/chat/dictation transitions stop active and permission-pending sessions. Permissions resume only after Activity RESUMED; cancellation uses Activity generation and native launch epoch. Reply events trigger inbox sync, never overwrite active status. The microphone/media foreground service owns recognition, Engine requests and existing speech fallbacks without requiring Activity/WebView execution. Stored personal records/old-chat model context is omitted in background; permitted native local commands remain available. The ongoing notification exposes Stop; there is no sticky/boot restart.

Native inbox entries contain `{id,chatId,text,reply,mode,ts,localOnly,personalContext}`. Peek does not consume; `Chat.importBackground` deduplicates IDs and imports display-only results. `saveNow()` must succeed before Ack removes native inbox entries. No Actions.execute happens on import, callback, reload or resume. Local-only turns stay out of automatic history; online permission flags still govern context. Browser/demo/HTTP transports do not implement background Android capture. Real-phone mic/notification/audio tests remain separate from CI compilation.
