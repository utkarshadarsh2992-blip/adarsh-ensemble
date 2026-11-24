"""Big input -> sub-topics (council modes only; Standard never uses this).

A message is "big" when it is longer than BIG_INPUT_CHARS or asks BIG_MIN_QUESTIONS+ separate questions.
1. split_chunks: cut locally (no model) at paragraph / sentence ends into ~BIG_CHUNK_CHARS pieces; nothing is lost.
2. decompose: one cheap call per chunk (config.STRIPPER chain, provider-first fallback), one after another so the
   rate limiter keeps RPM / TPM safe. Each call returns the sub-topics of that chunk with the user's exact ask and the
   key facts / numbers. If every model fails, a local topic per chunk is used (the input is still fully covered).
3. merge: same titles are joined, at most BIG_MAX_TOPICS topics.
4. brief: the topic map + condensed context, small enough for the council (<= limit chars).
"""
from __future__ import annotations

import json
import os
import re

import config
import health
from llm import LLMError, chat

BIG_INPUT_CHARS = int(os.getenv("BIG_INPUT_CHARS", "6000"))
BIG_MIN_QUESTIONS = int(os.getenv("BIG_MIN_QUESTIONS", "3"))
BIG_CHUNK_CHARS = int(os.getenv("BIG_CHUNK_CHARS", "3500"))
BIG_MAX_TOPICS = int(os.getenv("BIG_MAX_TOPICS", "8"))
BIG_MAX_CHUNKS = int(os.getenv("BIG_MAX_CHUNKS", "12"))

_ITEM = re.compile(r"^\s*(?:\(?\d{1,2}[.):]|[Qq]\d{1,2}[.):]?|[a-hA-H][.)]|[-*\u2022])\s+\S")
_SENT_END = re.compile(r"(?<=[.!?\u0964])\s+")


def count_questions(text: str) -> int:
    """Separate questions: '?' sentence ends, or numbered / bulleted lines (whichever is more)."""
    marks = len(re.findall(r"\?+", text))
    items = sum(1 for line in text.splitlines() if _ITEM.match(line))
    return max(marks, items)


def is_big(text: str) -> bool:
    return len(text) > BIG_INPUT_CHARS or count_questions(text) >= BIG_MIN_QUESTIONS


def _pieces(par: str, size: int) -> list[str]:
    if len(par) <= size:
        return [par]
    out, cur = [], ""
    for sent in _SENT_END.split(par):
        while len(sent) > size:  # one huge "sentence" (code, table): hard cut
            if cur:
                out.append(cur)
                cur = ""
            out.append(sent[:size])
            sent = sent[size:]
        if cur and len(cur) + 1 + len(sent) > size:
            out.append(cur)
            cur = sent
        else:
            cur = f"{cur} {sent}" if cur else sent
    if cur:
        out.append(cur)
    return out


def split_chunks(text: str, size: int = BIG_CHUNK_CHARS) -> list[str]:
    """Pack paragraphs into chunks of at most `size` chars, cutting only at paragraph / sentence ends."""
    pars = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks, cur = [], ""
    for par in pars:
        for piece in _pieces(par, size):
            if cur and len(cur) + 2 + len(piece) > size:
                chunks.append(cur)
                cur = piece
            else:
                cur = f"{cur}\n\n{piece}" if cur else piece
    if cur:
        chunks.append(cur)
    return chunks


def _messages(chunk: str, k: int, n: int) -> list[dict]:
    system = (
        "You read ONE part of a long user message and list its sub-topics. Reply with JSON only: "
        '{"topics":[{"title":"short title","ask":"what the user wants about it, in their words",'
        '"facts":"numbers, names, data, conditions given in this part that an answer needs"}]}. '
        "Do not answer anything. Do not invent topics. Keep every number exactly. 1-4 topics; facts under 500 chars."
    )
    return [{"role": "system", "content": system},
            {"role": "user", "content": f"Part {k} of {n} of the message:\n\n{chunk}"}]


def _parse(raw: str) -> list[dict]:
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return []
    out = []
    for t in data.get("topics") or []:
        if isinstance(t, dict) and str(t.get("title") or "").strip():
            out.append({"title": " ".join(str(t["title"]).split())[:90],
                        "ask": " ".join(str(t.get("ask") or "").split())[:400],
                        "context": " ".join(str(t.get("facts") or "").split())[:600]})
    return out


def _local_topic(chunk: str, k: int) -> dict:
    first = next((ln.strip() for ln in chunk.splitlines() if ln.strip()), f"Hissa {k}")
    return {"title": first[:90], "ask": "", "context": " ".join(chunk.split())[:600]}


def merge(topics: list[dict], limit: int = BIG_MAX_TOPICS) -> list[dict]:
    seen: dict[str, dict] = {}
    for t in topics:
        key = re.sub(r"\W+", " ", t["title"].lower()).strip()
        if key in seen:
            old = seen[key]
            old["ask"] = " ".join(x for x in (old["ask"], t["ask"]) if x)[:600]
            old["context"] = " ".join(x for x in (old["context"], t["context"]) if x)[:900]
        else:
            seen[key] = dict(t)
    out = list(seen.values())
    if len(out) > limit:  # keep the count bounded; the rest becomes one "other points" topic
        rest = out[limit - 1:]
        out = out[: limit - 1] + [{
            "title": "Baaki points: " + "; ".join(t["title"] for t in rest)[:80],
            "ask": " ".join(t["ask"] for t in rest if t["ask"])[:600],
            "context": " ".join(t["context"] for t in rest if t["context"])[:900],
        }]
    return out


async def decompose(client, text: str, errors: dict | None = None) -> list[dict]:
    """Sub-topic map of a big message: one cheap call per chunk, sequential (rate-limit friendly)."""
    chunks = split_chunks(text)[:BIG_MAX_CHUNKS]
    topics: list[dict] = []
    for k, chunk in enumerate(chunks, 1):
        config.emit(f"Bada input: hissa {k}/{len(chunks)} samajh raha hoon")
        got: list[dict] = []
        health.set_stage(f"decompose:{k}")
        try:
            got = _parse(await chat(client, config.STRIPPER, _messages(chunk, k, len(chunks)),
                                    temperature=0.1, max_tokens=900))
        except LLMError as e:
            if errors is not None:
                errors[f"decompose:{k}"] = str(e)
        topics.extend(got or [_local_topic(chunk, k)])
    topics = merge(topics)
    config.emit(f"Bada input: {len(topics)} sub-topic mile")
    return topics


def brief(text: str, topics: list[dict], limit: int = 8000) -> str:
    """Council question: numbered sub-topic list (exact asks + key facts), then as much original text as fits."""
    lines = [f"[Long message ({len(text):,} chars) split into {len(topics)} sub-topics. "
             "Answer EVERY sub-topic under its own heading '## k. title', in this order.]"]
    for k, t in enumerate(topics, 1):
        lines.append(f"{k}. {t['title']}" + (f" | Ask: {t['ask']}" if t["ask"] else "")
                     + (f" | Facts: {t['context']}" if t["context"] else ""))
    head = "\n".join(lines)
    room = limit - len(head) - 40
    if room > 200:
        body = text if len(text) <= room else text[:room].rsplit(" ", 1)[0] + " ..."
        head += "\n\n[Original message]\n" + body
    return head[:limit]


BIG_MAX_PARTS = int(os.getenv("BIG_MAX_PARTS", "4"))
BIG_TOPICS_PER_PART = int(os.getenv("BIG_TOPICS_PER_PART", "3"))
PART_GAP_S = float(os.getenv("PART_GAP_S", "3"))  # small pause between part calls; the rate limiter does the rest


def plan_parts(topics: list[dict] | None) -> list[list[int]]:
    """Sub-topic numbers (1-based) per output part. Fewer than 4 topics: [] = one normal answer."""
    n = len(topics or [])
    if n <= BIG_TOPICS_PER_PART:
        return []
    count = min(BIG_MAX_PARTS, -(-n // BIG_TOPICS_PER_PART))
    size = -(-n // count)
    return [list(range(i + 1, min(n, i + size) + 1)) for i in range(0, n, size)]


def missing_topics(answer: str, numbers: list[int]) -> list[int]:
    """Sub-topics whose '## k.' heading is not in the answer (coverage check, no model)."""
    return [k for k in numbers if not re.search(rf"(?m)^\s*#{{1,4}}\s*(?:Part\s*\d+/\d+\s*[-:]?\s*)?{k}\s*[.):]", answer or "")]
