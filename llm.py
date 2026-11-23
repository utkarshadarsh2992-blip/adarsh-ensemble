"""Async client for OpenAI-compatible chat endpoints, with fail-over chains.

chat(client, spec, messages) tries `spec`, then each label in spec.fallbacks, and returns the
first good answer. A candidate is SKIPPED (no HTTP call) when its key is missing, it is cooling
down after a 429/error, its local daily quota is used up, or the request would not fit its
tokens-per-minute limit. Before every call it reserves a slot in our own per-minute window
(health.reserve_slot), so parallel requests are spaced out instead of fired together and 429s become rare.
A real 429 is read properly (Retry-After, the provider's "retry in 34s", per-minute vs per-DAY).
Every outcome feeds health.py so later calls skip bad models faster.
"""
import asyncio
import re
import time

import httpx

import config
import health
from config import PROVIDERS, ModelSpec

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_OPEN_THINK_RE = re.compile(r"<think>.*$", re.DOTALL)

_CONCURRENCY = {"openrouter": 4, "groq": 4, "gemini": 6, "cloudflare": 3, "nvidia": 3}  # parallel requests per provider
_sems: dict = {}


class LLMError(Exception):
    pass


class _Skip(Exception):
    """This candidate cannot serve the request: try the next model in the chain.
    retry=False: waiting will not fix it (empty answer, bad request, too big, daily quota...), so this call
                 does not come back to it in the second round.
    retry_in:    seconds after which it may work again (rate limit); lets chat() decide to wait for it."""

    def __init__(self, reason: str, retry: bool = True, retry_in: float | None = None):
        super().__init__(reason)
        self.retry = retry
        self.retry_in = retry_in


def _sem(provider: str) -> asyncio.Semaphore:
    key = (provider, id(asyncio.get_running_loop()))
    if key not in _sems:
        _sems[key] = asyncio.Semaphore(_CONCURRENCY.get(provider, 4))
    return _sems[key]


def _est_tokens(messages: list[dict]) -> int:
    # conservative: Hinglish / code / math tokenize worse than plain English
    return sum(len(m.get("content") or "") for m in messages) // 3 + 8 * len(messages)


def _merge_system(messages: list[dict]) -> list[dict]:
    """Some models reject the system role: fold it into the first user message."""
    sys_txt = "\n".join(m["content"] for m in messages if m["role"] == "system")
    rest = [dict(m) for m in messages if m["role"] != "system"]
    if sys_txt and rest and rest[0]["role"] == "user":
        rest[0]["content"] = f"{sys_txt}\n\n{rest[0]['content']}"
    return rest or messages


def _json(r):
    try:
        data = r.json()
    except ValueError:
        return None
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]  # Gemini's OpenAI endpoint wraps its errors in a list: [{"error": {...}}]
    return data


def _error_text(data, r) -> str:
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err)[:200]
        if err:
            return str(err)[:200]
    return (getattr(r, "text", "") or "")[:200]


def _full_error(data, r) -> str:
    """The provider's whole error message (not cut to 200 chars: Gemini puts "Please retry in 34s" at the very end)."""
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or "")
        if err:
            return str(err)
    return getattr(r, "text", "") or ""


def _parse_wait(text: str) -> float | None:
    """"Please try again in 7.2s" / "retry in 34.019s" / "try again in 2m4.8s" / "in 650ms" -> seconds."""
    m = re.search(r"(?:retry|try again)\s+(?:after|in)\s+((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)", text or "", re.I)
    if not m:
        return None
    total = 0.0
    for num, unit in re.findall(r"(\d+(?:\.\d+)?)\s*(ms|h|m|s)", m.group(1), re.I):
        total += float(num) * {"ms": 0.001, "s": 1.0, "m": 60.0, "h": 3600.0}[unit.lower()]
    return total or None


_DAILY_WORDS = ("per day", "perday", "per-day", "daily", "rpd", "tpd")


def _rate_info(r, data) -> tuple[float | None, bool]:
    """(seconds to wait or None, is it the per-DAY quota?) read from a 429."""
    wait = _retry_after(r)
    if not wait and isinstance(data, dict):
        err = data.get("error")
        for d in (err.get("details") or []) if isinstance(err, dict) else []:  # Gemini: RetryInfo.retryDelay = "34s"
            if isinstance(d, dict) and d.get("retryDelay"):
                wait = _parse_wait("retry in " + str(d["retryDelay"]))
                if wait:
                    break
    if not wait:
        wait = _parse_wait(_full_error(data, r))
    blob = (str(data) + " " + (getattr(r, "text", "") or "")).lower()
    return wait, any(w in blob for w in _DAILY_WORDS)


def _retry_after(r) -> float | None:
    v = r.headers.get("retry-after")
    if v:
        try:
            return max(1.0, float(v))
        except ValueError:
            pass
    v = r.headers.get("x-ratelimit-reset")  # OpenRouter: epoch (ms or s) or seconds from now
    if v:
        try:
            t = float(v)
            if t > 1e12:
                t /= 1000.0
            wait = t - time.time() if t > 1e9 else t
            if wait > 0:
                return wait
        except ValueError:
            pass
    return None


async def _try_model(client, spec, messages, temperature, max_tokens, timeout, retries) -> str:
    """Return the answer text, or raise _Skip(reason)."""
    ok, why = health.available(spec)
    if not ok:
        raise _Skip(why)
    tpm = config.tpm_limit(spec)
    need = _est_tokens(messages) + (max_tokens or 0)
    if tpm and need > tpm * 0.9:
        raise _Skip(f"request too big for its {tpm} tokens/min limit", retry=False)
    rpm = config.rpm_limit(spec)

    prov = PROVIDERS[spec.provider]
    headers = {"Authorization": f"Bearer {prov.api_key}"}
    if spec.provider == "openrouter":
        headers["X-Title"] = "multi-model-ensemble"

    extra, msgs = dict(spec.extra), messages
    attempts, recovered = 0, False
    while True:
        attempts += 1
        payload = {"model": spec.model, "messages": msgs, **extra}
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        if rpm or tpm:  # our own per-minute window: wait for a free slot or let the chain move on
            got, wait = health.reserve_slot(health.quota_key(spec), rpm, int(tpm * 0.9), need, config.RL_MAX_WAIT_S)
            if not got:
                raise _Skip("own rate window full" + (f" (free in {int(wait)}s)" if wait else ""), retry_in=wait)
            if wait > 0:
                await asyncio.sleep(wait)
                ok, why = health.available(spec)  # somebody may have hit a 429 for this model meanwhile
                if not ok:
                    raise _Skip(why)

        health.note_request(spec)
        try:
            async with _sem(spec.provider):
                r = await client.post(
                    f"{prov.url}/chat/completions", json=payload, headers=headers, timeout=timeout
                )
        except httpx.HTTPError as e:
            health.provider_error(spec.provider)
            if attempts <= retries and health.available(spec)[0]:
                await asyncio.sleep(1.0 * attempts)
                continue
            health.fail(spec, 30)
            raise _Skip(f"network error: {type(e).__name__}")

        data = _json(r)
        code = r.status_code
        if code == 200 and isinstance(data, dict) and data.get("error") and not data.get("choices"):
            err = data["error"]  # OpenRouter sometimes reports upstream errors inside a 200
            c = err.get("code") if isinstance(err, dict) else None
            code = c if isinstance(c, int) else 502

        if code == 200:
            try:
                text = data["choices"][0]["message"].get("content") or ""
                finish = data["choices"][0].get("finish_reason")
            except (KeyError, IndexError, TypeError, AttributeError):
                health.fail(spec, 30)
                raise _Skip("malformed response", retry=False)
            text = _OPEN_THINK_RE.sub("", _THINK_RE.sub("", text)).strip()
            if not text:
                health.fail(spec, 15)
                raise _Skip(
                    "empty answer (ran out of tokens while thinking)" if finish == "length"
                    else "empty answer (thinking used the whole token budget?)",
                    retry=False,
                )
            usage = (data.get("usage") or {}) if isinstance(data, dict) else {}
            tokens = usage.get("total_tokens") or (_est_tokens(msgs) + len(text) // 3)
            health.success(spec, int(tokens))
            return text

        if code == 429:
            wait, daily = _rate_info(r, data)
            health.rate_limited(spec, wait, daily)
            if daily:
                raise _Skip("rate limited (daily quota used up)", retry=False)
            raise _Skip("rate limited" + (f" (try again in {int(wait)}s)" if wait else ""), retry_in=wait)
        if code == 401:
            health.cooldown_provider(spec.provider, 3600)
            raise _Skip("auth failed (check the API key)", retry=False)
        if code == 402:
            health.cooldown_provider(spec.provider, 3600)
            raise _Skip("credits required", retry=False)
        if code == 403:
            health.cooldown(spec, 3600)
            raise _Skip(f"forbidden: {_error_text(data, r)}", retry=False)
        if code == 413:
            raise _Skip("request too large", retry=False)
        if code == 404:
            health.cooldown(spec, 6 * 3600)
            raise _Skip(f"model not found: {_error_text(data, r)}", retry=False)
        if code in (400, 422):
            if not recovered:  # maybe an unsupported extra param or system role: retry plain, once
                recovered, extra, msgs = True, {}, _merge_system(messages)
                continue
            health.fail(spec, 60)
            raise _Skip(f"bad request: {_error_text(data, r)}", retry=False)
        # 408 / 5xx / anything else
        if code in (408, 502, 503, 504):
            health.provider_error(spec.provider)
        if attempts <= retries and health.available(spec)[0]:
            await asyncio.sleep(1.5 * attempts)
            continue
        health.fail(spec, 30)
        raise _Skip(f"HTTP {code}")


async def chat(
    client: httpx.AsyncClient,
    spec: ModelSpec,
    messages: list[dict],
    *,
    temperature: float | None = 0.4,
    max_tokens: int | None = 1800,
    timeout: float = 120.0,
    retries: int = 1,
    budget: float | None = None,
) -> str:
    """budget = most seconds this whole call may take (all models together). None = no limit."""
    chain = [spec] + [config.REGISTRY[label] for label in spec.fallbacks]
    reasons: dict[str, str] = {}
    dead: set[str] = set()  # failed for a reason waiting will not fix: not tried again in round 2
    t_start = time.perf_counter()
    out_of_time = False
    for rnd in range(2):
        hints: list[float] = []
        for cand in chain:
            if cand.label in dead:
                continue
            if budget and time.perf_counter() - t_start > budget:
                reasons[cand.label] = "time budget used up"
                out_of_time = True
                break
            try:
                text = await _try_model(client, cand, messages, temperature, max_tokens, timeout, retries)
            except _Skip as e:
                reasons[cand.label] = str(e)
                if not e.retry:
                    dead.add(cand.label)
                elif e.retry_in is not None:
                    hints.append(e.retry_in)
                continue
            health.trace_add(spec, cand, True, messages=messages, output=text,
                             secs=time.perf_counter() - t_start, skips=reasons)
            return text
        if out_of_time:
            break
        if rnd == 0:  # everyone is cooling down / rate limited: if a short wait helps, wait once and retry
            waits = [w for w in [health.wait_hint([c for c in chain if c.label not in dead]), *hints] if w is not None]
            wait = min(waits) if waits else None
            if wait is None or wait > config.RL_ROUND_WAIT_S:
                break
            if budget and time.perf_counter() - t_start + wait > budget:
                break
            await asyncio.sleep(wait + 0.5)
    health.trace_add(spec, spec, False, messages=messages, secs=time.perf_counter() - t_start, skips=reasons)
    raise LLMError(f"{spec.role or spec.label}: no model could answer: {reasons}")
