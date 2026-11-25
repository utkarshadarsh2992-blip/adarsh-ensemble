"""Per-model health, daily quota guard and call trace.

Why: free tiers are small (OpenRouter 50 req/day, Groq 200K tokens/day per model...).
Instead of burning retries on a model that is rate-limited or gone, we
  - put it in COOLDOWN (using Retry-After when the provider sends it),
  - stop using it once its local daily quota is (almost) used up,
  - skip providers whose API key is missing,
and the caller moves on to the next model in the chain.
Usage counters are saved to a small JSON file so a restart does not forget them.
"""
import contextvars
import datetime as dt
import json
import os
import random
import threading
import time

import config
from config import PROVIDERS, ModelSpec

STATE_FILE = os.getenv("USAGE_FILE", ".usage.json")
MARGIN = float(os.getenv("QUOTA_MARGIN", "0.95"))  # stop at 95% of a daily quota
# Helper roles (drafters, skeptic, falsifiers, debater, reviewers...) stop earlier, so the last part of every daily
# quota stays free for the calls the answer can not do without (judge, format repair, refiner: see config.CRITICAL_STAGES).
RESERVE_MARGIN = float(os.getenv("QUOTA_RESERVE_MARGIN", "0.8"))
LEARN_MIN = int(os.getenv("QUOTA_LEARN_MIN", "20"))  # a daily 429 after fewer requests than this is not learned as the cap

_cool: dict[str, float] = {}       # model label -> unix time until which it is skipped
_prov_cool: dict[str, float] = {}  # provider -> unix time (network circuit breaker: the whole server is skipped)
_key_cool: dict[str, float] = {}   # key slot ("groq", "groq#2", ...) -> unix time (401 / 402 / daily cap of ONE key)
_streak: dict[str, int] = {}       # consecutive failures per model label
_perr: dict[str, dict[int, list[float]]] = {}  # provider -> key slot -> recent network failure timestamps
_trace: contextvars.ContextVar = contextvars.ContextVar("trace", default=None)
_rec: contextvars.ContextVar = contextvars.ContextVar("trace_record", default=False)
_stage: contextvars.ContextVar = contextvars.ContextVar("stage", default="")
MAX_PROMPT_CHARS = 12000  # per message kept in a recorded trace


def _today() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


HIST_DAYS = 14  # usage screen: daily totals per provider survive the day roll this long


def _fresh(learned: dict | None = None, hist: list | None = None) -> dict:
    # out: quota key -> unix time a DAILY 429 said it is empty until (kept on disk, so an app restart does not
    # spend a request just to hear "quota used up" again). learned: daily caps seen in real 429s; survive the day roll.
    # feat: requests per app feature today (usage screen). truth: fact-check counts today. hist: earlier days' totals.
    return {"day": _today(), "req": {}, "tok": {}, "out": {}, "learned": dict(learned or {}),
            "feat": {}, "truth": {}, "hist": list(hist or [])[-HIST_DAYS:]}


def _provider_of(qkey: str) -> str:
    return qkey.split(":", 1)[0].split("#", 1)[0]


def _day_summary(data: dict) -> dict:
    """One finished day for the history: totals per provider + per feature + fact-check counts."""
    req: dict[str, int] = {}
    tok: dict[str, int] = {}
    for k, v in (data.get("req") or {}).items():
        p = _provider_of(k)
        req[p] = req.get(p, 0) + int(v or 0)
    for k, v in (data.get("tok") or {}).items():
        p = _provider_of(k)
        tok[p] = tok.get(p, 0) + int(v or 0)
    return {"day": str(data.get("day") or ""), "req": req, "tok": tok,
            "feat": dict(data.get("feat") or {}), "truth": dict(data.get("truth") or {})}


def _rolled_hist(data: dict) -> list:
    hist = [h for h in (data.get("hist") or []) if isinstance(h, dict)]
    if data.get("day") and (data.get("req") or data.get("tok")):
        hist.append(_day_summary(data))
    return hist[-HIST_DAYS:]


def _load() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            learned = data.get("learned") if isinstance(data.get("learned"), dict) else {}
            if data.get("day") != _today():
                return _fresh(learned, _rolled_hist(data))
            for k in ("req", "tok", "out", "feat", "truth"):
                if not isinstance(data.get(k), dict):
                    data[k] = {}
            if not isinstance(data.get("hist"), list):
                data["hist"] = []
            data["learned"] = learned
            return data
    except (OSError, ValueError):
        pass
    return _fresh()


_usage: dict = _load()
# The engine runs model calls from several threads (Android: one asyncio loop per request + voice / media threads), so
# every change to the usage counters and every save happens under this lock (audit H8).
_usage_lock = threading.RLock()


def _roll() -> None:
    with _usage_lock:
        if _usage.get("day") != _today():
            learned = _usage.get("learned") or {}
            hist = _rolled_hist(_usage)
            _usage.clear()
            _usage.update(_fresh(learned, hist))


def _save() -> None:
    """Atomic write (temp file + os.replace): a crash or a parallel save can not leave a half-written file."""
    with _usage_lock:
        try:
            blob = json.dumps(_usage)
        except (TypeError, ValueError, RuntimeError):
            return
        tmp = f"{STATE_FILE}.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(blob)
            os.replace(tmp, STATE_FILE)
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass


def _slot(spec: ModelSpec) -> int:
    return int(getattr(spec, "key_slot", 0) or 0)


def key_id(spec: ModelSpec) -> str:
    """Which API key a call uses: "groq" for key 1 (or an unpinned spec), "groq#2" / "groq#3" for the others."""
    n = _slot(spec)
    return spec.provider if n <= 1 else f"{spec.provider}#{n}"


def quota_key(spec: ModelSpec) -> str:
    # OpenRouter's daily limit is shared by all :free models; Groq/Gemini count per model. Every API key has its own
    # quota, so keys 2 and 3 count separately ("groq:openai/gpt-oss-120b#2"); key 1 keeps the old name.
    base = "openrouter" if spec.provider == "openrouter" else f"{spec.provider}:{spec.model}"
    n = _slot(spec)
    return base if n <= 1 else f"{base}#{n}"


def _slot_specs(spec: ModelSpec) -> list:
    """An unpinned spec stands for all of its provider's configured keys; a pinned one only for itself."""
    if _slot(spec):
        return [spec]
    slots = PROVIDERS[spec.provider].slots()
    return [config.keyed(spec, n) for n in slots] if len(slots) > 1 else [spec]


def _has_key(spec: ModelSpec) -> bool:
    prov = PROVIDERS[spec.provider]
    return bool(prov.key(_slot(spec)) if _slot(spec) else prov.api_key)


def _set_limit(spec: ModelSpec) -> int:
    """The daily request cap from config (0 = not known)."""
    return {
        "openrouter": config.OPENROUTER_RPD,
        "groq": config.GROQ_RPD,
        "gemini": config.GEMINI_RPD,
    }.get(spec.provider, 0)


def req_limit(spec: ModelSpec) -> int:
    """Config cap, else the cap learned from a real daily 429 (Gemini, NVIDIA, Cloudflare do not publish theirs)."""
    return _set_limit(spec) or int((_usage.get("learned") or {}).get(quota_key(spec), 0))


def tok_limit(spec: ModelSpec) -> int:
    return {"groq": config.GROQ_TPD}.get(spec.provider, 0)


def critical() -> bool:
    """Is the current call one the answer can not do without? (No stage set = direct call: treated as critical.)"""
    s = _stage.get() or ""
    return not s or s.startswith(config.CRITICAL_STAGES)


def used_frac(spec: ModelSpec) -> float:
    """How much of today's quota this model has used, 0..1 (0 when no cap is known). With several keys: the average
    over the keys (3 keys = 3x the quota)."""
    specs = _slot_specs(spec)
    if len(specs) > 1:
        return sum(_used_frac_one(s) for s in specs) / len(specs)
    return _used_frac_one(spec)


def _used_frac_one(spec: ModelSpec) -> float:
    _roll()
    key = quota_key(spec)
    if _usage["out"].get(key, 0) > time.time():
        return 1.0
    f = 0.0
    rl, tl = req_limit(spec), tok_limit(spec)
    if rl:
        f = max(f, _usage["req"].get(key, 0) / rl)
    if tl:
        f = max(f, _usage["tok"].get(key, 0) / tl)
    return min(f, 1.0)


def capped(spec: ModelSpec) -> bool:
    return bool(req_limit(spec) or tok_limit(spec))


def _quota_block(spec: ModelSpec, margin: float) -> str:
    key = quota_key(spec)
    if _usage["out"].get(key, 0) > time.time():
        return "daily quota used up (provider said so)"
    rl = req_limit(spec)
    if rl and _usage["req"].get(key, 0) >= rl * margin:
        return "daily request quota used up"
    tl = tok_limit(spec)
    if tl and _usage["tok"].get(key, 0) >= tl * margin:
        return "daily token quota used up"
    return ""


def available(spec: ModelSpec) -> tuple[bool, str]:
    prov = PROVIDERS[spec.provider]
    if not _has_key(spec):
        return False, f"{config.slot_env(prov.api_key_env, _slot(spec) or 1)} not set"
    now = time.time()
    if _prov_cool.get(spec.provider, 0) > now:
        return False, f"provider cooling down {int(_prov_cool[spec.provider] - now)}s"
    kid = key_id(spec)
    if _key_cool.get(kid, 0) > now:
        return False, f"key {kid} cooling down {int(_key_cool[kid] - now)}s"
    if _cool.get(spec.label, 0) > now:
        return False, f"cooling down {int(_cool[spec.label] - now)}s"
    _roll()
    why = _quota_block(spec, MARGIN)
    if why:
        return False, why
    if not critical() and min(RESERVE_MARGIN, MARGIN) < MARGIN:
        why = _quota_block(spec, RESERVE_MARGIN)
        if why:
            return False, f"last {int(round((1 - RESERVE_MARGIN) * 100))}% of today's quota kept for the judge"
    return True, ""


def pressure(chains) -> tuple[str, float]:
    """How tight today's quota is for the given role chains: ("ok" | "tight" | "low", share of quota left).
    Uses the first model of each chain (where the load goes) and only models with a known cap.
    "low" also when some role has no model left at all."""
    _roll()
    lefts, dead = [], False
    for spec in chains:
        chain = [spec] + [config.REGISTRY[label] for label in spec.fallbacks]
        live = [c for c in chain if PROVIDERS[c.provider].api_key]
        if not live:
            continue
        if all(capped(c) and used_frac(c) >= RESERVE_MARGIN for c in live):
            dead = True
        if PROVIDERS[spec.provider].api_key and capped(spec):
            lefts.append(1.0 - used_frac(spec))
    left = sum(lefts) / len(lefts) if lefts else 1.0
    if dead or left < config.QUOTA_LOW:
        return "low", left
    if left < config.QUOTA_TIGHT:
        return "tight", left
    return "ok", left


def wait_hint(specs) -> float | None:
    """Shortest remaining cooldown among models that are otherwise usable (key set, quota left)."""
    now = time.time()
    best = None
    for s in specs:
        if not _has_key(s):
            continue
        _roll()
        if _quota_block(s, MARGIN if critical() else min(RESERVE_MARGIN, MARGIN)):
            continue
        left = max(_cool.get(s.label, 0), _prov_cool.get(s.provider, 0), _key_cool.get(key_id(s), 0)) - now
        if left > 0 and (best is None or left < best):
            best = left
    return best


def note_request(spec: ModelSpec) -> None:
    """Count every HTTP attempt (providers may count failed ones too)."""
    with _usage_lock:
        _roll()
        key = quota_key(spec)
        _usage["req"][key] = _usage["req"].get(key, 0) + 1
        feat = _usage.setdefault("feat", {})
        f = feature(_stage.get())
        feat[f] = feat.get(f, 0) + 1
        _save()


def feature(stage_name: str) -> str:
    """Which app feature a model call belongs to (usage screen). Unknown stages count as council work."""
    s = (stage_name or "").split(":", 1)[0]
    named = {"standard": "standard", "briefing": "briefing", "checks": "checks", "factcheck": "factcheck",
             "guard": "guard", "voice": "voice", "tts": "voice", "news": "news", "casual": "standard"}
    if s in named:
        return named[s]
    return "council" if s else "other"


def note_truth(res: dict) -> None:
    """A finished fact-check (truth.py): today's counts for the usage screen."""
    if not isinstance(res, dict):
        return
    with _usage_lock:
        _roll()
        t = _usage.setdefault("truth", {})
        t["answers"] = t.get("answers", 0) + 1
        for v in ("ok", "shak", "galat"):
            t[v] = t.get(v, 0) + int(res.get(v) or 0)
        _save()


def success(spec: ModelSpec, tokens: int) -> None:
    _streak[spec.label] = 0
    with _usage_lock:
        _perr.pop(spec.provider, None)
    if tokens:
        with _usage_lock:
            _roll()
            key = quota_key(spec)
            _usage["tok"][key] = _usage["tok"].get(key, 0) + tokens
            _save()


def cooldown(spec: ModelSpec, seconds: float) -> None:
    _cool[spec.label] = time.time() + min(seconds, 86400)


def cooldown_provider(provider: str, seconds: float) -> None:
    _prov_cool[provider] = time.time() + min(seconds, 86400)


def cooldown_key(spec: ModelSpec, seconds: float) -> None:
    """Skip every model on THIS API key (bad key, no credits, the key's daily cap); the provider's other keys stay."""
    kid = key_id(spec)
    _key_cool[kid] = time.time() + min(seconds, 86400)


def provider_error(provider: str, key_slot: int = 0) -> None:
    """Open the network breaker only after EVERY configured key has failed recently.

    Repeated failures on key 1/2 must never hide an untouched key 3. Single-key providers
    retain their two-failure retry allowance. An omitted slot refers to the first configured key.
    """
    slots = PROVIDERS[provider].slots()
    if not slots:
        return
    slot = key_slot or slots[0]
    if slot not in slots:
        return
    now = time.time()
    with _usage_lock:
        recent = {s: [t for t in times if now - t < 60][-1:]
                  for s, times in _perr.get(provider, {}).items() if s in slots}
        recent.setdefault(slot, []).append(now)
        _perr[provider] = recent
        if all(recent.get(s) for s in slots) and sum(map(len, recent.values())) >= max(2, len(slots)):
            _perr.pop(provider, None)
            cooldown_provider(provider, 60)


def fail(spec: ModelSpec, base_seconds: float) -> None:
    """Escalating cooldown: base, 2x, 4x ... capped at 1 hour."""
    n = _streak.get(spec.label, 0) + 1
    _streak[spec.label] = n
    cooldown(spec, min(base_seconds * 2 ** (n - 1), 3600))


def rate_limited(spec: ModelSpec, wait: float | None, daily: bool = False) -> None:
    """A real 429. `wait` = how long the provider said to wait (None if it did not say), `daily` = it is the
    per-DAY quota, which waiting a minute will not fix."""
    if daily:
        secs = max(wait or 0.0, 3600.0)  # look again in an hour (one cheap call), not every few seconds
        cooldown(spec, secs)
        with _usage_lock:
            _roll()
            key = quota_key(spec)
            _usage["out"][key] = time.time() + min(secs, 86400)
            used = _usage["req"].get(key, 0)
            if not _set_limit(spec) and used >= LEARN_MIN:  # unknown cap: remember it, so next time we stop BEFORE the 429
                _usage["learned"][key] = used
            _save()
        if spec.provider == "openrouter":
            cooldown_key(spec, secs)  # one daily cap for all :free models of THIS key: every one of them is out
        return
    if wait:
        # small margin + jitter, so parallel callers do not all come back in the same second and fail together again
        cooldown(spec, wait + 1.0 + random.random() * 2.0)
        if spec.provider == "openrouter" and wait > 600:
            cooldown_key(spec, wait)  # daily cap hit: every :free model on this key is out
    else:
        fail(spec, 30)


# ------------------------------------------------------------------ our own rate limiter (before the call)
# Free tiers say "30 requests/min, 8000 tokens/min". Reacting only AFTER a 429 wastes a call, puts the model in a long
# cooldown, and a parallel panel fires 6 requests in the same second, so most of them fail. Instead every request first
# reserves a time slot in a sliding 60 s window per quota key (see quota_key):
#   slot is free now             -> send at once
#   slot frees up within max_wait -> wait for it (parallel requests get spaced out instead of fired together)
#   slot is further away          -> the caller moves on to the next model in its chain
# Slots are handed out in order (never earlier than the previous one), so it is enough to check each new request
# against the 60 s before it to keep EVERY 60 s window inside the limits.
_WINDOW = 60.0
_slots: dict[str, list[tuple[float, int]]] = {}  # key -> [(slot time, tokens)] in reservation order
_slots_lock = threading.Lock()


def reserve_slot(key: str, rpm: int, tpm: int, tokens: int, max_wait: float, now: float | None = None) -> tuple[bool, float | None]:
    """(True, seconds to wait before sending; 0.0 = now) or (False, seconds until a slot is free / None = never).
    rpm / tpm = 0 means no cap of that kind."""
    if not rpm and not tpm:
        return True, 0.0
    now = time.time() if now is None else now
    with _slots_lock:
        ev = _slots.setdefault(key, [])
        ev[:] = [e for e in ev if e[0] > now - _WINDOW]  # what left the window can not matter any more
        start = max(now, ev[-1][0]) if ev else now
        # a slot can only open up at the moment an earlier request leaves the window (+1 ms for float rounding)
        times = [start] + sorted({e[0] + _WINDOW + 0.001 for e in ev if e[0] + _WINDOW + 0.001 > start})
        for t in times:
            inside = [e for e in ev if t - _WINDOW < e[0] <= t]
            if rpm and len(inside) >= rpm:
                continue
            if tpm and sum(e[1] for e in inside) + tokens > tpm:
                continue
            if t - now > max_wait:
                return False, t - now
            ev.append((t, tokens))
            return True, t - now
    return False, None


# ------------------------------------------------------------------ trace (per request)

def start_trace(record: bool = False) -> list:
    """record=True also keeps every prompt and output (for the council view). Off by default: it is big."""
    t: list = []
    _trace.set(t)
    _rec.set(record)
    return t


def _cut(text: str, n: int) -> str:
    if len(text) <= n:
        return text
    return text[:n] + "\n…[record me yahan kaata gaya, model ko poora prompt gaya tha]"


def set_stage(name: str) -> None:
    """Label the model calls that follow (per asyncio task), e.g. "panel:logic_math", "judge"."""
    _stage.set(name)


def stage() -> str:
    """The stage of the call happening now ("" when none was set)."""
    return _stage.get()


def trace_add(asked: ModelSpec, used: ModelSpec, ok: bool, *, messages=None, output=None, secs=None, skips=None) -> None:
    t = _trace.get()
    if t is None:
        return
    e = {"role": asked.role or asked.label, "asked": asked.label, "used": used.label, "ok": ok, "stage": _stage.get()}
    if secs is not None:
        e["secs"] = round(secs, 2)
    if skips:
        e["skips"] = dict(skips)
    if _rec.get() and e["stage"] != "guard":
        if messages is not None:
            e["prompt"] = [{"role": m.get("role", ""), "content": _cut(str(m.get("content", "")), MAX_PROMPT_CHARS)} for m in messages]
        if output is not None:
            e["output"] = output
    t.append(e)


def last_call(stage: str) -> dict | None:
    for e in reversed(_trace.get() or []):
        if e.get("stage") == stage:
            return e
    return None


def summarize(trace: list) -> dict:
    out: dict[str, int] = {}
    for e in trace:
        if e["ok"]:
            out[e["used"]] = out.get(e["used"], 0) + 1
    return out


def snapshot() -> dict:
    _roll()
    now = time.time()
    cooling = {k: int(v - now) for k, v in _cool.items() if v > now}
    cooling.update({f"provider:{k}": int(v - now) for k, v in _prov_cool.items() if v > now})
    cooling.update({f"key:{k}": int(v - now) for k, v in _key_cool.items() if v > now})
    return {
        "day_utc": _usage["day"],
        "requests_today": dict(_usage["req"]),
        "tokens_today": dict(_usage["tok"]),
        "out_today": {k: int(v - now) for k, v in _usage.get("out", {}).items() if v > now},
        "learned_daily_caps": dict(_usage.get("learned", {})),
        "cooling_down": cooling,
    }


# ------------------------------------------------------------------ usage screen (change 1.4)
PROVIDER_NAMES = {"groq": "Groq", "gemini": "Gemini", "openrouter": "OpenRouter", "nvidia": "NVIDIA", "cloudflare": "Cloudflare"}
STANDARD_MODEL = "openai/gpt-oss-120b"  # Legacy fallback if no configured Standard Groq label resolves


def _selected_standard_spec():
    """Configured Standard primary, constrained to Groq; retain the legacy model as a safe fallback."""
    labels = getattr(config, "STANDARD_CHAIN_LABELS", ()) or ()
    for label in labels:
        spec = config.REGISTRY.get(config.base_label(str(label)))
        if spec and spec.provider == "groq":
            return spec
    return _spec_for("groq", STANDARD_MODEL)


def _split_qkey(qkey: str) -> tuple[str, str, int]:
    """'groq:openai/gpt-oss-120b#2' -> ('groq', 'openai/gpt-oss-120b', 2); 'openrouter#3' -> ('openrouter', '', 3)."""
    base, slot = qkey, 1
    head, sep, tail = qkey.rpartition("#")
    if sep and tail.isdigit():
        base, slot = head, int(tail)
    prov, _, model = base.partition(":")
    return prov, model, slot


def _spec_for(prov: str, model: str):
    for s in config.REGISTRY.values():
        if s.provider == prov and (not model or s.model == model):
            return s
    return None


def _minute(qkey: str, now: float) -> tuple[int, int]:
    """Requests and tokens our own limiter booked for this quota key in the last 60 s (rate-limit view)."""
    with _slots_lock:
        ev = [e for e in _slots.get(qkey, []) if now - _WINDOW < e[0]]
    return len(ev), sum(int(e[1]) for e in ev)


def limits_text(prov: str) -> str:
    stop = int(round(MARGIN * 100))
    return {
        "groq": (f"Har key alag account hai, sabki apni limit: har model {config.GROQ_RPD} req/din aur "
                 f"{config.GROQ_TPD // 1000}K tokens/din; {config.GROQ_RPM} req/min (asli 30), "
                 f"~{config.GROQ_TPM_DEFAULT // 1000}K tokens/min. {stop}% par app khud ruk kar agli key leta hai."),
        "openrouter": (f"Free models ki ek hi din ki limit: {config.OPENROUTER_RPD} req/din per key (sab :free models milke), "
                       f"{config.OPENROUTER_RPM} req/min."),
        "gemini": (f"{config.GEMINI_RPM} req/min per model. Din ki limit Google batata nahi: pehle 429 se seekh kar "
                   "yaad rakhi jaati hai."),
        "nvidia": f"{config.NVIDIA_RPM} req/min. Din ki limit pehle 429 se seekhi jaati hai.",
        "cloudflare": "Din ki limit account ke neurons par hai; 429 aaye to key 2, phir key 3.",
    }.get(prov, "")


def _model_row(prov: str, model: str, slot: int, qk: str, req: dict, tok: dict, out: dict, now: float) -> dict:
    spec = _spec_for(prov, model)
    pinned = config.keyed(spec, slot) if spec else None
    rl = req_limit(pinned) if pinned else 0
    tl = tok_limit(pinned) if pinned else 0
    r, t = int(req.get(qk, 0)), int(tok.get(qk, 0))
    out_s = max(0, int(out.get(qk, 0) - now))
    frac = 1.0 if out_s else min(1.0, max(r / rl if rl else 0.0, t / tl if tl else 0.0))
    m_req, m_tok = _minute(qk, now)
    return {
        "model": model or "sab :free models (shared)",
        "label": config.base_label(spec.label) if spec and model else "",
        "req": r, "tok": t, "req_limit": rl, "tok_limit": tl, "frac": round(frac, 3),
        "out_s": out_s, "cool_s": max(0, int(_cool.get(pinned.label, 0) - now)) if pinned else 0,
        "rpm": config.rpm_limit(pinned) if pinned else 0, "tpm": config.tpm_limit(pinned) if pinned else 0,
        "min_req": m_req, "min_tok": m_tok,
    }


def _key_state(have: bool, cool_s: int, models: list[dict]) -> str:
    if not have:
        return "nokey"
    if cool_s > 0:
        return "cool"
    capped_rows = [m for m in models if m["req_limit"] or m["tok_limit"] or m["out_s"]]
    if capped_rows and all(m["out_s"] or m["frac"] >= MARGIN for m in capped_rows):
        return "out"
    if any(m["out_s"] or m["frac"] >= RESERVE_MARGIN for m in capped_rows):
        return "low"
    return "ok"


def report() -> dict:
    """Everything the API usage screen shows, from local counters only (no network, works with zero keys)."""
    _roll()
    now = time.time()
    with _usage_lock:
        req, tok = dict(_usage["req"]), dict(_usage["tok"])
        out = dict(_usage.get("out") or {})
        feat, truth = dict(_usage.get("feat") or {}), dict(_usage.get("truth") or {})
        hist, day = list(_usage.get("hist") or []), _usage["day"]
        today = _day_summary(_usage)
    by_key: dict[tuple[str, int], dict[str, str]] = {}
    for qk in set(req) | set(tok):
        prov, model, slot = _split_qkey(qk)
        if prov in PROVIDERS:
            by_key.setdefault((prov, slot), {})[model] = qk
    providers = []
    order = [p for p in PROVIDER_NAMES if p in PROVIDERS] + [p for p in PROVIDERS if p not in PROVIDER_NAMES]
    standard_spec = _selected_standard_spec()
    for prov in order:
        set_slots = PROVIDERS[prov].slots()
        keys = []
        for slot in range(1, config.KEY_SLOTS + 1):
            have = slot in set_slots
            models = dict(by_key.get((prov, slot), {}))
            if prov == "groq" and have and standard_spec and standard_spec.model not in models:
                models[standard_spec.model] = f"groq:{standard_spec.model}" + (f"#{slot}" if slot > 1 else "")
            rows = sorted((_model_row(prov, m, slot, qk, req, tok, out, now) for m, qk in models.items()),
                          key=lambda x: (-x["req"], x["model"]))
            kid = prov if slot <= 1 else f"{prov}#{slot}"
            cool_s = max(0, int(max(_key_cool.get(kid, 0), _prov_cool.get(prov, 0)) - now))
            keys.append({"slot": slot, "set": have, "state": _key_state(have, cool_s, rows), "cool_s": cool_s,
                         "req": sum(m["req"] for m in rows), "tok": sum(m["tok"] for m in rows), "models": rows})
        providers.append({"id": prov, "name": PROVIDER_NAMES.get(prov, prov), "keys": keys,
                          "set": len(set_slots), "limits": limits_text(prov),
                          "req": sum(k["req"] for k in keys), "tok": sum(k["tok"] for k in keys)})
    std = {"state": "nokey", "left": 0.0}
    if PROVIDERS["groq"].slots() and standard_spec:
        left = 1.0 - used_frac(standard_spec)
        std = {"left": round(left, 3),
               "state": "low" if left < config.QUOTA_LOW else "tight" if left < config.QUOTA_TIGHT else "ok"}
    tomorrow = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(days=1)
    days = [{"day": h.get("day", ""), "req": sum((h.get("req") or {}).values()), "tok": sum((h.get("tok") or {}).values()),
             "by": dict(h.get("req") or {})} for h in hist[-6:] if isinstance(h, dict)]
    days.append({"day": day, "req": sum(today["req"].values()), "tok": sum(today["tok"].values()), "by": today["req"]})
    return {
        "day_utc": day,
        "reset_in_s": max(0, int(tomorrow.timestamp() - now)),
        "totals": {"req": sum(int(v) for v in req.values()), "tok": sum(int(v) for v in tok.values())},
        "providers": providers,
        "features": feat,
        "days": days,
        "truth": {k: int(truth.get(k, 0)) for k in ("answers", "ok", "shak", "galat")},
        "standard": std,
        "margin": MARGIN,
        "reserve": RESERVE_MARGIN,
    }


def controller_reports() -> list[dict]:
    """Prompt-free absolute per-day reports; historical rows expose aggregates, never invented model/key detail."""
    current = report()
    with _usage_lock:
        history = [dict(row) for row in _usage.get("hist", []) if isinstance(row, dict)]
    try:
        current_day = dt.date.fromisoformat(str(current.get("day_utc") or ""))
    except ValueError:
        current_day = dt.datetime.now(dt.timezone.utc).date()
    first_day = current_day - dt.timedelta(days=HIST_DAYS - 1)
    history_by_day = {}
    for row in history:
        try:
            hist_day = dt.date.fromisoformat(str(row.get("day") or ""))
        except ValueError:
            continue
        if first_day <= hist_day < current_day:
            history_by_day[hist_day] = row  # last stored copy wins if corrupted history repeats a date
    reports = []
    # The current day retains the precise provider/model/key-slot breakdown from health.report().
    current = dict(current)
    reports.append(current)
    for hist_day in sorted(history_by_day, reverse=True)[:HIST_DAYS - 1]:
        row = history_by_day[hist_day]
        day = hist_day.isoformat()
        req = {str(k): max(0, int(v or 0)) for k, v in (row.get("req") or {}).items() if str(k) in PROVIDERS}
        tok = {str(k): max(0, int(v or 0)) for k, v in (row.get("tok") or {}).items() if str(k) in PROVIDERS}
        providers = []
        for provider in PROVIDER_NAMES:
            if provider not in PROVIDERS:
                continue
            providers.append({"id": provider, "name": PROVIDER_NAMES[provider], "set": 0,
                              "req": req.get(provider, 0), "tok": tok.get(provider, 0), "keys": []})
        reports.append({
            "day_utc": day,
            "totals": {"req": sum(req.values()), "tok": sum(tok.values())},
            "providers": providers,
            "features": {str(k)[:60]: max(0, int(v or 0)) for k, v in (row.get("feat") or {}).items()},
            "days": [{"day": day, "req": sum(req.values()), "tok": sum(tok.values()), "by": req}],
            "truth": {k: max(0, int((row.get("truth") or {}).get(k, 0) or 0)) for k in ("answers", "ok", "shak", "galat")},
            "standard": {"state": "unknown", "left": 0.0},
            "margin": MARGIN,
            "reserve": RESERVE_MARGIN,
            "reset_in_s": 0,
        })
    return reports[:HIST_DAYS + 1]


def reset(clear_usage: bool = False) -> None:
    """Forget cooldowns (used by tests)."""
    _cool.clear()
    _prov_cool.clear()
    _key_cool.clear()
    _streak.clear()
    _perr.clear()
    with _slots_lock:
        _slots.clear()
    if clear_usage:
        with _usage_lock:
            _usage.clear()
            _usage.update(_fresh())
