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
_perr: dict[str, list[float]] = {}  # provider -> timestamps of recent network-level failures
_trace: contextvars.ContextVar = contextvars.ContextVar("trace", default=None)
_rec: contextvars.ContextVar = contextvars.ContextVar("trace_record", default=False)
_stage: contextvars.ContextVar = contextvars.ContextVar("stage", default="")
MAX_PROMPT_CHARS = 12000  # per message kept in a recorded trace


def _today() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def _fresh(learned: dict | None = None) -> dict:
    # out: quota key -> unix time a DAILY 429 said it is empty until (kept on disk, so an app restart does not
    # spend a request just to hear "quota used up" again). learned: daily caps seen in real 429s; survive the day roll.
    return {"day": _today(), "req": {}, "tok": {}, "out": {}, "learned": dict(learned or {})}


def _load() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            learned = data.get("learned") if isinstance(data.get("learned"), dict) else {}
            if data.get("day") != _today():
                return _fresh(learned)
            for k in ("req", "tok", "out"):
                data.setdefault(k, {})
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
            _usage.clear()
            _usage.update(_fresh(learned))


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
        _save()


def success(spec: ModelSpec, tokens: int) -> None:
    _streak[spec.label] = 0
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


def provider_error(provider: str) -> None:
    """Network-level failure (connect error, timeout, 408/502/503/504).
    Two within a minute = circuit breaker: skip the WHOLE provider for 60 s, so its other
    models do not each burn a timeout and the chain jumps straight to another provider."""
    now = time.time()
    recent = [t for t in _perr.get(provider, []) if now - t < 60] + [now]
    if len(recent) >= 2:
        _perr[provider] = []
        cooldown_provider(provider, 60)
    else:
        _perr[provider] = recent


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
