# ADARSH + Ensemble (merged)

UI (`ui/`) + verified multi-model backend (root) ek hi server me.

```
Browser/phone  ->  GET /          ADARSH UI (ui/dist/adarsh.html)
               ->  POST /api/chat  chat_adapter.py  ->  pipeline.run()  ->  reply[]
               ->  POST /ask       purana ensemble API (same as v5)
               ->  GET  /health
```

## Run
```bash
pip install -r requirements.txt
cp .env.example .env     # keys + APP_API_KEY bharo
python3 ui/build.py      # UI rebuild (dist/ already built hai)
uvicorn main:app --host 0.0.0.0 --port 8000
```
Browser me `http://<host>:8000/` kholo. Same server se khulne par UI khud `/api/chat` use karti hai.
`APP_API_KEY` set hai to UI me Settings > Connection > Secret token me wahi daalo (Bearer token ya `X-API-Key`, dono chalte hain).
UI kisi aur jagah host ki ho to Connection URL = `https://<server>/api/chat`.

## Kya badla
- `chat_adapter.py` (new): UI request -> `pipeline.run` -> text reply. Chat history ka chhota tail context ke liye jaata hai. `steps` me task type, models used, latency dikhte hain.
- `main.py`: `/api/chat`, `/` (UI), CORS, Bearer auth (X-API-Key bhi). `/ask` jaisa tha waisa.
- `config.py` / `.env.example`: `CHAT_ENGINE` (roles|verified|simple, default roles), `CHAT_MODE` (deep|fast), `CORS_ORIGINS`.
- `ui/src/js/07-backend.js`: same-origin `/api/chat` default; relative URL support.
- Backend docs: `README-backend.md`. UI docs: `ui/ARCHITECTURE.md`.

## Limits
- Deep verified answer me minute lag sakte hain, aur free quota kharch hota hai. Roz ki chat ke liye `CHAT_MODE=fast`.
- Ensemble sirf text reply deta hai. UI ke `research / debate / ask / approve / mission` cards abhi backend se nahi aate; attachments ignore hote hain.
- Voice, memory, tasks UI me hi (localStorage) rehte hain.


## 11-role engine (default: `CHAT_ENGINE=roles`)

Files: `role_prompts.py` (COMMON + har role ka prompt + mode hint, `adarsh-role-prompts.md` se), `roles.py` (flow), `research.py` (web lookup).

| Step | Role | Fast | Deep |
|---|---|---|---|
| 1 | Architect: sawaal ko parts me todta hai, `SEARCH:` line me web queries deta hai | haan | haan |
| 2 | Research: Wikipedia (bina key) + Tavily (agar `TAVILY_API_KEY`), sources `[S1]..[Sn]` | haan | haan |
| 3 | Drafters: Theorist + Empiricist (+ mode specialist: physics/math/business/coding/verified) | 2 | 3 |
| 4 | Claim stripper + Skeptic (+ Pattern Finder) saath me | haan | haan (+PF) |
| 5 | Falsifiers (Skeptic ke shak leads ki tarah) | 2 | 3 |
| 6 | Debater: sirf factual takraav ya BROKEN/WEAKENED claim par; Python proofs saath me | 1 round | 2 round tak |
| 7 | Judge (mode ka format + `CONFIDENCE:` line, sirf diye gaye `[S#]` cite kar sakta hai) | haan | haan |
| 8 | Reviewers: Methodology + Evidence | ek (task ke hisaab se) | dono |
| 9 | Refiner: sirf high/medium galtiyan; section kho de to rewrite fenk diya jaata hai | zaroorat par | zaroorat par |

Mode: UI ka mode (Standard/V/Physics/Math/Business/Coding) mode hint chunta hai; Standard me task type se (math, science->physics, coding, business, research->verified). Final jawab ke neeche cited sources ke links aate hain, council page par "11-role council" section me plan, queries, sources, Skeptic, debate, reviews aur refiner badlav dikhte hain. Galat `[S#]` cite hata diye jaate hain.

Calls: fast ~11-13, deep ~15-17 model calls per sawaal (OpenRouter ki 50/din limit dhyan me rakho). Switches (0 = band): `RESEARCH`, `REVIEW`, `DEBATE`, `RESEARCH_TIMEOUT_S`, `ROLE_MAX_TOKENS`. Purana engine chahiye to `CHAT_ENGINE=verified`.

## Har mode ka alag model combo (`mode_plans.py`)

Chat ke 6 modes (Standard, V, Physics, Math, Business, Coding) ab sirf prompt hint nahi badalte. Har mode ka **apna model
combination** hai (kaunsa model kaunsa role karega) aur **apna behaviour** (kitni jaanch). Ek mode badlo, baaki par asar nahi.
Standard ab sirf 1 quick model call hai (neeche "Standard mode = instant answer"). Council plan wale modes: V, Physics, Math, Business, Coding.
Model choice models ki jaani-maani strengths aur free quotas par based judgement hai, benchmark nahi.
Har chain `config.check_chains` se check hoti hai (teeno core providers, pehla fallback doosre provider par, koi model do baar nahi).
Quota kam ho to "always" wale extras (specialist, pattern finder, 3rd falsifier, always-debate) apne aap band ho jaate hain.

| Role | Standard | V (verified) | Physics | Math | Business | Coding |
|---|---|---|---|---|---|---|
| architect | gemini-3.1-flash-lite | gemma-4-31b-g | gemma-4-31b-g | gpt-oss-20b | gemini-3.1-flash-lite | gemma-4-31b-g |
| theorist | gpt-oss-20b | gpt-oss-120b | gpt-oss-120b | gpt-oss-120b | gpt-oss-120b | gpt-oss-120b |
| empiricist | gemma-4-26b-g | qwen3.8-27b | gemini-3.8-flash | qwen3.8-27b | gemini-3.8-flash | qwen3.8-27b |
| specialist | gemini-3.8-flash | nemotron-ultra | nemotron-ultra | nemotron-ultra | mistral-large-4 | glm-5-3-flash |
| pattern | mistral-large-4 | mistral-large-4 | mistral-large-4 | gemini-3.5-flash-lite | nemotron-ultra | mistral-large-4 |
| skeptic | gemini-2.5-flash-lite | gpt-oss-20b | gpt-oss-20b | gemini-3.1-flash-lite | gpt-oss-20b | gpt-oss-20b |
| debater | gpt-oss-120b | gpt-oss-120b | gpt-oss-120b | gpt-oss-120b | gpt-oss-120b | gpt-oss-120b |
| judge | gemini-3.8-flash | gemini-3.8-flash | gemini-3.8-flash | gemini-3.8-flash | gemini-3.8-flash | gemini-3.8-flash |
| method | qwen3.8-27b | qwen3.8-27b | qwen3.8-27b | qwen3.8-27b | qwen3.8-27b | qwen3.8-27b |
| evidence | gpt-oss-120b | gpt-oss-120b | gpt-oss-120b | gpt-oss-20b | gpt-oss-120b | gpt-oss-120b |
| refiner | gemini-3.5-flash-lite | mistral-large-4 | gemini-3.8-flash | gemini-3.8-flash | gemini-3.8-flash | gemini-3.8-flash |
| falsifiers | gpt-oss-120b, gemma-4-31b-g, nemotron-ultra | gemma-4-31b-g, ernie-5.5-flash, glm-5-3-flash | qwen3.8-27b, gemma-4-31b-g, glm-5-3-flash | nemotron-ultra, gpt-oss-20b, glm-5-3-flash | qwen3.8-27b, gemma-4-31b-g, glm-5-3-flash | qwen3.8-27b, laguna-xs-2.1, gemma-4-26b-g |

| Behaviour | Standard | V (verified) | Physics | Math | Business | Coding |
|---|---|---|---|---|---|---|
| depth | inherit | deep | inherit | inherit | inherit | inherit |
| falsifiers fast / deep | 1 / 2 | 3 / 3 | 2 / 3 | 2 / 3 | 2 / 3 | 2 / 3 |
| specialist | deep | always | deep | deep | always | always |
| pattern finder | deep | always | deep | always | deep | deep |
| debate | conflict | always | conflict | conflict | conflict | conflict |
| reviewers fast / deep | evidence / method+evidence | method+evidence / method+evidence | method / method+evidence | method / method+evidence | evidence / evidence+method | method / method+evidence |
| research | auto (max 3) | must (max 6) | auto (max 4) | auto (max 2) | must (max 6) | auto (max 3) |
| code proofs | task | always | always | always | never | always |

Mode-specific rules bhi judge / falsifier / reviewer prompts me jaate hain (jaise Physics: units + limiting cases, Business: har number ka [S#] ya (assumption), Coding: edge-case inputs). Council page par "<mode> mode ka model combo" fold me poora plan dikhta hai.

## Chat UI: "Model calls" toggle

Chat screen ke top-right corner me ek chhota icon (pulse line) hai. Woh on ho to sawaal bhejte hi composer ke upar ek chhota panel khulta hai jo har model call dikhata hai: kaunsa role, kaunsa model, kitna time laga, aur jo fail hua uska reason (jaise "daily token quota used up"). Header par "N calls · 1 chal raha · 2 fail" bhi dikhta hai. Jawab aane ke baad wahi list us jawab ke neeche "Model calls: N" me folded rehti hai, aur chat me save rehti hai. Toggle band karne par panel aur lists chhup jaate hain (data save rehta hai).

Kaise: engine har model call par ek structured line bhejta hai (`config.emit_call`, prefix `\u0001call `), jo Android bridge se seedha JS tak jaati hai (`ui/src/js/03-chat.js`). HTTP backend live lines nahi bhej sakta, isliye wahan jawab ke saath `calls` list aati hai (`pipeline._compact_calls`) aur wahi panel bharta hai.

## App status "Offline" fix

Android par Python engine app khulne ke kuch second baad start hota hai. Pehle UI sirf ek baar ping karta tha, isliye status "Offline" par atak jaata tha. Ab UI engine ready hone tak har 1.5s puchhta hai ("Starting…"), app par wapas aane par aur status par tap karne par dobara check karta hai, koi bhi reply aate hi "Connected" dikhata hai, aur alag se "No API keys" / "Engine error" batata hai.

## Quota bachao (automatic)

Free quota (Groq 200K tokens/din per model, OpenRouter 50 req/din sab free models milake) jaldi khatam na ho, isliye pehle se maujood per-minute slots, daily caps, 429 cooldown aur fallback ke upar ye aur hai (`health.py`, `llm.balance`, `roles.py`):

| Kya | Kaise | Knob |
|---|---|---|
| Judge ka reserve | Helper roles kisi model ka daily quota 80% tak hi use karte hain; aakhri 20% Judge, format repair, Refiner, Architect, classifier ke liye | `QUOTA_RESERVE_MARGIN=0.8` |
| Load balance | Helper role ki chain me jo model 60% quota kha chuka, wo peeche chala jaata hai, taaki ek hi model (jaise gpt-oss-120b) dopahar tak khatam na ho | `QUOTA_BALANCE_AT=0.6` (0 = band) |
| Daily cap seekhna | Gemini/NVIDIA/Cloudflare apni daily limit nahi batate. Pehla daily 429 aate hi us din ki ginti cap ban jaati hai (`USAGE_FILE` me, din badalne par bhi yaad), agli baar 429 se pehle ruk jaata hai | `QUOTA_LEARN_MIN=20` |
| Restart yaad | Daily 429 wala model file me "khatam" likha jaata hai, app restart par dobara request barbaad nahi hoti | — |
| Apne aap halka | Pehle model ka quota ~35% se kam bacha to deep -> fast; ~15% se kam ya kisi role ka koi model na bacha to Debater + Reviewers/Refiner band. Jawab me note aata hai | `QUOTA_TIGHT`, `QUOTA_LOW`, `QUOTA_AUTO=0` se band |

API ke `debug=true` jawab ke `usage` me `learned_daily_caps` aur `out_today` dikhte hain. Galat cap seekh liya ho to `USAGE_FILE` (default `.usage.json`, APK me app data ka `usage.json`) delete kar do.

## Answer quality passes (verified engine)
1. **Format repair.** The judge must write fixed section headings (`Direct Core Truth / Verified Mechanism / Trap Warning`,
   or `Short answer / Explanation / Common mistake` for concept questions). If any is missing, the judge is asked again
   (attempt 2 on another model) before anything is shown. `MAX_REPAIRS=2`. If it still fails, the user sees a plain
   "Format check failed" note, never a silently broken answer.
2. **Audit + revise.** A different model family (`config.AUDITOR`, Groq gpt-oss-120b first) fact-checks the final answer: wrong
   exact figures, compute vs memory vs IO claims, absolutes, category errors, ignored limitations, wrong attributions.
   High/medium-confidence errors are fixed by one rewrite; low-confidence ones, and any whose quote is not found in the answer,
   are listed as "Audit ko shak hai, khud check karo". A rewrite that loses its sections is discarded. `AUDIT=0` turns it off.
3. **Wording rules.** Falsifiers get a red-flag checklist; judges must avoid absolutes, write exact figures only when sure,
   and state the main limit of whatever they describe.

4. **Choice vs fact conflicts.** The tone-stripper tags each conflict `factual` or `choice` (house size, colours, names the question did
   not fix). Falsifiers get only the factual ones, so they stop spending tokens on opinion differences; judges pick a labelled default
   for choices instead of treating them as errors.
5. **Freshness rule.** The models and the engine have no internet. Panel, judges, falsifiers and auditor are told never to claim
   "latest / current / as of <date>" for versions, prices or rankings from memory (say "version X, check the current one"), and
   `verified.freshness_warning` adds a note to the answer if such a claim still appears. It can only flag, not look the version up.

The audit lowers the chance of confident mistakes. It does not remove it: the auditor is also a language model.
For facts that matter (numbers, dates, papers), check a source.

## Manual mode: master answer + lessons
Manual (pasted answers only) no longer runs the panel. `master.py` builds ONE answer from the pasted answers and nothing else:
claims are stripped from each answer, one writer produces 7 fixed sections (Concept kya hai / Kisne socha / Kaise socha / Kya trigger hua /
First principle se / Patterns aur connections / Gaps aur takraav), every statement carries source tags like `[A]` or `[A,C]`, anything the
answers do not state is written as "Paste kiye answers me nahi hai.". Then: format repair (missing heading = re-ask), invalid tag
letters removed, a grounding check by a different model family ("does a pasted answer support this?", not "is it true?"), one rewrite
for unsupported / invented / mis-tagged statements (dropped if it loses sections). Auto and Hybrid do not use this path.
`MASTER=0` / `GROUND=0` turn the engine / the grounding check off.
Manual mode saves the Gemini / Groq free quotas: the master writer (and its repair / rewrite) starts on NVIDIA
(`config.MASTER_WRITER`, mistral-large-4) and the grounding check on Cloudflare (`config.MASTER_AUDITOR`, gpt-oss-120b, the only
Cloudflare ID confirmed in its docs). A missing key, a wrong ID (404) or a used-up quota moves the chain to Gemini / Groq by itself.
The rewrite gets the language hint without the reader profile, and the grounding check sees shorter raw answers (the claims list
covers the rest). Auto still uses `SYNTHESIZER` / `AUDITOR` unchanged.

**Learning loop (`lessons.py`).** No model weights change. Rules are stored in a small JSON file and put into the next master prompt
(top 8, the user's own first). Sources: (1) thumbs-down on a master answer asks "Kya galat tha?" and stores your line as a rule;
(2) automatic: when a check catches a known kind of mistake (missing section, unsupported statement, invented name/year/story, wrong tag,
bad tag letter, no tags, hidden contradiction) a fixed rule for that kind is created. A rule that is broken again gains weight, one that
holds fades out when the list (max 30) is full. Settings > Lessons lists, edits and deletes them. Thumbs-up marks the rules in that
answer's prompt as "held".

## Providers
Groq, OpenRouter, Gemini (core: har role ki chain me teeno) aur optional Cloudflare Workers AI, NVIDIA NIM (extra fallback; key na ho to skip). Cloudflare ko `CLOUDFLARE_API_TOKEN` aur `CLOUDFLARE_ACCOUNT_ID` dono chahiye. `bge-m3` embedding model hai, chat me use nahi hota. Cloudflare ke neurons token nahi hote, isliye local cap nahi: asli 429 aane par chain aage badhti hai.
Model IDs jo docs me confirm nahi hue (NVIDIA ke teen, OpenRouter ka inkling, Cloudflare ka gemma) best guess hain. Galat ID par 404 aata hai, model 6 ghante ke liye skip hota hai aur agla model jawab deta hai. Android me Test connection sahi ID suggest karta hai.

## Council record
`pipeline.run(..., record=True)` har model call ka stage, prompt, output, time, fallback/skip reasons rakhta hai aur `out["council"]` banata hai (`council.py`): drafts, claims map, patterns, falsifiers, proofs, judge ka pehla jawab, repair log, audit before/after, draft->final provenance (shabd-milan se andaaza). Default off (bada hota hai); chat adapter on rakhta hai.


## Standard mode = instant answer

Standard mode no longer runs the council. It makes **one** call (`config.QUICK`: gpt-oss-120b on Groq, then
gemini-3.1-flash-lite, nemotron-lightning, gpt-oss-20b, gemini-3.8-flash) with a short, direct, confident prompt.
Reply style > Depth still applies (simple / normal / detailed). If every model in that chain fails, it falls back to the
full pipeline. For checked answers pick Verified, Physics, Math, Business or Coding. `STANDARD_QUICK=0` brings the old
behaviour back.

Settings > Reply style > **Council** (Fast / Deep) now really switches the council size for those modes (`reply.think`);
before, only the `CHAT_MODE` env var did.

## Voice engine (speaks in voice mode, read-aloud and "Speak replies")

The Android WebView has no `speechSynthesis`, so the app never spoke. Now:

| Layer | What it does |
|---|---|
| `voice.py` | Natural voice: Gemini TTS (`generateContent`, `responseModalities: AUDIO`) makes a 24 kHz WAV. Models in `TTS_MODELS` are tried in order; a missing model is skipped, a 429 rests it. Groq Orpheus is the English-only fallback. Clips are cached by text+voice. Request: `{"tts": {"text", "voice"}}` |
| `Speaker.kt` | Plays the WAV (MediaPlayer, audio focus, speed) and also runs Android **TextToSpeech** with the best installed voice (hi-IN for Devanagari, en-IN for Hinglish), slightly lower pitch for a calmer, confident tone |
| `05-voice.js` | Cleans the text for speaking (no markdown, links, [S1], code, confidence line). Voice mode speaks the "Short answer" part. First sentence and the rest are fetched in parallel so the voice starts fast. Natural voice fails or is slow (>15 s) -> phone voice at once, so it never goes silent |

Settings > Voice & language: engine (Auto / Natural / Phone), 10 natural voices (Kore = firm, confident is the default),
language, speed, Test voice. Voice mode sends `meta.voice`, so Standard answers come back short and speakable.

## Settings audit (what was broken, what changed)

| Setting | Before | Now |
|---|---|---|
| Notifications | `window.Notification` does not exist in the WebView: never fired | App posts the notification itself (`setNotify`, channel "Replies") when a reply arrives while the app is hidden; asks for permission when switched on |
| Haptics | `navigator.vibrate` is ignored in the WebView | Native `performHapticFeedback` through the bridge |
| Import data, attach file / image | No `WebChromeClient.onShowFileChooser`: tapping did nothing | File chooser added (multi-select, .json files not greyed out) |
| Export / Copy | `navigator.clipboard` often fails in the WebView | Native clipboard; Export also has **Save as file** (system save dialog) and **Share** |
| Connection | Showed "This server (/api/chat)" although the on-device engine is always used | Shows **On-device engine**: engine state, providers with keys, natural voice status, plan check, Test connection |
| Voice & language | Test voice and read-aloud hidden (no speech output) | New voice engine (above) |
| Reply style | No way to choose council size | Fast / Deep council switch |

## V6 offline neural voice (fallback layer)

Existing voice is unchanged: Gemini TTS, then Groq Orpheus, then the phone's own voice. V6 only adds an offline neural step.

- **Android:** `VoiceManager.kt`, `NeuralTTS.kt`, `AudioPlayer.kt` run Piper voices (Hindi `rohan`, English `ryan`, both male, int8, ~21 MB each) through sherpa-onnx. Settings > Voice shows "Download offline voice" (one time). Order in the app: natural voice, offline neural, phone voice. Sentences are generated one by one, so playback starts early. Pause, resume and stop are supported.
- **Python backend (`voice_v6/`):** language detector (Devanagari, Roman Hindi), text normalizer (numbers, symbols), Hinglish processor (sentences, spans), speech queue (duplicate prevention, interrupt), router with dead-provider cool-down, and a protocol `{"tts": {"v6": "plan|chunk|control|status|install"}}`. `voice.synth()` falls back to local Piper when `PIPER_DIR` has the models and the `piper-tts` package exists. Nothing paid is required.
- Benchmarks (6-core sandbox): Piper RTF 0.04-0.05 (first audio about 0.15 s); sherpa int8 RTF about 0.3; Kokoro RTF 0.58, English only, so not chosen.

## Standard mode = Jarvis (in-app actions)

Standard mode can now *do* things inside the app, not only answer. The engine plans, the phone executes.

- **Local rule parser** (`actions/`): Hindi, Hinglish and English commands, no model call, no network. Reminders, alarms, timers, notes, opening apps, web search, phone status, calendar, voice mode. Multi-step ("reminder lagao aur note bhi bana do") runs up to 3 steps with per-step results, including partial failures.
- **Execution** (`ActionRunner.kt`, `ActionStore.kt`): reminders/alarms/timers via `AlarmManager` + notification, re-armed after a reboot; notes in app-private JSON; apps, search, calendar, message draft and dialer via intents. `note.clear` and anything sensitive needs a tap first.
- **Risk levels**: `safe` runs immediately; `confirm` (message, call, settings, DND) and `destructive` never run without the user's tap — enforced on the Kotlin side too, not only in the UI.
- **Jarvis feel**: "Ji Sir" acknowledgements, a small HUD orb while work runs, a per-step card, and a spoken result. Only in Standard mode; toggle in Settings > Jarvis.
- **Privacy**: commands never leave the device (no model sees them), no analytics, no new server, keys stay encrypted. Wi-Fi/Bluetooth cannot be toggled by an app on Android 10+; those commands open the system panel instead of pretending.
- **Voice mode does the same work**: tap the orb and say "kal 5 baje paani peene ka reminder lagao" or "task set karo 10 minute baad". The card is created, the phone executes, and Jarvis speaks the *result* (not the plan) before listening again. Sensitive steps are confirmed by voice: it asks, you say "haan" or "nahi". Notification access is requested automatically the first time a reminder is scheduled.
- **Phone voice is selectable**: Settings > Voice & language > Phone voice lists the system TTS voices with their gender; tapping one speaks a sample. The picker falls back to a male voice when the engine's default is female. Default natural voice is `Orus` (male) so the Jarvis persona stays consistent across natural, offline and phone voices.
- **Wording**: "task", "kaam", "to-do", "reminder" and "mujhe notification bhej dena" all reach the same reminder path when a time is present; without a time they become a note (a to-do).
