"""Adapter: ADARSH UI chat request  ->  ensemble pipeline  ->  UI reply objects.

The UI (ui/ARCHITECTURE.md, section 2) POSTs:
  {chat_id, text, attachments, history, meta, abilities, lang}   or   {ping: true}
and accepts a reply object, an array of replies, or {replies: [...]}.

This module is the only place that knows both formats.
"""
import os
import json
import re
import time

import httpx

import config
import health
import lessons
import pipeline
import app_context
import pdf_make
import pdf_read
import sources
import app_knowledge
import bigtask
from llm import LLMError, chat, make_client
import verified
import standard_agent
import thinking

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

# Standard mode = Groq only: openai/gpt-oss-120b with Groq's built-in web search + a Wikipedia tool
# (standard_agent.py). STANDARD_QUICK=0 (server operators only) sends it through the full 11-role council again.
QUICK_STANDARD = os.getenv("STANDARD_QUICK", "1") != "0"
MAX_CONTEXT_CHARS = 2000   # how much earlier chat is passed along as context
MAX_QUESTION_CHARS = 8000  # AskRequest.question limit
MAX_HISTORY_ITEMS = 40
MAX_HISTORY_TEXT = 2000
MAX_ATTACHMENTS = 8
MAX_ATTACHMENT_DATA_CHARS = 12 * 1024 * 1024
MAX_META_CHARS = 64 * 1024


def _bound_meta(value, depth: int = 0):
    """Keep Android/server metadata finite before it reaches any model path."""
    if depth >= 3:
        return str(value)[:500]
    if isinstance(value, dict):
        return {str(k)[:80]: _bound_meta(v, depth + 1) for k, v in list(value.items())[:50]}
    if isinstance(value, list):
        return [_bound_meta(v, depth + 1) for v in value[:50]]
    if isinstance(value, str):
        return value[:4000]
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return str(value)[:500]


def _fit(text: str, extra: str, limit: int = MAX_QUESTION_CHARS) -> tuple[str, str, str]:
    """Fit the user's message and the extra context (chat history, app records, app knowledge) into `limit` chars.
    The message has priority: the extra context is trimmed first. Only a message that is longer than `limit` by
    itself is cut, and then the returned note says so (never a silent cut)."""
    if len(text) >= limit:
        note = (f"*Note: aapka message {len(text):,} characters ka tha; is mode me ek baar me {limit:,} tak padha jata "
                f"hai, isliye aakhri {len(text) - limit:,} characters is jawab me shamil nahi hue.*")
        return text[:limit], "", note
    return text, extra[: limit - len(text)], ""


def _bound_request(body: dict) -> dict:
    """Apply caps shared by Android and the FastAPI adapter."""
    bounded = dict(body)
    history = body.get("history")
    if isinstance(history, list):
        bounded["history"] = [
            {**item, "text": str(item.get("text") or "")[:MAX_HISTORY_TEXT]}
            for item in history[-MAX_HISTORY_ITEMS:]
            if isinstance(item, dict)
        ]
    attachments = body.get("attachments")
    if isinstance(attachments, list):
        bounded_attachments = []
        for item in attachments[:MAX_ATTACHMENTS]:
            if not isinstance(item, dict):
                continue
            item = dict(item)
            if isinstance(item.get("dataUrl"), str):
                item["dataUrl"] = item["dataUrl"][:MAX_ATTACHMENT_DATA_CHARS]
            bounded_attachments.append(item)
        bounded["attachments"] = bounded_attachments
    meta = _bound_meta(body.get("meta") or {})
    try:
        if len(json.dumps(meta, ensure_ascii=False)) > MAX_META_CHARS:
            meta = {k: meta[k] for k in ("approval", "answer", "deep", "voice") if k in meta}
    except (TypeError, ValueError):
        meta = {}
    bounded["meta"] = meta
    return bounded


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


async def _casual_reply(text: str, reply_lang: str = "auto", depth: str = "normal", body: dict | None = None) -> dict | None:
    """Standard small talk: one Groq gpt-oss-120b call, no tools. None means: use the normal Standard path."""
    try:
        out = await standard_agent.answer(
            [{"role": "system", "content": CASUAL_SYSTEM + " " + pipeline._language_hint(text, reply_lang) + app_context.philosophy(body or {})},
             {"role": "user", "content": text}],
            tools=False, max_tokens=500, temperature=0.7, budget=30,
        )
    except standard_agent.StandardError:
        return None
    return {"type": "text", "text": out["text"], "steps": [f"Quick reply · Groq {out['used']}"]}


QUICK_SYSTEM = (
    "You are Adarsh, a sharp, confident assistant. Answer the question directly in the first sentence, then add only what helps. "
    "Be accurate: if you are not sure of a fact, say so briefly instead of guessing. No filler, no 'as an AI', no restating the question. "
    "Use short paragraphs; use a list or code block only when it really helps."
)
QUICK_DEPTH = {
    "simple": "Keep it very short: 1-3 sentences, plain words.",
    "normal": "Keep it compact: usually under 150 words.",
    "detailed": "Give a fuller explanation with steps or examples, but stay organised.",
}
QUICK_VOICE = (
    "This will be read aloud. Plain spoken sentences only: no markdown, no lists, no code, no URLs, no emojis. "
    "2 to 5 short sentences, conversational and confident."
)
PDF_WORD = re.compile(r"\bpdf\b", re.I)
PDF_VERB = re.compile(r"\b(bana|banao|banado|banade|banaye|generate|export|save|likh|create|make|chahiye)\b", re.I)
PDF_REPORT = re.compile(r"\b(report|file|document)\b", re.I)


def _wants_pdf(text: str) -> bool:
    """Only when the user explicitly asks for a PDF; never on an ordinary question."""
    asked = str(text or "")[:400]
    if PDF_WORD.search(asked):
        return True
    return bool(PDF_REPORT.search(asked) and PDF_VERB.search(asked))


def _attach_pdf(reply: dict, asked: str, rows: list[dict]) -> None:
    """Build the report from the finished answer and hand it to the page as base64 (Kotlin saves it)."""
    body = str(reply.get("text") or "").strip()
    if not body:
        return
    title = (body.splitlines()[0] if body.splitlines() else "Report").lstrip("# ").strip()[:90] or "Report"
    try:
        data = pdf_make.report(title, body, subtitle="Adarsh Ensemble report", sources=rows)
    except Exception as e:                       # a broken report must never break the answer
        reply["text"] += "\n\n*PDF nahi ban paaya: " + str(e)[:80] + "*"
        return
    import base64 as _b64
    name = re.sub(r"[^A-Za-z0-9 _-]+", "", title).strip().replace(" ", "-")[:50] or "adarsh-report"
    reply["pdf"] = {"name": name + ".pdf", "base64": _b64.b64encode(data).decode("ascii"), "bytes": len(data)}
    reply["text"] += "\n\n*PDF taiyaar: " + name + ".pdf*"


async def _quick_reply(text: str, extra: str, reply_lang: str, depth: str, voice: bool, *,
                       research: bool = True, deep: bool = False, web: bool = True) -> dict:
    """Standard mode: Groq gpt-oss-120b only. It searches the web (Groq browser_search) and Wikipedia by itself
    when that helps. Never falls back to another provider; a failure comes back as a clear text reply."""
    system = QUICK_SYSTEM + " " + QUICK_DEPTH.get(depth, QUICK_DEPTH["normal"]) + " " + pipeline._language_hint(text, reply_lang)
    if research:
        system += " " + standard_agent.research_hint(web)
    if voice:
        system += " " + QUICK_VOICE
    user = text + (extra or "")
    trace = health.start_trace(False)
    health.set_stage("standard")
    try:
        out = await standard_agent.answer(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            tools=research, web=web, max_tokens=3000 if (depth == "detailed" or deep) else 1600,
            effort="medium" if deep else "low", temperature=0.5, budget=90 if deep else 75,
        )
    except standard_agent.StandardError as e:
        return {"type": "text", "text": str(e), "uiMode": "standard", "steps": ["Standard · Groq only"]}
    text_out = out["text"]
    if not voice:
        text_out += standard_agent.sources_block(out["sources"])
    steps = [f"Standard · Groq {out['used']} (sirf Groq)"]
    if out["searches"]:
        steps.append(f"Web search x{out['searches']} (Groq built-in)")
    elif research and not web:
        steps.append("Built-in web search off (Settings) · Wikipedia on")
    if out["wiki"]:
        steps.append("Wikipedia: " + ", ".join(q for q in out["wiki"] if q)[:160])
    steps.append(f"{out['secs']}s")
    rep = {"type": "text", "text": text_out, "steps": steps}
    calls = pipeline._compact_calls(trace)
    if calls:
        rep["calls"] = calls
    return rep


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
    used = {int(n) for n in verified.SOURCE_CITATION_RE.findall(res.get("answer") or "")}
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


def local_response(body: dict) -> dict | list[dict] | None:
    """Safe offline preflight; shared by Android before its API-key check and by the adapter."""
    perms = app_context.access(body)
    if body.get("architecture") is True:
        if not perms["architecture"]:
            return {"type": "text", "text": "Architecture reference access off hai. Settings > AI access se allow karo."}
        return {"type": "architecture", "reference": app_knowledge.reference(str(body.get("mode") or "standard"))}
    if body.get("attachments") or (body.get("meta") or {}).get("deep"):
        return None
    if body.get("source", "auto") != "auto":
        return None  # do not silently change Manual/Hybrid into Auto
    from actions import handle as action_handle
    act = action_handle(str(body.get("text") or ""), "standard")
    if not act:
        return None
    mode = str(body.get("mode") or "standard")
    steps0 = act.get("steps") or []
    settings_only = act.get("type") == "actions" and steps0 and all(s.get("action") == "settings.update" for s in steps0)
    if mode != "standard" and not settings_only:   # app settings (e.g. "standard mode mein jao") work from every mode
        return {"type": "text", "text": "Ye in-app command Standard mode mein chalta hai. Sir, aap khud Standard select karo; maine mode change nahi kiya.", "uiMode": mode, "origin": "local-rule"}
    if act.get("type") == "actions":
        steps = act.get("steps") or []
        reads = any(s.get("action", "").endswith(".list") for s in steps)
        edits = any(not s.get("action", "").endswith(".list") for s in steps)
        if (reads and not perms["localRead"]) or (edits and not perms["localEdit"]):
            return {"type": "text", "text": "Sir, is command ka local read/edit access off hai. Settings > AI access mein aap allow kar sakte ho.", "origin": "local-rule"}
    return [act]


async def handle(body: dict) -> dict | list[dict]:
    if not isinstance(body, dict):
        return {"type": "text", "text": "Request body must be an object."}
    body = _bound_request(body)
    if body.get("ping"):
        return {"ok": True}
    if isinstance(body.get("tts"), dict):
        import voice
        return await voice.handle(body["tts"])  # natural voice for a reply: no chat model involved
    if isinstance(body.get("lesson"), dict):
        return lessons.handle_op(body["lesson"])  # list / add / edit / delete / clear / good: no model call

    local = local_response(body)
    if local is not None:
        return local
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
    web_search = rp.get("web") != "off"  # Settings > Built-in web search (Standard mode); Wikipedia stays on

    think = rp.get("think") if rp.get("think") in ("fast", "deep") else config.CHAT_MODE  # Settings > Reply style > Council
    source = body.get("source") if body.get("source") in ("auto", "manual", "hybrid") else "auto"
    answers = _clean_answers(body.get("answers"))
    if source != "auto" and not answers:
        return {"type": "text", "text": "Manual ya Hybrid mode me kam se kam ek pasted answer chahiye. Composer ke chip se answer paste karo, ya source Auto kar do."}
    if source == "auto":
        answers = []  # answers without manual/hybrid would be rejected by the pipeline

    ui_mode = str(body.get("mode") or "standard")
    if source == "auto" and ui_mode == "standard" and _is_casual(text):
        quick = await _casual_reply(text, reply_lang, depth, body)
        if quick:
            return [quick]

    perms = app_context.access(body)
    extra = _context(body.get("history") if perms["currentChat"] else [], text)
    private_context = bool(extra)
    extra += app_context.context(body, text)
    private_context = private_context or "[Permitted relevant app records;" in extra
    extra += app_knowledge.context(text, ui_mode, perms["architecture"])
    # Attached PDFs are read on the phone (no service): their text is data the models may quote.
    pdf_block, pdf_names = pdf_read.attachments_text(body.get("attachments"))
    # Real sources in every mode, Standard included (sources.py): papers, books, standards, statistics, launches,
    # robotics. Keyless and fail-soft, so a dead endpoint costs nothing but a second.
    src_block, src_rows = ("", [])
    if rp.get("research") != "off" and not private_context and len(str(text or "").split()) >= 3:
        src_block, src_rows = await sources.gather(text)
    # Philosophy first, then the user's own document, then the sources: the 6000-char cap never cuts them.
    extra = (app_context.philosophy(body) + pdf_block + src_block + extra)[:6000]
    if QUICK_STANDARD and source == "auto" and ui_mode == "standard":
        # Permitted personal app records stay out of web/Wikipedia searches: research is off for those questions.
        has_records = "[Permitted relevant app records;" in extra
        q_text, q_extra, cut_note = _fit(text, extra)
        quick = await _quick_reply(q_text, q_extra, reply_lang, depth, bool(meta.get("voice")),
                                   research=not has_records, deep=bool(meta.get("deep")), web=web_search)
        if cut_note:
            quick["text"] += "\n\n" + cut_note
        if src_rows:
            quick["sources"] = src_rows
            quick["text"] += sources.footer(src_rows)
        if pdf_names:
            quick["text"] += "\n\n*PDF padha: " + ", ".join(pdf_names) + "*"
        elif body.get("attachments"):
            quick["text"] += "\n\n*Attachment nahi padha; sirf text gaya.*"
        if _wants_pdf(text):
            _attach_pdf(quick, text, src_rows)
        return [quick]
    q_text, q_extra, cut_note = _fit(text, extra)
    question = q_text + q_extra
    topics = None
    # Thinking by the weight of the question (thinking.py): every council mode, never Standard. Internal only.
    weight = thinking.set_weight(thinking.weigh(text, ui_mode) if ui_mode != "standard" else None)
    try:
        # Big message in a council mode (V, Physics, Math, Business, Coding): split into sub-topics first, then the
        # council answers ONCE with a heading per sub-topic (bigtask.py). Standard never comes here.
        if (source == "auto" and ui_mode != "standard" and config.CHAT_ENGINE == "roles" and bigtask.BIG_INPUT_CHARS > 0
                and bigtask.is_big(text)):
            async with make_client() as client:
                topics = await bigtask.decompose(client, text, {})
            if len(topics) >= 2:
                ctx = extra[:1500]
                question = bigtask.brief(text, topics, MAX_QUESTION_CHARS - len(ctx)) + ctx
                cut_note = ""  # the sub-topic map covers the whole message
            else:
                topics = None
        res = await pipeline.run(
            question,
            deep=think == "deep",
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
            web_research=not private_context,
            topics=topics,
        )
    finally:
        thinking.reset(weight)
    replies: list[dict] = [{"type": "text", "text": _format_answer(res)}]
    if src_rows:
        replies[0]["sources"] = src_rows
        replies[0]["text"] += sources.footer(src_rows)
    if pdf_names:
        replies[0]["text"] += "\n\n*PDF padha: " + ", ".join(pdf_names) + "*"
    if _wants_pdf(text):
        _attach_pdf(replies[0], text, src_rows)
    if not config.CODE_EXEC_SUPPORTED and res.get("style") == "solve" and res.get("task_type") in config.VERIFY_TASKS:
        replies[0]["text"] += "\n\n*Android par code proof off hai: steps [REASONED] hain.*"
    if body.get("attachments") and not pdf_names:
        replies[0]["text"] += "\n\n*Attachment nahi padha; sirf text gaya.*"
    if cut_note:
        replies[0]["text"] += "\n\n" + cut_note
    # shown folded under the answer as "Worked through N steps"
    master = res.get("master")
    if master:
        steps = ["Manual · master answer (sirf tumhare answers se)"]
    elif res.get("engine") == "roles":
        steps = [f"Task: {res.get('task_type', 'general')} · mode {res.get('mode', 'standard')} · 11-role council"]
        cb = res.get("combo") or {}
        if cb:
            m = cb.get("models") or {}
            steps.append(f"{cb.get('title', '')} model combo: judge {m.get('judge')}, drafters {m.get('theorist')} + {m.get('empiricist')}"
                         f" + {m.get('specialist')}, falsifiers {', '.join(cb.get('falsifiers') or [])}")
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
    if res.get("calls"):
        replies[0]["calls"] = res["calls"]  # the chat's "model calls" toggle shows this under the answer
    if res.get("council"):
        replies[0]["council"] = res["council"]  # shown on its own page, not in the chat scroll
    if topics:
        replies[0]["steps"].insert(1, f"Bada input: {len(topics)} sub-topic me toda, ek council jawab")
    parts = res.get("parts") or []
    if len(parts) > 1:
        return _split_parts(replies[0], res, parts)
    return replies


def _split_parts(first: dict, res: dict, parts: list[str]) -> list[dict]:
    """A long council answer as separate chat messages Part 1/N ... N/N. Part 1 keeps steps / calls / council (the
    UI reads those from the first reply); the last part gets sources, warnings and the 'kahan galat' notes."""
    formatted = _format_answer(res)
    tail = formatted[len(res["answer"].strip()):].strip()  # sources block + warnings of the whole answer
    body_tail = first["text"][len(formatted):]  # notes added after formatting (code proofs, cut note)
    out = []
    for k, text in enumerate(parts, 1):
        rep = {"type": "text", "text": text.strip(), "part": {"n": k, "of": len(parts)}}
        if k == 1:
            rep.update({key: v for key, v in first.items() if key not in ("text", "notes", "type")})
        if k == len(parts):
            rep["text"] += ("\n\n" + tail if tail else "") + body_tail
            if first.get("notes"):
                rep["notes"] = first["notes"]
        out.append(rep)
    return out
