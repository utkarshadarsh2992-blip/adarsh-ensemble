"""Research step: a small web lookup before the panel writes, so answers can rest on real text, not only memory.

Sources (all optional, all fail-soft: no sources = the engine works exactly as before):
  * Wikipedia API (no key)           : always on when RESEARCH=1
  * Tavily web search (TAVILY_API_KEY): real web results incl. recent pages, if a key is set

Every source becomes {"n": 1, "title", "url", "text", "via"}. The models see them inside <sources> and may cite
them as [S1], [S2]. The text is DATA (prompt injection from a web page is treated like any other untrusted text).
"""
import asyncio
import os
import re

import httpx

import config

UA = "AdarshEnsemble/1.0 (personal research assistant; https://github.com/)"
WIKI_LANGS = ("en",)


def _clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", text).strip()


def _cut(text: str, n: int) -> str:
    if len(text) <= n:
        return text
    cut = text[:n]
    brk = cut.rfind(". ")
    return (cut[: brk + 1] if brk > n * 0.6 else cut).rstrip() + " …"


async def _wikipedia(client: httpx.AsyncClient, query: str, limit: int, chars: int) -> list[dict]:
    out = []
    for lang in WIKI_LANGS:
        try:
            r = await client.get(
                f"https://{lang}.wikipedia.org/w/api.php",
                params={
                    "action": "query", "format": "json", "generator": "search", "gsrsearch": query,
                    "gsrlimit": str(limit), "prop": "extracts|info", "inprop": "url", "exintro": "1",
                    "explaintext": "1", "exchars": str(chars), "redirects": "1",
                },
                headers={"User-Agent": UA},
                timeout=config.RESEARCH_TIMEOUT_S,
            )
            pages = (r.json().get("query") or {}).get("pages") or {}
        except (httpx.HTTPError, ValueError):
            continue
        for p in sorted(pages.values(), key=lambda p: p.get("index", 99)):
            text = _clean(p.get("extract", ""))
            if len(text) < 80 or "may refer to" in text[:200]:
                continue  # stubs and disambiguation pages say nothing useful
            out.append({"title": f"Wikipedia: {p.get('title', '')}", "url": p.get("fullurl", ""),
                        "text": _cut(text, chars), "via": "wikipedia"})
    return out


async def _tavily(client: httpx.AsyncClient, query: str, limit: int, chars: int) -> list[dict]:
    key = os.getenv("TAVILY_API_KEY", "").strip()
    if not key:
        return []
    try:
        r = await client.post(
            "https://api.tavily.com/search",
            json={"api_key": key, "query": query, "max_results": limit, "search_depth": "basic",
                  "include_answer": False},
            timeout=config.RESEARCH_TIMEOUT_S,
        )
        if r.status_code != 200:
            return []
        results = r.json().get("results") or []
    except (httpx.HTTPError, ValueError):
        return []
    return [{"title": _clean(x.get("title", ""))[:160], "url": x.get("url", ""),
             "text": _cut(_clean(x.get("content", "")), chars), "via": "web"}
            for x in results if _clean(x.get("content", ""))]


def queries_from_plan(plan: str | None, question: str) -> list[str]:
    """The Architect's SEARCH line, else the question itself (without the chat context)."""
    q = question.split("\n\n[Earlier in this chat", 1)[0].strip()
    if plan:
        m = re.search(r"^\W*SEARCH\s*:\s*(.+)$", plan, re.I | re.M)
        if m:
            line = m.group(1).strip()
            if re.fullmatch(r"\W*none\W*", line, re.I):
                return []
            found = [s.strip(" \"'`*") for s in line.split("||")]
            found = [s for s in found if 2 < len(s) <= 120]
            if found:
                return found[:2]
    return [q[:120]] if q else []


async def gather(client: httpx.AsyncClient, queries: list[str]) -> list[dict]:
    """Run all lookups in parallel, drop duplicates, number them S1..Sn. Never raises."""
    if not config.RESEARCH_ENABLED or not queries:
        return []
    per, chars = config.RESEARCH_PER_QUERY, config.RESEARCH_CHARS
    jobs = []
    for q in queries:
        jobs.append(_tavily(client, q, per, chars))
        jobs.append(_wikipedia(client, q, per, chars))
    try:
        results = await asyncio.wait_for(asyncio.gather(*jobs, return_exceptions=True),
                                         timeout=config.RESEARCH_TIMEOUT_S + 3)
    except asyncio.TimeoutError:
        return []
    seen, out = set(), []
    for res in results:
        if isinstance(res, BaseException):
            continue
        for s in res:
            key = s["url"] or s["title"]
            if key in seen:
                continue
            seen.add(key)
            out.append(s)
    # web results first (fresher), then Wikipedia; total size kept small (Groq allows 8K tokens/min per model)
    out.sort(key=lambda s: s["via"] != "web")
    picked, used = [], 0
    for s in out:
        if len(picked) >= config.RESEARCH_MAX_SOURCES or used + len(s["text"]) > config.RESEARCH_TOTAL_CHARS:
            continue
        picked.append(s)
        used += len(s["text"])
    for i, s in enumerate(picked, 1):
        s["n"] = i
    return picked


def format_sources(sources: list[dict]) -> str:
    return "\n\n".join(f"[S{s['n']}] {s['title']} ({s['url']})\n{s['text']}" for s in sources)
