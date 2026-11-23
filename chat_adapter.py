"""Adapter: ADARSH UI chat request  ->  ensemble pipeline  ->  UI reply objects.

The UI (ui/ARCHITECTURE.md, section 2) POSTs:
  {chat_id, text, attachments, history, meta, abilities, lang}   or   {ping: true}
and accepts a reply object, an array of replies, or {replies: [...]}.

This module is the only place that knows both formats.
"""
import re

import httpx

import config
import lessons
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


async def _casual_reply(text: str, reply_lang: str = "auto", depth: str = "normal") -> dict | None:
    """One quick model call. None means: fall back to the full pipeline."""
    try:
        async with httpx.AsyncClient() as client:
            out = await chat(
                client, config.SYNTHESIZER,
                [{"role": "system", "content": CASUAL_SYSTEM + " " + pipeline._language_hint(text, reply_lang)},
                 {"role": "user", "content": text}],
                temperature=0.6, max_tokens=300, timeout=40, retries=0,
            )
    except LLMError:
        return None
    return {"type": "text", "text": out.strip(), "steps": ["Quick reply"]}


def _audit_line(issue: dict, kind: str) -> str:
    quote = " ".join(str(issue.get("quote") or "").split())
    fix = " ".join(str(issue.get("fix") or "").split())
    problem = " ".join(str(issue.get("problem") or "").split())
    head = f'"{quote}" → ' if quote else ""
    if kind == "applied":
        return f"- {head}{fix}. Wajah: {problem}"
    lead = f"{quote}: " if quote else ""
    return f"- {lead}{problem} (shayad sahi: {fix})"


def _sources_block(res: dict) -> str:
    """Web sources the answer actually cites ([S1]...), as clickable links under the answer."""
    srcs = res.get("sources") or []
    used = {int(n) for n in re.findall(r"\[S(\d+)", res.get("answer") or "")}
    cited = [s for s in srcs if s.get("n") in used]
    if not cited:
        return ""
    return "\n\n**Sources**\n" + "\n".join(f"[S{s['n']}] [{s['title']}]({s['url']})" if s.get("url") else f"[S{s['n']}] {s['title']}"
                                           for s in cited)


def _format_answer(res: dict) -> str:
    text = res["answer"].strip() + _sources_block(res)
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
    if isinstance(body.get("lesson"), dict):
        return lessons.handle_op(body["lesson"])  # list / add / edit / delete / clear / good: no model call

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

    rp = body.get("reply") if isinstance(body.get("reply"), dict) else {}
    reply_lang = rp.get("lang") if rp.get("lang") in ("auto", "hinglish", "english", "hindi") else "auto"
    depth = rp.get("depth") if rp.get("depth") in ("simple", "normal", "detailed") else "normal"

    source = body.get("source") if body.get("source") in ("auto", "manual", "hybrid") else "auto"
    answers = _clean_answers(body.get("answers"))
    if source != "auto" and not answers:
        return {"type": "text", "text": "Manual ya Hybrid mode me kam se kam ek pasted answer chahiye. Composer ke chip se answer paste karo, ya source Auto kar do."}
    if source == "auto":
        answers = []  # answers without manual/hybrid would be rejected by the pipeline

    if source == "auto" and _is_casual(text):
        quick = await _casual_reply(text, reply_lang, depth)
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
        reply_lang=reply_lang,
        depth=depth,
        debug=False,
        record=True,
        mode=str(body.get("mode") or "standard"),
    )

    replies: list[dict] = [{"type": "text", "text": _format_answer(res)}]
    if not config.CODE_EXEC_SUPPORTED and res.get("style") == "solve" and res.get("task_type") in config.VERIFY_TASKS:
        replies[0]["text"] += "\n\n*Python code proofs are off on Android. Steps are [REASONED], not [PROVEN by code].*"
    if body.get("attachments"):
        replies[0]["text"] += "\n\n*Attachments abhi ensemble tak nahi bheje jaate (sirf text).*"
    # shown folded under the answer as "Worked through N steps"
    master = res.get("master")
    if master:
        steps = ["Manual · master answer (sirf tumhare answers se)"]
    elif res.get("engine") == "roles":
        steps = [f"Task: {res.get('task_type', 'general')} · mode {res.get('mode', 'standard')} · 11-role council"]
        if res.get("sources"):
            steps.append(f"Research: {len(res['sources'])} web sources padhe")
        if res.get("confidence"):
            steps.append(f"Confidence: {res['confidence']}")
        q = res.get("quota") or {}
        if q.get("saved"):
            steps.append(f"Quota bachat (~{int(round(q.get('left', 0) * 100))}% bacha): " + ", ".join(q["saved"]))
    else:
        steps = [f"Task: {res.get('task_type', 'general')} · {res.get('style', 'solve')}"]
    if source != "auto":
        steps.append(f"Source: {source} ({res.get('user_answers_used', 0)} yours, {res.get('panel_answers_used', 0)} models)")
    steps += [f"{m} x{n}" for m, n in (res.get("models_used") or {}).items()]
    audit = res.get("audit") or {}
    if res.get("repairs"):
        steps.append(f"Format repair x{res['repairs']}")
    if master:
        steps.append(f"Lessons: {len(master['lessons_used'])} lage, {len(master['learned'])} naye/majboot")
    if audit.get("enabled"):
        steps.append(
            f"{audit.get('label', 'Audit')}: {len(audit.get('applied', []))} sudhar, {len(audit.get('unsure', []))} shak"
            if audit.get("ran")
            else f"{audit.get('label', 'Audit')}: chala nahi"
        )
    steps.append(f"{res.get('latency_s', 0)}s")
    replies[0]["steps"] = steps

    # folded under the answer: what the audit corrected, what it doubts, and what the falsifiers found
    items = []
    if audit.get("applied"):
        items.append({"title": f"{audit.get('label', 'Audit')} ne sudhara ({len(audit['applied'])})",
                      "text": "\n".join(_audit_line(i, "applied") for i in audit["applied"])})
    if audit.get("unsure"):
        items.append({"title": f"{audit.get('label', 'Audit')} ko shak hai, khud check karo",
                      "text": "\n".join(_audit_line(i, "unsure") for i in audit["unsure"])})
    items += res.get("role_notes") or []
    items += res.get("falsifier_notes") or []
    uncited = [s for s in res.get("sources") or [] if f"[S{s.get('n')}" not in (res.get("answer") or "")]
    if uncited:
        items.append({"title": f"Padhe gaye par jawab me use nahi hue ({len(uncited)})",
                      "text": "\n".join(f"- {s['title']}: {s.get('url', '')}" for s in uncited)})
    if items:
        replies[0]["notes"] = {"title": "Kahan galat ho sakta hai", "items": items}
    if master:
        replies[0]["master"] = True  # the UI offers "kya galat tha?" feedback only on these replies
        replies[0]["lessonIds"] = [x["id"] for x in master["lessons_used"]]
    if res.get("council"):
        replies[0]["council"] = res["council"]  # shown on its own page, not in the chat scroll
    return replies
