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

The audit lowers the chance of confident mistakes. It does not remove it: the auditor is also a language model.
For facts that matter (numbers, dates, papers), check a source.
