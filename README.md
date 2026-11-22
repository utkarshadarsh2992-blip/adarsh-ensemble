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
- `config.py` / `.env.example`: `CHAT_ENGINE` (verified|simple), `CHAT_MODE` (deep|fast), `CORS_ORIGINS`.
- `ui/src/js/07-backend.js`: same-origin `/api/chat` default; relative URL support.
- Backend docs: `README-backend.md`. UI docs: `ui/ARCHITECTURE.md`.

## Limits
- Deep verified answer me minute lag sakte hain, aur free quota kharch hota hai. Roz ki chat ke liye `CHAT_MODE=fast`.
- Ensemble sirf text reply deta hai. UI ke `research / debate / ask / approve / mission` cards abhi backend se nahi aate; attachments ignore hote hain.
- Voice, memory, tasks UI me hi (localStorage) rehte hain.


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
