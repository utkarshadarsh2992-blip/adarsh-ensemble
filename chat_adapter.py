"""Adapter: ADARSH UI chat request  ->  ensemble pipeline  ->  UI reply objects.

The UI (ui/ARCHITECTURE.md, section 2) POSTs:
  {chat_id, text, attachments, history, meta, abilities, lang}   or   {ping: true}
and accepts a reply object, an array of replies, or {replies: [...]}.

This module is the only place that knows both formats.
"""
import re

import httpx

import config
import pipeline
from llm import LLMError, chat

# Greetings, thanks and other small talk do not need panel + falsifiers + judge.
_CASUAL = re.compile(
    r"^\s*(h+i+|h+e+l+o+|hlo+|hey+|hii+|namaste|namaskar|kaise ho.*|kya haal.*|good (morning|afternoon|evening|night)|"
    r"thanks?( you)?|thx|shukriya|dhanyavad|ok(ay)?|theek hai|bye|goodbye|alvida)\W*$",
    re.IGNORECASE,
)
CASUAL_SYSTEM = (
    "You are Adarsh, a friendly personal assistant. Reply to small talk in one or two short sentences, warm and natural. "
    "No headings, no lists, no disclaimers. Mirror the user's language (Hinglish stays Hinglish, Hindi stays Hindi)."
)

MAX_CONTEXT_CHARS = 2000   # how much earlier chat is passed along as context
MAX_QUESTION_CHARS = 8000  # AskRequest.question limit


def _context(history: list[dict] | None, current: str) -> str:
    """Compact tail of the chat so follow-ups ('aur samjhao') still make sense."""
    if not history:
        return ""
    turns = [h for h in history if (h.get("text") or "").strip()]
    # the UI may already include the current message as the last user turn: drop it
    if turns and turns[-1].get("role") == "user" and turns[-1]["text"].strip() == current.strip():
        turns = turns[:-1]
    lines, used = [], 0
    for h in reversed(turns[-6:]):
        who = "User" if h.get("role") == "user" else "Assistant"
        line = f"{who}: {h['text'].strip()[:600]}"
        if used + len(line) > MAX_CONTEXT_CHARS:
            break
        lines.append(line)
        used += len(line)
    if not lines:
        return ""
    return "\n\n[Earlier in this chat, context only]\n" + "\n".join(reversed(lines))


def _clean_answers(raw) -> list[dict]:
    """Pasted answers from the UI: trimmed, capped, empty ones dropped."""
    out = []
    for a in raw if isinstance(raw, list) else []:
        if not isinstance(a, dict):
            continue
        txt = str(a.get("text") or "").strip()[:12000]
        if txt:
            out.append({"source": str(a.get("source") or "").strip()[:60], "text": txt})
    return out[: config.MAX_USER_ANSWERS]


def _is_casual(text: str) -> bool:
    t = text.strip()
    return bool(_CASUAL.match(t)) or (len(t) <= 4 and not any(c.isdigit() for c in t) and "?" not in t)


async def _casual_reply(text: str) -> dict | None:
    """One quick model call. None means: fall back to the full pipeline."""
    try:
        async with httpx.AsyncClient() as client:
            out = await chat(
                client, config.SYNTHESIZER,
                [{"role": "system", "content": CASUAL_SYSTEM + " " + pipeline._language_hint(text)},
                 {"role": "user", "content": text}],
                temperature=0.6, max_tokens=300, timeout=40, retries=0,
            )
    except LLMError:
        return None
    return {"type": "text", "text": out.strip(), "steps": ["Quick reply"]}


def _format_answer(res: dict) -> str:
    text = res["answer"].strip()
    notes = []
    ps = res.get("proofs_summary")
    if ps and ps.get("total"):
        notes.append("Checks: " + ", ".join(f"{k} {v}" for k, v in ps.items()))
    for w in res.get("warnings", []):
        notes.append(w)
    if notes:
        text += "\n\n" + "\n".join(f"*{n}*" for n in notes)
    return text


async def handle(body: dict) -> dict | list[dict]:
    if body.get("ping"):
        return {"ok": True}

    meta = body.get("meta") or {}
    if meta.get("approval"):
        # The ensemble never asks for approvals, so this is only a safe no-op.
        return {"type": "text", "text": "Noted. This backend has no actions that need approval."}

    text = (body.get("text") or "").strip()
    if meta.get("answer"):
        # Same: the ensemble does not emit `ask` cards. If one arrives, fold the answers in.
        parts = [f"{a.get('header', '')}: {a.get('answer', '')}" for a in meta["answer"].get("answers", [])]
        text = (text + "\n" + "\n".join(parts)).strip()
    if len(text) < 2:
        return {"type": "text", "text": "Kuch likho, phir main sawaal verify karunga."}

    source = body.get("source") if body.get("source") in ("auto", "manual", "hybrid") else "auto"
    answers = _clean_answers(body.get("answers"))
    if source != "auto" and not answers:
        return {"type": "text", "text": "Manual ya Hybrid mode me kam se kam ek pasted answer chahiye. Composer ke chip se answer paste karo, ya source Auto kar do."}
    if source == "auto":
        answers = []  # answers without manual/hybrid would be rejected by the pipeline

    if source == "auto" and _is_casual(text):
        quick = await _casual_reply(text)
        if quick:
            return [quick]

    extra = _context(body.get("history"), text)
    question = (text[: MAX_QUESTION_CHARS - len(extra)] + extra)[:MAX_QUESTION_CHARS]

    res = await pipeline.run(
        question,
        deep=config.CHAT_MODE == "deep",
        engine=config.CHAT_ENGINE,
        source=source,
        answers=answers,
        run_code=config.CODE_EXEC_SUPPORTED,
        use_guard=bool(answers),  # scan pasted answers for prompt injection
        debug=False,
    )

    replies: list[dict] = [{"type": "text", "text": _format_answer(res)}]
    if not config.CODE_EXEC_SUPPORTED and res.get("task_type") in config.VERIFY_TASKS:
        replies[0]["text"] += "\n\n*Python code proofs are off on Android. Steps are [REASONED], not [PROVEN by code].*"
    if body.get("attachments"):
        replies[0]["text"] += "\n\n*Attachments abhi ensemble tak nahi bheje jaate (sirf text).*"
    # shown folded under the answer as "Worked through N steps"
    steps = [f"Task: {res.get('task_type', 'general')}"]
    if source != "auto":
        steps.append(f"Source: {source} ({res.get('user_answers_used', 0)} yours, {res.get('panel_answers_used', 0)} models)")
    steps += [f"{m} x{n}" for m, n in (res.get("models_used") or {}).items()]
    steps.append(f"{res.get('latency_s', 0)}s")
    replies[0]["steps"] = steps
    return replies
