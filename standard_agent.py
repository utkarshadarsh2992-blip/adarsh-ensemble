"""Standard mode: ONE Groq model (openai/gpt-oss-120b) that researches by itself.

Only Groq is ever called, with the user's Groq keys in slot order (GROQ_API_KEY, GROQ_API_KEY_2, GROQ_API_KEY_3).
A key is switched when it hits its limit (429), needs credits / is rejected (401/402/403) or the server fails
(5xx, timeouts, network). No other provider is used: if every Groq key is out, the user gets a clear message.

The model gets two tools in the same request (Groq allows built-in + local tools together on GPT-OSS):
  * `browser_search`  - Groq's built-in web search, run on Groq's side (fast, nothing to execute here).
                        Settings > Built-in web search can switch it off (`web=False`).
  * `wikipedia_search` - a local function tool; we query the Wikipedia API and send the extracts back.
                        Always offered when tools are on, also with web search off.
gpt-oss has no parallel tool calls, so tool calls come one per round; at most MAX_TOOL_ROUNDS local rounds.
Docs: https://console.groq.com/docs/browser-search , https://console.groq.com/docs/tool-use/built-in-tools
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import replace

import httpx

import config
import health
import research
from llm import _est_tokens, _json, _rate_info, _sem

MODEL_LABEL = "gpt-oss-120b"
MAX_TOOL_ROUNDS = 3
WIKI_RESULTS = 3
WIKI_CHARS = 1200
BROWSER_TOOL = {"type": "browser_search"}
WIKI_TOOL = {
    "type": "function",
    "function": {
        "name": "wikipedia_search",
        "description": (
            "Search English Wikipedia and return the intro of the best matching articles. Use it for stable facts: "
            "people, places, history, science, definitions, organisations. Use browser_search for news, prices, "
            "scores, releases or anything that changes often."
        ),
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Short search terms, e.g. 'Chandrayaan-3'"}},
            "required": ["query"],
        },
    },
}
# A 400 on a tool combination steps down to the next set on the same key. Wikipedia comes before web-only
# because the user wants Wikipedia research to keep working whatever happens to built-in search.
TOOL_SETS = ([BROWSER_TOOL, WIKI_TOOL], [WIKI_TOOL], [BROWSER_TOOL], [])
TOOL_SETS_NO_WEB = ([WIKI_TOOL], [])  # Settings > Built-in web search: off
_HINT_TAIL = (
    "Search only when it really helps; answer simple or personal questions directly. "
    "Never put the user's private details (names, numbers, notes, reminders) into a search query. "
    "Do not include citation markers in the answer."
)
RESEARCH_HINT = (
    "You can research: use wikipedia_search for stable facts and browser_search for current or fast-changing facts. "
    + _HINT_TAIL
)
RESEARCH_HINT_NO_WEB = (
    "You can research with wikipedia_search (stable facts). Live web search is switched off by the user, so for "
    "very recent news, prices or scores say briefly that live web search is off in Settings. " + _HINT_TAIL
)


def research_hint(web: bool = True) -> str:
    return RESEARCH_HINT if web else RESEARCH_HINT_NO_WEB
_CITE_RE = re.compile(r"\u3010[^\u3011]{0,60}\u3011")  # 【1†L3-L9】 markers from browser_search
_THINK_RE = re.compile(r"<think>.*?(?:</think>|$)", re.DOTALL)


class StandardError(Exception):
    """No Groq key could answer. `message` is shown to the user as is (Hinglish)."""


def _base_spec() -> config.ModelSpec:
    return replace(config.REGISTRY[MODEL_LABEL], role="standard", fallbacks=())


def clean(text: str) -> str:
    text = _THINK_RE.sub("", text or "")
    text = _CITE_RE.sub("", text)
    text = re.sub(r"[ \t]+([.,;:!?])", r"\1", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient()


async def _wikipedia(client: httpx.AsyncClient, query: str) -> tuple[str, list[dict]]:
    query = " ".join(str(query or "").split())[:200]
    if not query:
        return json.dumps({"error": "empty query"}), []
    try:
        hits = await research._wikipedia(client, query, WIKI_RESULTS, WIKI_CHARS)
    except Exception:  # research helpers already swallow HTTP errors; this is belt and braces
        hits = []
    if not hits:
        return json.dumps({"query": query, "results": [], "note": "No Wikipedia article found."}), []
    rows = [{"title": h.get("title", "").removeprefix("Wikipedia: "), "url": h.get("url", ""), "extract": h.get("text", "")}
            for h in hits[:WIKI_RESULTS]]
    return json.dumps({"query": query, "results": rows}, ensure_ascii=False), [
        {"title": "Wikipedia: " + r["title"], "url": r["url"]} for r in rows if r["url"]]


def _browser_sources(msg: dict) -> tuple[int, list[dict]]:
    """How many built-in searches ran, and the pages they returned (Groq puts them in message.executed_tools)."""
    n, out = 0, []
    for t in msg.get("executed_tools") or []:
        if not isinstance(t, dict):
            continue
        n += 1
        res = (t.get("search_results") or {}).get("results") if isinstance(t.get("search_results"), dict) else None
        for r in res or []:
            if isinstance(r, dict) and str(r.get("url", "")).startswith("https://"):
                out.append({"title": str(r.get("title") or r["url"])[:120], "url": str(r["url"])[:500]})
    return n, out


async def answer(messages: list[dict], *, tools: bool = True, web: bool = True, max_tokens: int = 1500,
                 effort: str = "low", temperature: float = 0.6, budget: float = 75.0) -> dict:
    """Run the Groq-only agent. Returns {"text", "used", "searches", "wiki", "sources", "secs"};
    raises StandardError when no Groq key could answer. `web=False` keeps Wikipedia but never sends browser_search."""
    base = _base_spec()
    prov = config.PROVIDERS["groq"]
    slots = prov.slots()
    if not slots:
        raise StandardError("Standard mode sirf Groq se chalta hai: Settings > API keys mein kam se kam ek Groq key daalo.")
    t0 = time.monotonic()
    deadline = t0 + budget
    msgs = [dict(m) for m in messages]
    reasons: dict[str, str] = {}
    searches, wiki_queries, sources = 0, [], []
    tool_sets = TOOL_SETS if web else TOOL_SETS_NO_WEB
    tool_idx = 0 if tools else len(tool_sets) - 1
    rounds, forced = 0, False
    async with _client() as client:
        for slot in slots:
            spec = config.keyed(base, slot)
            ok, why = health.available(spec)
            if not ok:
                reasons[spec.label] = why
                continue
            api_key = prov.key(slot)
            headers = {"Authorization": f"Bearer {api_key}"}
            switch_key = False
            while not switch_key:
                left = deadline - time.monotonic()
                if left < 3:
                    reasons[spec.label] = "time budget used up"
                    break
                payload = {"model": spec.model, "messages": msgs, "reasoning_effort": effort,
                           "max_completion_tokens": max_tokens, "temperature": temperature}
                tool_list = tool_sets[tool_idx] if rounds < MAX_TOOL_ROUNDS else []
                if tool_list:
                    payload["tools"] = tool_list  # tool_choice left at Groq's default ("auto")
                rpm, tpm = config.rpm_limit(spec), config.tpm_limit(spec)
                if rpm or tpm:
                    need = _est_tokens(msgs) + max_tokens
                    if tpm:  # search results make the real size unknowable; never let the estimate block forever
                        need = min(need, int(tpm * 0.9))
                    got, wait = health.reserve_slot(health.quota_key(spec), rpm, int(tpm * 0.9), need,
                                                    min(config.RL_MAX_WAIT_S, max(0.0, left - 5)))
                    if not got:
                        reasons[spec.label] = "own rate window full"
                        break
                    if wait:
                        await asyncio.sleep(wait)
                health.note_request(spec)
                try:
                    async with _sem("groq"):
                        r = await client.post(f"{prov.url_for(slot)}/chat/completions", json=payload, headers=headers,
                                              timeout=max(5.0, min(45.0, deadline - time.monotonic())))
                except httpx.HTTPError as e:
                    health.provider_error("groq", slot)
                    health.fail(spec, 30)
                    reasons[spec.label] = f"network error: {type(e).__name__}"
                    break  # server down / unreachable: next key
                data = _json(r)
                code = r.status_code
                if code == 200 and isinstance(data, dict) and data.get("choices"):
                    try:
                        choice = data["choices"][0]
                        msg = choice.get("message") or {}
                    except (KeyError, IndexError, TypeError, AttributeError):
                        health.fail(spec, 30)
                        reasons[spec.label] = "malformed response"
                        break
                    n, found = _browser_sources(msg)
                    searches += n
                    sources += found
                    calls = msg.get("tool_calls") or []
                    if calls and rounds < MAX_TOOL_ROUNDS:
                        rounds += 1
                        msgs.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
                        for c in calls:
                            fn = (c.get("function") or {}) if isinstance(c, dict) else {}
                            try:
                                args = json.loads(fn.get("arguments") or "{}")
                            except (TypeError, ValueError):
                                args = {}
                            if fn.get("name") == "wikipedia_search":
                                q = str((args or {}).get("query") or "")
                                wiki_queries.append(q[:80])
                                out, found = await _wikipedia(client, q)
                                sources += found
                            else:
                                out = json.dumps({"error": f"unknown tool {fn.get('name')!r}"})
                            msgs.append({"role": "tool", "tool_call_id": str(c.get("id") or ""), "content": out})
                        continue
                    text = clean(msg.get("content") or "")
                    if not text:
                        if calls and not forced:  # tool rounds used up but the model still wants tools: once more, no tools
                            forced, rounds = True, MAX_TOOL_ROUNDS
                            msgs.append({"role": "user", "content": "Ab bina tools ke seedha jawab do."})
                            continue
                        health.fail(spec, 15)
                        reasons[spec.label] = "empty answer"
                        break
                    usage = data.get("usage") or {}
                    health.success(spec, int(usage.get("total_tokens") or (_est_tokens(msgs) + len(text) // 3)))
                    secs = time.monotonic() - t0
                    health.trace_add(base, spec, True, messages=messages, output=text, secs=secs)
                    seen, uniq = set(), []
                    for s in sources:
                        if s["url"] not in seen:
                            seen.add(s["url"])
                            uniq.append(s)
                    return {"text": text, "used": spec.label, "searches": searches, "wiki": wiki_queries,
                            "sources": uniq[:6], "secs": round(secs, 1)}
                if code == 429:
                    wait, daily = _rate_info(r, data)
                    health.rate_limited(spec, wait, daily)
                    reasons[spec.label] = "rate limited" + (" (daily quota)" if daily else "")
                    break
                if code in (401, 402, 403):
                    health.cooldown_key(spec, 3600)
                    reasons[spec.label] = {401: "auth failed", 402: "credits required", 403: "forbidden"}[code]
                    break
                if code == 404:
                    health.cooldown(spec, 6 * 3600)
                    reasons[spec.label] = "model not found"
                    raise StandardError("Groq par gpt-oss-120b abhi mil nahi raha (HTTP 404). Thodi der baad try karo.")
                if code in (400, 413, 422):
                    if tool_idx < len(tool_sets) - 1:
                        tool_idx += 1  # this tool combination was refused: same key, fewer tools
                        continue
                    health.fail(spec, 60)
                    reasons[spec.label] = f"bad request (HTTP {code})"
                    break
                health.provider_error("groq", slot)  # exhaust configured Groq keys before the provider breaker opens
                health.fail(spec, 30)
                reasons[spec.label] = f"HTTP {code}"
                break
    health.trace_add(base, base, False, messages=messages, secs=time.monotonic() - t0, skips=reasons)
    detail = "; ".join(f"key {k.split('#')[1] if '#' in k else '1'}: {v}" for k, v in reasons.items())
    raise StandardError("Sir, Groq ki teeno keys se jawab nahi aaya" + (f" ({detail})" if detail else "") +
                        ". Standard mode sirf Groq use karta hai; thodi der baad try karo ya Settings mein aur Groq key daalo.")


def sources_block(sources: list[dict], limit: int = 4) -> str:
    rows = [s for s in sources if s.get("url", "").startswith("https://")][:limit]
    if not rows:
        return ""
    return "\n\n**Sources**\n" + "\n".join(f"- [{s['title']}]({s['url']})" for s in rows)
