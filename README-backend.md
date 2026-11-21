# Multi-Model Verified Ensemble Backend (v5)

```
[ HARD QUERY ] (+ optional: aapke paste kiye hue answers)
     |
[0] INPUT GUARD   pasted answers pe prompt-injection scan (Prompt Guard)  +  question classify
     |
[1] DIVERSE GENERATION (parallel)   source: auto | manual | hybrid
     |   logic/math . broad/research . code/edge-case . first-principles . business . planner
     v
[2] TONE-STRIPPER      polished English hatao -> raw atomic claims -> Consensus / Conflicts map
     v
[3] ADVERSARIAL VERIFICATION
     A. Popper falsifiers: conflicts + consensus pe compulsory edge-case attack
     B. Executable truth : LLM Python checks likhta hai -> sandbox mein chalte hain
     v
[4] FINAL JUDGE        code/math proof > LLM confidence
     1. Direct Core Truth . 2. Verified Mechanism [PROVEN by code]/[REASONED]/[UNVERIFIED] . 3. Trap Warning
     v
[5] CONTRACT LINTER    plain Python (no LLM): proof pass nahi hua to "[PROVEN by code]" ko [REASONED] bana deta hai
```

## Roles (capability ke hisaab se) + fail-over

Har role ka ek **primary** model aur **fallback chain** hai (`config.py`). Primary rate-limited / quota khatam / key missing / model gone ho to agla model jawab deta hai. Isi se free quota zyada chalta hai.

<!-- ROLES:START (generated from config.py) -->
| Role | Chain: primary → fallbacks (provider) | Kyun |
|---|---|---|
| panel:logic_math | gpt-oss-120b (Groq) → gemini-3.8-flash (Gemini) → nemotron-ultra (OpenRouter) → qwen3.8-27b (Groq) | fast reasoning, strict derivation |
| panel:researcher | gemini-3.8-flash (Gemini) → gpt-oss-120b (Groq) → nemotron-super-vl (OpenRouter) → gemma-4-31b-g (Gemini) | broad angle, lamba context |
| panel:coder_edge | qwen3.8-27b (Groq) → gemini-3.8-flash (Gemini) → particle-1 (OpenRouter) → gpt-oss-120b (Groq) → flint (OpenRouter) | list ka sabse strong coder (LiveCodeBench v6 90.3) |
| panel:first_principles | nemotron-ultra (OpenRouter) → gpt-oss-120b (Groq) → gemini-3.8-flash (Gemini) → gemma-4-31b-g (Gemini) | sabse bada dimaag (550B MoE), multi-step reasoning |
| panel:business | ernie-5.5-flash (OpenRouter) → gemma-4-26b-g (Gemini) → gpt-oss-20b (Groq) → gemini-3.1-flash-lite (Gemini) → ling-3.2-flash (OpenRouter) | knowledge work + deep research tuned |
| panel:planner | gemma-4-31b-g (Gemini) → gpt-oss-20b (Groq) → gemma-4-31b (OpenRouter) → gemini-3.1-flash-lite (Gemini) → nemotron-lightning (OpenRouter) | dense model, instruction following |
| falsifier1 | nemotron-ultra (OpenRouter) → qwen3.8-27b (Groq) → gemini-3.8-flash (Gemini) → gemma-4-31b-g (Gemini) | Popper falsifier, alag family |
| falsifier2 | gpt-oss-20b (Groq) → gemma-4-26b-g (Gemini) → ernie-5.5-flash (OpenRouter) → gemini-3.1-flash-lite (Gemini) | Popper falsifier, alag family |
| falsifier3 | gemma-4-31b-g (Gemini) → gpt-oss-120b (Groq) → nemotron-super-vl (OpenRouter) → gemini-3.1-flash-lite (Gemini) | Popper falsifier, alag family |
| classifier | safeguard-20b (Groq) → gemini-3.1-flash-lite (Gemini) → lfm-3-1.7b (OpenRouter) → gpt-oss-20b (Groq) | chhota classification (safeguard = policy-following classifier) |
| guard | prompt-guard-22m (Groq) → prompt-guard-86m (Groq) | injection detector, sirf Groq par hai (neeche exception dekho) |
| guard_llm | gemini-3.1-flash-lite (Gemini) → nemotron-lightning (OpenRouter) → gpt-oss-20b (Groq) | guard ka weaker fallback: normal LLM, text <text> mein wrapped |
| stripper | gemini-3.1-flash-lite (Gemini) → nemotron-lightning (OpenRouter) → gpt-oss-20b (Groq) → gemini-3.8-flash (Gemini) → ling-3.2-flash (OpenRouter) | lamba input + strict JSON, sasta |
| verifier | qwen3.8-27b (Groq) → gemini-3.8-flash (Gemini) → particle-1 (OpenRouter) → gpt-oss-120b (Groq) → flint (OpenRouter) | Python verification scripts: best coder |
| judge | gemini-3.8-flash (Gemini) → nemotron-ultra (OpenRouter) → gpt-oss-120b (Groq) → or-free-router (OpenRouter) | bada context (claims + reports + proofs) |
| synthesizer | gemini-3.8-flash (Gemini) → nemotron-ultra (OpenRouter) → gpt-oss-120b (Groq) → or-free-router (OpenRouter) | bada context |
<!-- ROLES:END -->

### Provider-level fail-over (alag provider pe fallback)

- Har role ki chain mein **teeno providers** (Groq, OpenRouter, Gemini) hain, aur **pehla fallback hamesha dusre provider par** hai. Ye startup par check hota hai: `config.PLAN_PROBLEMS` aur `/health` ka `plan_problems` (khaali = sab theek). Config badalte waqt kuch toote to warning aati hai.
- **Circuit breaker:** kisi provider se 1 minute mein 2 network/timeout/502-504 errors aaye to poora provider 60 sec ke liye skip hota hai. Uske baaki models har ek timeout nahi khaate, chain seedha dusre provider par jaati hai.
- API key missing / 401 / 402 par poora provider 1 ghante ke liye skip. OpenRouter ka daily cap bhi poore OpenRouter ko skip karata hai (uske sab `:free` models ka quota ek hi hai).
- Teeno providers ek saath down hon to `/ask` 503 deta hai.
- **Do exceptions:**
  1. `guard`: prompt-guard models sirf Groq par hain. Dono fail hon to ek normal LLM (Gemini → OpenRouter → Groq) se score liya jaata hai, chunk ko `<text>` mein wrap karke. Ye kamzor hai (LLM khud bhi bahkaya ja sakta hai), isliye report mein `via: llm-fallback` aur warning aati hai. Koi detector na mile to `unavailable` + warning (kabhi chupchaap "clean" nahi dikhata).
  2. stripper aur judge ke bade inputs Groq ke 8K tokens/min mein nahi samaate, to unke liye asal mein Gemini ↔ OpenRouter hi chalte hain. Groq tabhi lagta hai jab input chhota ho.

Bina text role ke (chat models nahi ya abhi zaroorat nahi): lyria (music), gemini live / TTS / translate (audio), recraft (image gen), rerank. `nemotron-super-vl`, `nemotron-nano-omni`, `qwen3.8-27b` image/video samajhte hain: baad mein image input jodna ho to ye use honge.

## Run

```bash
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # keys bhar do (Groq, OpenRouter, Gemini - sab free)
uvicorn main:app --reload
```

Termux: pydantic/uvicorn install mein build errors aa sakte hain. Aaye to error dekhke fix karna padega. `sympy`/`numpy` optional hain (na ho to wo checks ERROR dikhayenge).

## Use

```bash
# 1) auto: sirf question
curl -X POST http://localhost:8000/ask -H "Content-Type: application/json" -d '{"question": "2kg block 30 degree incline pe, mu=0.2, acceleration?"}'

# 2) manual: aap alag AI ke answers do
curl -X POST http://localhost:8000/ask -H "Content-Type: application/json" -d '{
  "question": "...", "source": "manual",
  "answers": [{"source": "ChatGPT", "text": "..."}, {"source": "Gemini", "text": "..."}]
}'

# 3) hybrid: aapke answers + hamare 6 models  ("source": "hybrid")
```

Fields: `source` (auto/manual/hybrid), `answers`, `engine` (`verified` / `simple`), `mode` (`deep` / `fast`), `run_code`, `guard`, `debate_rounds` (simple engine), `debug`.

Response mein: `answer`, `task_type`, `proofs_summary`, `models_used` (kaunsa model asal mein bola), `warnings` (guard flag, FAILED proofs, downgraded tags), `guard`.
`debug: true` se: drafts, claims map, falsifier reports, har Python proof, aur `model_trace` (kis role ke liye kaun fail hua aur kisne uski jagah li).

`GET /health`: keys, `plan_problems`, har role ki chain + kaun se providers, aaj ka usage, kaun cooldown mein hai.

## Free quota ka hisaab (docs se, Nov 2026)

- **Groq (per model):** 30 req/min, 1K req/din, **8K tokens/min**, 200K tokens/din. safeguard: 3 req/min, 2K tokens/min. prompt-guard: 14.4K req/din.
- **OpenRouter `:free`:** 20 req/min aur **50 req/din, sabhi free models ka milaake**. 10+ credits kharidne par 1000/din (docs ka wo hissa adhura chhapa tha, to exact threshold OpenRouter pe check karo). Agar kharida ho to `.env` mein `OPENROUTER_RPD=1000`.
- **Gemini:** docs mein limits nahi hain. Google AI Studio mein dekho aur `GEMINI_RPD` set karo.
- Mera andaza (pakka nahi): ek deep verified question mein OpenRouter pe ~3-5 requests lagte hain, to bina credits ke ~10-15 deep questions/din. `mode: fast` mein ~1 request. Groq side ~25-30 deep questions/din.
- Code lokal counter rakhta hai (`.usage.json`), 95% par us model ko skip karke agle ko deta hai. 8K tokens/min mein na fitne wali requests Groq ko bheji hi nahi jaatin.

## Seedhi baat: limits

1. Proof sirf utna sahi jitni script. LLM ki script galat ho sakti hai. Judge ko script + output dono dikhte hain.
2. Business/research/planning mein code proof nahi hota, wahan sirf falsification hai. Wo steps [REASONED]/[UNVERIFIED] rahenge.
3. **Prompt Guard ka output format docs mein nahi mila.** Parser lacheela hai (0..1 number ya benign/malicious shabd). Pehli baar `debug: true`/response ka `guard` dekho: `unparsed` aaye to format alag hai. Guard sirf flag karta hai, answer drop nahi karta.
4. **Gemma 4 ko Gemini ke OpenAI-compatible endpoint par** verify nahi kar paya. Na chale to chain khud agle (OpenRouter wale) par chali jaati hai aur us model ko 6 ghante cooldown deti hai.
5. `gpt-oss-safeguard-20b` ko classifier banaya hai (wo policy-following classifier hai, meri jaankari ke hisaab se; Groq ka page uska purpose nahi batata).
6. Model names badalte rehte hain: `config.py` ka `REGISTRY` dekho.
7. "Paid model se behtar" guarantee nahi. Apne 30-50 sawalon par single model vs ye pipeline compare karo.

## Sandbox safety

`sandbox.py`: whitelisted imports, open/exec/eval/getattr blocked, alag process, CPU/memory limit, timeout. **Personal use** ke liye theek, hardened nahi. Public expose karna ho to Docker/VM mein chalao aur `APP_API_KEY` set karo.
