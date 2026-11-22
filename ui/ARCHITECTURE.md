# ADARSH UI: architecture

Frontend only. No framework, no build step needed to edit (plain scripts). `python3 build.py` inlines everything into one page (`dist/adarsh.html`).

## 1. Design idea (JARVIS-style)

One person, one assistant, many ways to talk to it, and the assistant can reach back.

| Layer | What it is | Where |
|---|---|---|
| Talk | Chat + Voice mode (orb: idle, listening, thinking, speaking) | `03-chat.js`, `05-voice.js` |
| Ask-back | AI asks **you** with a structured card, never a loose sentence | `02-render.js` (`ask`, `approve`) |
| Know | Memory (things it remembers), Today (briefing) | `04-views.js` |
| Do | Tasks and reminders, Missions (long staged jobs) | `04-views.js`, `mission` reply |
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

Always `{ "type": …, … }`. Unknown types fall back to text. Any reply may carry `steps: ["…"]` (shown folded as "Worked through N steps") and `notes: { title, items: [{ title, text }] }` (shown folded under the reply, e.g. what the falsifiers found). The request also carries `source` (`auto|manual|hybrid`), `answers` (`[{ source, text }]`, pasted from other AIs) and `reply: { lang: auto|hinglish|english|hindi, depth: simple|normal|detailed }`.

| type | fields | maps from ADARSH v6 |
|---|---|---|
| `text` | `text` (markdown-lite) | `agent.handle()` plain string |
| `research` | `question, summary, confidence 0..1, claims[{text,verdict,checks[{source,verdict,note}]}], sources[{n,title,url}], caveat` | `ResearchEngine` + `verify.py` verdicts |
| `debate` | `topic, pro, con, verdict` | `debater_pro`, `debater_con`, `moderator` |
| `patterns` | `title, patterns[{claim,strength,evidence[],so_what}]` | `pattern_finder` |
| `links` | `title, chains[{nodes[],why}]` | `connector` |
| `mission` | `id, title, status, stages[{label,status}]` | missions + `STAGE_TEMPLATES` |
| `ask` | `id, questions[{header,question,multi?,allowOther?,options[{label,description?}]}]` | new |
| `approve` | `id, title, detail, action, scope, risk: low|medium|high` | new (self-engineering, risky tools) |
| `memory` | `text` | new (UI also stores it) |
| `task` | `title, due (ms epoch)` | new (UI also stores it) |

Verdict strings (research): `SUPPORTED_BY_MULTIPLE_SOURCES, SUPPORTED_BY_ONE_SOURCE, PARTIALLY_SUPPORTED, CONTESTED, UNVERIFIED_NO_JUDGE, CONTRADICTED_BY_SOURCE, UNSUPPORTED_NO_VALID_EVIDENCE, UNSUPPORTED_UNRELATED`.

## 4. How the AI asks you things

Rule: if the AI needs a decision or missing info, it returns an `ask` or `approve` reply instead of a sentence.

* `ask`: one question per page, single or multi choice, always an "Something else" field and Skip. On submit the UI shows your answers as a message and calls `send()` again with `meta.answer`.
* `approve`: for anything that changes the world (deploy self-modification, send, delete, spend). Shows risk, exact action, scope. Allow or Deny goes back as `meta.approval`.
* In voice mode the AI speaks the question and the overlay closes so you answer on the card.
* Suggested rule for the backend: never execute a `risk: high` action without a recorded `allow`.

## 5. Pushing from the backend (proactive JARVIS)

```js
ADARSH_UI.push({type:'text', text:'Your 5 pm reminder is due.'})   // lands in the current chat (or {chatId})
ADARSH_UI.banner({title:'Mission finished', text:'Laptop comparison', onOpen:()=>ADARSH_UI.open('missions')})
ADARSH_UI.send('Brief me on today')   // type as the user
```
For real push you will want a WebSocket or SSE connection in your backend adapter that calls these.

## 6. State

`localStorage['adarsh.ui.v3']`: chats, memories, tasks, missions, settings, abilities, lock (salted PBKDF2 hash), conn. Attachment data URLs and thumbnails are never saved. Treat this as a cache: move memories/tasks/missions to your server when the architecture exists.

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

Real search, real memory recall, real reminders firing while the app is closed (needs push), file understanding, multi-device sync, streaming token output (add `onProgress`/SSE in your adapter), login (single-user token instead).

## Reply field: `council` (optional)
Backend may add `council` to the first text reply (see `council.py` for the shape). The UI then shows a "Thought for Ns" block instead of "Worked through N steps"; tapping it opens the full page (`js/03-council.js`). Live progress lines (`onProgress`) are stored as `thinkLines`. Only the newest 10 replies keep their `council`; it is left out of exports.
