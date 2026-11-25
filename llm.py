"""Async client for OpenAI-compatible chat endpoints, with fail-over chains.

chat(client, spec, messages) tries the primary provider's models and keys before another provider,
preserving each provider's model order from spec.fallbacks. A candidate is SKIPPED when its key is missing, it is cooling
down after a 429/error, its local daily quota is used up, or the request would not fit its
tokens-per-minute limit. Before every call it reserves a slot in our own per-minute window
(health.reserve_slot), so parallel requests are spaced out instead of fired together and 429s become rare.
A real 429 is read properly (Retry-After, the provider's "retry in 34s", per-minute vs per-DAY).
Every outcome feeds health.py so later calls skip bad models faster.
Several API keys per provider (config.KEY_SLOTS): each model of the chain is tried with key 1, then key 2, then key 3
(only the configured ones) before the chain moves to the next model. A key that hits its limit (429), needs credits
(402), is rejected (401/403) or meets a server error (5xx / network) hands over to the next key at once.
Thinking models: when the whole max_tokens went into thinking (empty answer, finish_reason "length"), the SAME model
and key is asked once more with a bigger budget and lighter thinking (see _think_retry). If that is empty too, the
model's other keys are skipped (a token budget is not a key problem) and the chain moves to the next model.
If the key has no tokens/min room for the bigger request, the model's next key starts with it (_Skip.boost).
Network: slow providers (config.STREAM_PROVIDERS) are asked with stream=true so the connection never sits silent while
the model is queued or thinking (some phone networks drop silent connections: httpx ReadError); _post_stream turns the
events back into one normal response. make_client() adds TCP keep-alive probes for the same reason.
"""
import asyncio
import json
import re
import socket
import time

import httpx

import config
import health
import thinking
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
    retry_in:    seconds after which it may work again (rate limit); lets chat() decide to wait for it.
    whole_model: the failure belongs to the MODEL, not to this key (its other keys would fail the same way).
    boost:       (max_tokens, extra) for the model's NEXT key: this key ran out of tokens while thinking and had no
                 tokens/min room left for the bigger, lighter retry; the next key has its own window."""
    def __init__(self, reason: str, retry: bool = True, retry_in: float | None = None, whole_model: bool = False,
                 boost: tuple | None = None):
        super().__init__(reason)
        self.retry = retry
        self.retry_in = retry_in
        self.whole_model = whole_model
        self.boost = boost


def _sem(provider: str) -> asyncio.Semaphore:
    key = (provider, id(asyncio.get_running_loop()))
    if key not in _sems:
        _sems[key] = asyncio.Semaphore(_CONCURRENCY.get(provider, 4))
    return _sems[key]


def _keepalive_options() -> list[tuple[int, int, int]]:
    """TCP keep-alive socket options (only those this OS accepts). A probe every few silent seconds keeps the phone's /
    carrier's NAT entry for the connection alive while a model is still queued or thinking."""
    idle = config.TCP_KEEPALIVE_S
    if idle <= 0 or not hasattr(socket, "SO_KEEPALIVE"):
        return []
    wanted = [(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)]
    for name, value in (("TCP_KEEPIDLE", idle), ("TCP_KEEPINTVL", max(5, idle // 2)), ("TCP_KEEPCNT", 6)):
        if hasattr(socket, name):
            wanted.append((socket.IPPROTO_TCP, getattr(socket, name), value))
    if not hasattr(socket, "TCP_KEEPIDLE") and hasattr(socket, "TCP_KEEPALIVE"):  # macOS name of the idle time
        wanted.append((socket.IPPROTO_TCP, socket.TCP_KEEPALIVE, idle))
    ok = []
    try:  # an option the OS refuses would make EVERY connect fail inside httpx: test each one first
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            for opt in wanted:
                try:
                    probe.setsockopt(*opt)
                    ok.append(opt)
                except OSError:
                    pass
    except OSError:
        return []
    return ok


def make_client(**kwargs) -> httpx.AsyncClient:
    """HTTP client for model calls: TCP keep-alive on every connection, and one quick retry when the CONNECT fails
    (httpx never re-sends a request that already went out). Same defaults as httpx.AsyncClient() otherwise."""
    transport = httpx.AsyncHTTPTransport(socket_options=_keepalive_options() or None, retries=1)
    return httpx.AsyncClient(transport=transport, **kwargs)


_NOT_COPIED = {"content-encoding", "content-length", "transfer-encoding", "content-type"}


async def _post_stream(client, url: str, payload: dict, headers: dict, timeout: float):
    """POST with stream=true, then hand back ONE normal response, as if stream had been false.

    The answer text is the joined content deltas (thinking deltas are dropped, like a plain call drops them);
    finish_reason, usage and an error event are kept. A non-200 or a server that ignored stream=true and sent JSON
    is returned as it came. A stream that just stops (no finish_reason, no [DONE]) is a broken connection, not a
    short answer: it raises like any other network error. `timeout` still bounds every silent gap; the whole
    stream may take at most 2x timeout."""
    deadline = time.monotonic() + max(2 * timeout, 60.0)
    async with client.stream("POST", url, json={**payload, "stream": True}, headers=headers, timeout=timeout) as r:
        if r.status_code != 200 or "text/event-stream" not in r.headers.get("content-type", ""):
            await r.aread()
            return r
        parts, finish, usage, err, done = [], None, None, None, False
        async for line in r.aiter_lines():
            if time.monotonic() > deadline:
                raise httpx.ReadTimeout("answer still streaming at the deadline")
            if not line.startswith("data:"):
                continue  # blank separators and ": keep-alive" comments
            chunk = line[5:].strip()
            if chunk == "[DONE]":
                done = True
                break
            try:
                event = json.loads(chunk)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            if event.get("error"):
                err = event["error"]
            if isinstance(event.get("usage"), dict):
                usage = event["usage"]
            for choice in event.get("choices") or []:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta") or choice.get("message") or {}
                piece = delta.get("content") if isinstance(delta, dict) else None
                if isinstance(piece, str):
                    parts.append(piece)
                if choice.get("finish_reason"):
                    finish = choice["finish_reason"]
        kept = [(k, v) for k, v in r.headers.items() if k.lower() not in _NOT_COPIED]
    if err is not None and (finish in (None, "error") or not parts):
        body = {"error": err}  # handled like OpenRouter's error-inside-a-200
    elif finish is None and not done:
        raise httpx.RemoteProtocolError("stream ended before the answer was complete")
    else:
        body = {"choices": [{"message": {"content": "".join(parts)}, "finish_reason": finish}], "usage": usage or {}}
    return httpx.Response(200, headers=kept, json=body)


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


_HEAVY_EFFORT = ("medium", "high", "xhigh")
# a 400/410/422 that says the MODEL is gone (Groq "model_decommissioned", Google "no longer available") is a 404
_GONE_RE = re.compile(r"(model[_ ]?(not[_ ]?found|decommissioned|does not exist)|models/\S+ is not found|"
                      r"no longer (available|supported)|has been (decommissioned|deprecated|removed)|unknown model|"
                      r"invalid model)", re.I)


def _model_gone(data, r) -> bool:
    code = ""
    if isinstance(data, dict) and isinstance(data.get("error"), dict):
        code = str(data["error"].get("code") or "")
    return bool(_GONE_RE.search(f"{_full_error(data, r)} {code}"))


def _think_retry(spec, extra: dict, max_tokens: int | None, est: int, tpm: int, plain: bool):
    """One more try after an empty answer cut off by the token limit: (bigger max_tokens, lighter extra), or None.

    Bigger: 2x the budget, at least +2048, at most config.THINK_RETRY_MAX_TOKENS, and never past the model's own
    tokens-per-minute limit. Lighter: reasoning_effort "medium"/"high" -> "low"; Gemini models without an effort get
    "low" too (Gemini 3 cannot switch thinking off, but "low" leaves room for the answer). Gemma and other models
    without an effort setting only get the bigger budget. `plain` = the extras were already dropped after a 400."""
    cap = config.THINK_RETRY_MAX_TOKENS
    if not max_tokens or cap <= 0:
        return None
    room = min(cap, int(tpm * 0.9) - est) if tpm else cap
    bigger = max(max_tokens, min(max(max_tokens * 2, max_tokens + 2048), room))
    lighter = dict(extra)
    effort = lighter.get("reasoning_effort")
    if effort in _HEAVY_EFFORT:
        lighter["reasoning_effort"] = "low"
    elif isinstance(lighter.get("reasoning"), dict) and lighter["reasoning"].get("effort") in _HEAVY_EFFORT:
        lighter["reasoning"] = {**lighter["reasoning"], "effort": "low"}  # OpenRouter's switch (thinking.py)
    elif effort is None and not plain and spec.provider == "gemini" and spec.model.startswith("gemini-"):
        lighter["reasoning_effort"] = "low"
    if bigger <= max_tokens and lighter == extra:
        return None
    return bigger, lighter


async def _try_model(client, spec, messages, temperature, max_tokens, timeout, retries, boost=None) -> str:
    """Return the answer text, or raise _Skip(reason).
    boost = (max_tokens, extra) handed over by this model's previous key (see _Skip.boost): start with that bigger,
    lighter request; it already IS the thinking retry, so an empty answer is not retried again here."""
    ok, why = health.available(spec)
    if not ok:
        raise _Skip(why)
    tpm = config.tpm_limit(spec)
    extra = dict(spec.extra)
    if boost:
        max_tokens, extra = boost[0], dict(boost[1])
    else:  # council modes: think as much as the question's weight needs AND the budget allows (thinking.py)
        max_tokens, extra, _lvl = thinking.plan(spec.provider, spec.model, extra, max_tokens, _est_tokens(messages),
                                                tpm, health.stage())
    need = _est_tokens(messages) + (max_tokens or 0)
    if tpm and need > tpm * 0.9:
        raise _Skip(f"request too big for its {tpm} tokens/min limit", retry=False)
    rpm = config.rpm_limit(spec)

    prov = PROVIDERS[spec.provider]
    slot = spec.key_slot or ((prov.slots() or [1])[0])
    api_key = prov.key(slot)
    if not api_key:
        raise _Skip(f"{config.slot_env(prov.api_key_env, slot)} not set", retry=False)
    base_url = prov.url_for(slot)
    headers = {"Authorization": f"Bearer {api_key}"}
    if spec.provider == "openrouter":
        headers["X-Title"] = "multi-model-ensemble"

    msgs = messages
    attempts, recovered, think_retried = 0, False, bool(boost)
    url = f"{base_url}/chat/completions"
    stream = spec.provider in config.STREAM_PROVIDERS and hasattr(client, "stream")
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
                if think_retried:  # this key's minute is used up: the bigger, lighter request goes to the model's
                    health.fail(spec, 15)  # next key (own tokens/min window); after the last key, the next model
                    raise _Skip("empty answer (ran out of tokens while thinking; no tokens/min room on this key for "
                                "a bigger retry, next key tries it)", retry=False, boost=(max_tokens, extra))
                raise _Skip("own rate window full" + (f" (free in {int(wait)}s)" if wait else ""), retry_in=wait)
            if wait > 0:
                await asyncio.sleep(wait)
                ok, why = health.available(spec)  # somebody may have hit a 429 for this model meanwhile
                if not ok:
                    raise _Skip(why)

        health.note_request(spec)
        sent = time.perf_counter()
        try:
            async with _sem(spec.provider):
                sent = time.perf_counter()  # the error text shows how long the connection lived, not the queue
                if stream:
                    r = await _post_stream(client, url, payload, headers, timeout)
                else:
                    r = await client.post(url, json=payload, headers=headers, timeout=timeout)
        except httpx.HTTPError as e:
            health.provider_error(spec.provider, slot)
            if attempts <= retries and health.available(spec)[0]:
                await asyncio.sleep(1.0 * attempts)
                continue
            health.fail(spec, 30)
            raise _Skip(f"network error: {type(e).__name__} after {time.perf_counter() - sent:.0f}s")

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
                if finish == "length" and not think_retried:
                    nxt = _think_retry(spec, extra, max_tokens, _est_tokens(msgs), tpm, recovered)
                    if nxt:  # same model, same key: more room for the answer and less thinking, once
                        think_retried = True
                        max_tokens, extra = nxt
                        need = _est_tokens(msgs) + max_tokens
                        continue
                health.fail(spec, 15)
                if finish == "length":
                    raise _Skip(
                        "empty answer (ran out of tokens while thinking"
                        + (f", also after a retry with {max_tokens} tokens)" if think_retried else ")"),
                        retry=False, whole_model=True,
                    )
                raise _Skip(
                    "empty answer (thinking used the whole token budget?)",
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
            health.cooldown_key(spec, 3600)
            raise _Skip(f"auth failed (check API key {slot})", retry=False)
        if code == 402:
            health.cooldown_key(spec, 3600)
            raise _Skip(f"credits required (key {slot})", retry=False)
        if code == 403:
            health.cooldown(spec, 3600)
            raise _Skip(f"forbidden: {_error_text(data, r)}", retry=False)
        if code == 413:
            raise _Skip("request too large", retry=False)
        if code == 404 or (code in (400, 410, 422) and _model_gone(data, r)):
            why = f"model not found: {_error_text(data, r)}"
            health.model_gone(spec, why)  # every key of this model, saved: not called again until tomorrow
            raise _Skip(why, retry=False, whole_model=True)
        if code in (400, 422):
            if not recovered:  # maybe an unsupported extra param or system role: retry plain, once
                recovered, extra, msgs = True, {}, _merge_system(messages)
                continue
            health.fail(spec, 60)
            raise _Skip(f"bad request: {_error_text(data, r)}", retry=False)
        # 408 / 5xx / anything else
        if code in (408, 502, 503, 504):
            health.provider_error(spec.provider, slot)
        if attempts <= retries and health.available(spec)[0]:
            await asyncio.sleep(1.5 * attempts)
            continue
        health.fail(spec, 30)
        raise _Skip(f"HTTP {code}")


def expand_keys(chain: list) -> list:
    """Each model once per configured API key, in slot order: [m(key1), m(key2), m(key3), next model...].
    A model whose provider has no key at all stays in once, so the skip reason ("..._API_KEY not set") is reported."""
    out = []
    for c in chain:
        if c.key_slot:
            out.append(c)
            continue
        slots = PROVIDERS[c.provider].slots()
        out += [config.keyed(c, n) for n in slots] if slots else [c]
    return out


def balance(chain: list) -> list:
    """Stable provider-first chain, with no proactive cross-provider quota balancing.

    Keep the primary provider first, then providers in their original first-occurrence order.
    Within each provider preserve the role's model order. expand_keys then tries all configured
    keys of each model. Known-unavailable candidates remain skippable by the existing health guards.
    """
    groups: dict[str, list] = {}
    for candidate in chain:
        groups.setdefault(candidate.provider, []).append(candidate)
    return [candidate for group in groups.values() for candidate in group]


async def chat(
    client: httpx.AsyncClient,
    spec: ModelSpec,
    messages: list[dict],
    *,
    temperature: float | None = 0.4,
    max_tokens: int | None = 1800,
    timeout: float | None = None,
    retries: int = 1,
    budget: float | None = None,
) -> str:
    """budget = most seconds this whole call may take (all models together). None = no limit.
    timeout = seconds per model attempt for every model of the chain; None = each model's own value
    (config.model_timeout: gemini-3.8-flash 200 s, kimi-k3.1-pro / nemotron-ultra 300 s, others config.LLM_TIMEOUT_S)."""
    chain = expand_keys(balance([spec] + [config.REGISTRY[label] for label in spec.fallbacks]))
    reasons: dict[str, str] = {}
    dead: set[str] = set()  # failed for a reason waiting will not fix: not tried again in round 2
    boosts: dict[str, tuple] = {}  # model -> bigger/lighter request its next key starts with (_Skip.boost)
    t_start = time.perf_counter()
    out_of_time = False
    for rnd in range(2):
        hints: list[float] = []
        for i, cand in enumerate(chain):
            if cand.label in dead:
                continue
            if budget and time.perf_counter() - t_start > budget:
                reasons[cand.label] = "time budget used up"
                out_of_time = True
                break
            config.emit_call({"t": "try", "stage": health.stage(), "model": cand.label, "provider": cand.provider})
            try:
                # another key of the same model comes next: do not retry a 5xx / network error on this key, switch
                nxt = chain[i + 1] if i + 1 < len(chain) else None
                same_next = nxt is not None and config.base_label(nxt.label) == config.base_label(cand.label)
                limit = timeout if timeout is not None else config.model_timeout(cand)
                text = await _try_model(client, cand, messages, temperature, max_tokens, limit,
                                        0 if same_next else retries, boosts.get(config.base_label(cand.label)))
            except _Skip as e:
                reasons[cand.label] = str(e)
                config.emit_call({"t": "fail", "stage": health.stage(), "model": cand.label,
                                  "provider": cand.provider, "why": str(e)})
                if not e.retry:
                    dead.add(cand.label)
                    if e.whole_model:  # key 2 / key 3 of this model would run out of tokens the same way
                        dead.update(c.label for c in chain
                                    if config.base_label(c.label) == config.base_label(cand.label))
                    elif e.boost:
                        boosts[config.base_label(cand.label)] = e.boost
                elif e.retry_in is not None:
                    hints.append(e.retry_in)
                continue
            health.trace_add(spec, cand, True, messages=messages, output=text,
                             secs=time.perf_counter() - t_start, skips=reasons)
            config.emit_call({"t": "ok", "stage": health.stage(), "model": cand.label, "provider": cand.provider,
                              "asked": spec.label, "secs": round(time.perf_counter() - t_start, 1)})
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
    config.emit_call({"t": "dead", "stage": health.stage(), "model": spec.label, "provider": spec.provider,
                      "why": "koi model jawab nahi de paya"})
    raise LLMError(f"{spec.role or spec.label}: no model could answer: {reasons}")
