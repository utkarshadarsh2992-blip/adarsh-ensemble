"""Async client for OpenAI-compatible chat endpoints, with fail-over chains.

chat(client, spec, messages) tries `spec`, then each label in spec.fallbacks, and returns the
first good answer. A candidate is SKIPPED (no HTTP call) when its key is missing, it is cooling
down after a 429/error, its local daily quota is used up, or the request would not fit its
tokens-per-minute limit. Every outcome feeds health.py so later calls skip bad models faster.
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

_CONCURRENCY = {"openrouter": 4, "groq": 4, "gemini": 6}  # parallel requests per provider
_sems: dict = {}


class LLMError(Exception):
    pass


class _Skip(Exception):
    """This candidate cannot serve the request: try the next model in the chain."""


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
        return r.json()
    except ValueError:
        return None


def _error_text(data, r) -> str:
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err)[:200]
        if err:
            return str(err)[:200]
    return (getattr(r, "text", "") or "")[:200]


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
    if tpm and _est_tokens(messages) + (max_tokens or 0) > tpm * 0.9:
        raise _Skip(f"request too big for its {tpm} tokens/min limit")

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

        health.note_request(spec)
        try:
            async with _sem(spec.provider):
                r = await client.post(
                    f"{prov.base_url}/chat/completions", json=payload, headers=headers, timeout=timeout
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
            except (KeyError, IndexError, TypeError, AttributeError):
                health.fail(spec, 30)
                raise _Skip("malformed response")
            text = _OPEN_THINK_RE.sub("", _THINK_RE.sub("", text)).strip()
            if not text:
                health.fail(spec, 15)
                raise _Skip("empty answer (thinking used the whole token budget?)")
            usage = (data.get("usage") or {}) if isinstance(data, dict) else {}
            tokens = usage.get("total_tokens") or (_est_tokens(msgs) + len(text) // 3)
            health.success(spec, int(tokens))
            return text

        if code == 429:
            health.rate_limited(spec, _retry_after(r))
            raise _Skip("rate limited")
        if code == 401:
            health.cooldown_provider(spec.provider, 3600)
            raise _Skip("auth failed (check the API key)")
        if code == 402:
            health.cooldown_provider(spec.provider, 3600)
            raise _Skip("credits required")
        if code == 403:
            health.cooldown(spec, 3600)
            raise _Skip(f"forbidden: {_error_text(data, r)}")
        if code == 413:
            raise _Skip("request too large")
        if code == 404:
            health.cooldown(spec, 6 * 3600)
            raise _Skip(f"model not found: {_error_text(data, r)}")
        if code in (400, 422):
            if not recovered:  # maybe an unsupported extra param or system role: retry plain, once
                recovered, extra, msgs = True, {}, _merge_system(messages)
                continue
            health.fail(spec, 60)
            raise _Skip(f"bad request: {_error_text(data, r)}")
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
) -> str:
    chain = [spec] + [config.REGISTRY[label] for label in spec.fallbacks]
    reasons: dict[str, str] = {}
    for rnd in range(2):
        for cand in chain:
            try:
                text = await _try_model(client, cand, messages, temperature, max_tokens, timeout, retries)
            except _Skip as e:
                reasons[cand.label] = str(e)
                continue
            health.trace_add(spec, cand, True)
            return text
        if rnd == 0:  # everyone is cooling down: if a short wait helps, wait once and retry
            wait = health.wait_hint(chain)
            if wait is None or wait > 15:
                break
            await asyncio.sleep(wait + 0.5)
    health.trace_add(spec, spec, False)
    raise LLMError(f"{spec.role or spec.label}: no model could answer: {reasons}")
