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
import time

import config
from config import PROVIDERS, ModelSpec

STATE_FILE = os.getenv("USAGE_FILE", ".usage.json")
MARGIN = float(os.getenv("QUOTA_MARGIN", "0.95"))  # stop at 95% of a daily quota

_cool: dict[str, float] = {}       # model label -> unix time until which it is skipped
_prov_cool: dict[str, float] = {}  # provider -> unix time
_streak: dict[str, int] = {}       # consecutive failures per model label
_perr: dict[str, list[float]] = {}  # provider -> timestamps of recent network-level failures
_trace: contextvars.ContextVar = contextvars.ContextVar("trace", default=None)
_rec: contextvars.ContextVar = contextvars.ContextVar("trace_record", default=False)
_stage: contextvars.ContextVar = contextvars.ContextVar("stage", default="")
MAX_PROMPT_CHARS = 12000  # per message kept in a recorded trace


def _today() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def _fresh() -> dict:
    return {"day": _today(), "req": {}, "tok": {}}


def _load() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("day") == _today():
            data.setdefault("req", {})
            data.setdefault("tok", {})
            return data
    except (OSError, ValueError):
        pass
    return _fresh()


_usage: dict = _load()


def _roll() -> None:
    if _usage.get("day") != _today():
        _usage.clear()
        _usage.update(_fresh())


def _save() -> None:
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(_usage, f)
    except OSError:
        pass


def quota_key(spec: ModelSpec) -> str:
    # OpenRouter's daily limit is shared by all :free models; Groq/Gemini count per model.
    return "openrouter" if spec.provider == "openrouter" else f"{spec.provider}:{spec.model}"


def req_limit(spec: ModelSpec) -> int:
    return {
        "openrouter": config.OPENROUTER_RPD,
        "groq": config.GROQ_RPD,
        "gemini": config.GEMINI_RPD,
    }.get(spec.provider, 0)


def tok_limit(spec: ModelSpec) -> int:
    return {"groq": config.GROQ_TPD}.get(spec.provider, 0)


def available(spec: ModelSpec) -> tuple[bool, str]:
    prov = PROVIDERS[spec.provider]
    if not prov.api_key:
        return False, f"{prov.api_key_env} not set"
    now = time.time()
    if _prov_cool.get(spec.provider, 0) > now:
        return False, f"provider cooling down {int(_prov_cool[spec.provider] - now)}s"
    if _cool.get(spec.label, 0) > now:
        return False, f"cooling down {int(_cool[spec.label] - now)}s"
    _roll()
    key = quota_key(spec)
    rl = req_limit(spec)
    if rl and _usage["req"].get(key, 0) >= rl * MARGIN:
        return False, "daily request quota used up"
    tl = tok_limit(spec)
    if tl and _usage["tok"].get(key, 0) >= tl * MARGIN:
        return False, "daily token quota used up"
    return True, ""


def wait_hint(specs) -> float | None:
    """Shortest remaining cooldown among models that are otherwise usable (key set, quota left)."""
    now = time.time()
    best = None
    for s in specs:
        if not PROVIDERS[s.provider].api_key:
            continue
        _roll()
        key = quota_key(s)
        rl, tl = req_limit(s), tok_limit(s)
        if (rl and _usage["req"].get(key, 0) >= rl * MARGIN) or (
            tl and _usage["tok"].get(key, 0) >= tl * MARGIN
        ):
            continue
        left = max(_cool.get(s.label, 0), _prov_cool.get(s.provider, 0)) - now
        if left > 0 and (best is None or left < best):
            best = left
    return best


def note_request(spec: ModelSpec) -> None:
    """Count every HTTP attempt (providers may count failed ones too)."""
    _roll()
    key = quota_key(spec)
    _usage["req"][key] = _usage["req"].get(key, 0) + 1
    _save()


def success(spec: ModelSpec, tokens: int) -> None:
    _streak[spec.label] = 0
    _perr.pop(spec.provider, None)
    if tokens:
        _roll()
        key = quota_key(spec)
        _usage["tok"][key] = _usage["tok"].get(key, 0) + tokens
        _save()


def cooldown(spec: ModelSpec, seconds: float) -> None:
    _cool[spec.label] = time.time() + min(seconds, 86400)


def cooldown_provider(provider: str, seconds: float) -> None:
    _prov_cool[provider] = time.time() + min(seconds, 86400)


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


def rate_limited(spec: ModelSpec, wait: float | None) -> None:
    if wait:
        cooldown(spec, wait)
        if spec.provider == "openrouter" and wait > 600:
            cooldown_provider("openrouter", wait)  # daily cap hit: every :free model is out
    else:
        fail(spec, 30)


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
    return {
        "day_utc": _usage["day"],
        "requests_today": dict(_usage["req"]),
        "tokens_today": dict(_usage["tok"]),
        "cooling_down": cooling,
    }


def reset(clear_usage: bool = False) -> None:
    """Forget cooldowns (used by tests)."""
    _cool.clear()
    _prov_cool.clear()
    _streak.clear()
    _perr.clear()
    if clear_usage:
        _usage.clear()
        _usage.update(_fresh())
