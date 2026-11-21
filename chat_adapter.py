"""Adapter: ADARSH UI chat request  ->  ensemble pipeline  ->  UI reply objects.

The UI (ui/ARCHITECTURE.md, section 2) POSTs:
  {chat_id, text, attachments, history, meta, abilities, lang}   or   {ping: true}
and accepts a reply object, an array of replies, or {replies: [...]}.

This module is the only place that knows both formats.
"""
import config
import pipeline

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


def _format_answer(res: dict) -> str:
    text = res["answer"].strip()
    notes = []
    ps = res.get("proofs_summary")
    if ps:
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

    extra = _context(body.get("history"), text)
    question = (text[: MAX_QUESTION_CHARS - len(extra)] + extra)[:MAX_QUESTION_CHARS]

    res = await pipeline.run(
        question,
        deep=config.CHAT_MODE == "deep",
        engine=config.CHAT_ENGINE,
        source="auto",
        run_code=True,
        use_guard=False,  # nothing pasted from other AIs in plain chat
        debug=False,
    )

    replies: list[dict] = [{"type": "text", "text": _format_answer(res)}]
    if body.get("attachments"):
        replies[0]["text"] += "\n\n*Attachments abhi ensemble tak nahi bheje jaate (sirf text).*"
    # shown folded under the answer as "Worked through N steps"
    steps = [f"Task: {res.get('task_type', 'general')}"]
    steps += [f"{m} x{n}" for m, n in (res.get("models_used") or {}).items()]
    steps.append(f"{res.get('latency_s', 0)}s")
    replies[0]["steps"] = steps
    return replies
