"""Learning layer (change 1.2): how the learner learns, in every mode.

- MENTOR_STYLE: concise learning preferences; explicit depth/format requests win, otherwise follow the selected mode.
  Standard gets it here; the council modes get the same points through prompts.LEARNER_PROFILE.
- Standard has two sub-styles (body.reply.std): "2.9" = short core answer first, the app then offers a
  "Gehrai mein jao" button; "9.2" = straight to the full deep answer the discoverer's way. ONE concept per answer,
  in Standard only (the council modes cover the whole question).
- Check questions: the model appends one hidden JSON block (MCQ when good options exist, otherwise fill-in). The
  app checks the answers on the phone, so checking costs no tokens. Standard writes the block in the same call;
  the council modes get it from one small Groq gpt-oss-20b call after the answer.
- Learned words: a word counts as learned as soon as it has been explained once. The app keeps the list and sends
  it back (body.learn.known), so the models never explain those words again.
"""
from __future__ import annotations

import json
import os
import re

import config
import prompts

CHECK_OPEN = "<<<ADARSH_CHECK"
CHECK_CLOSE = "ADARSH_CHECK>>>"
MAX_KNOWN = 150          # learned words sent with one request
MAX_KNOWN_CHARS = 1500
MAX_QUESTIONS = 5
MAX_WORDS = 10
# council modes: one small Groq call after the answer writes the check questions (CHECKS_POSTPASS=0 turns it off)
POSTPASS = os.getenv("CHECKS_POSTPASS", "1") != "0"

MENTOR_STYLE = prompts.LEARNING_STYLE

STD_STYLES = {
    "2.9": (
        "STANDARD 2.9 (short first): explain exactly ONE concept, the core one this question needs. If the question "
        "holds several concepts, take the first and name the next ones in one closing line. Normally use 90-160 words; "
        "if Sir explicitly asks for more depth, expand that same concept instead of forcing a short answer. The core "
        "idea in one or two sentences, one 'imagine this' picture that makes it felt, and one line on why it matters. "
        "No derivation or history unless he explicitly asks. Do not ask whether to go deeper or mention any button."
    ),
    "9.2": (
        "STANDARD 9.2 (deep, the discoverer's way): explain exactly ONE concept in full depth. If the question holds "
        "several concepts, take the first and list the next ones in one closing line. Use these short bold headings: "
        "**Problem** (what was not understood before; who, when) · **Trigger** (the observation or move that sparked "
        "the discoverer and how he likely reasoned, tagged) · **Building blocks** · **Mechanism** (how it actually "
        "works, with an 'imagine this' picture) · **Real use** (engineering, AI, rockets, robots) · **Limits** "
        "(assumptions and where it breaks) · **Builder link** (one small thing sir can build or test). No heavy "
        "derivation or long formula work (sir switches to the Physics or Math mode for that); at most one key "
        "relation, with every symbol explained."
    ),
}
DEEPER_NOTE = (
    "Sir has already read the short 2.9 answer on this concept and tapped 'Gehrai mein jao'. Go deep on the SAME "
    "concept now; do not repeat the short version."
)

_Q_RULES = (
    "questions test understanding of the concept, not trivia. {count} "
    'Use {{"kind":"mcq","q":"...","options":["...","...","...","..."],"answer":<0-based index>,"why":"one line"}} '
    'when good options exist, otherwise {{"kind":"fill","q":"...","answer":"short exact answer (1-3 words or a '
    'number)","accept":["other correct forms"],"why":"one line"}}. Write the questions in the reply language. '
    'words = every NEW technical word you defined in this answer, as {{"w":"word","m":"plain meaning, under 15 '
    'words"}}; never list a word sir already knows.'
)
COUNT_SHORT = "Ask 1 question; ask 2 only when the concept is reasoning-heavy (cause-effect chains, maths intuition, multi-step logic)."
COUNT_FULL = "Ask 2 questions normally and up to 4 when the concept is reasoning-heavy (cause-effect chains, maths intuition, multi-step logic)."


def check_rules(short: bool, ask_questions: bool = True) -> str:
    """Instruction for the hidden check block that Standard appends to its answer.
    With check questions off (Settings) the block still carries the new words, so they are remembered."""
    count = (COUNT_SHORT if short else COUNT_FULL) if ask_questions else "Check questions are off: questions must be []."
    return (
        "CHECK QUESTIONS: after the answer, append exactly one block, nothing after it:\n"
        f'{CHECK_OPEN}\n{{"concept":"<the one concept>","heavy":true or false,"questions":[...],"words":[...]}}\n{CHECK_CLOSE}\n'
        + _Q_RULES.format(count=count)
        + " The app reads and hides this block; never mention it in the answer."
    )


# ----------------------------------------------------------------------------- request side
def options(body: dict) -> dict:
    """What the app asked for: {"checks": bool, "known": [words]}."""
    learn = body.get("learn") if isinstance(body.get("learn"), dict) else {}
    meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
    voice = bool(meta.get("voice"))
    return {"checks": learn.get("checks", True) is not False and not voice, "block": not voice,
            "known": known_words(learn.get("known"))}


def known_words(raw) -> list[str]:
    out, seen, used = [], set(), 0
    for w in raw if isinstance(raw, list) else []:
        if not isinstance(w, str):
            continue
        w = " ".join(w.split())[:40]
        k = w.lower()
        if not w or k in seen:
            continue
        if len(out) >= MAX_KNOWN or used + len(w) + 2 > MAX_KNOWN_CHARS:
            break
        seen.add(k)
        out.append(w)
        used += len(w) + 2
    return out


def known_note(words: list[str]) -> str:
    if not words:
        return ""
    return "Words sir already knows (use them freely, never define them again): " + ", ".join(words) + "."


def std_style(body: dict) -> str:
    rp = body.get("reply") if isinstance(body.get("reply"), dict) else {}
    meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
    if meta.get("deeper"):
        return "9.2"
    return rp.get("std") if rp.get("std") in STD_STYLES else "2.9"


# ----------------------------------------------------------------------------- reply side
_BLOCK_RE = re.compile(re.escape(CHECK_OPEN) + r"\s*(.*?)\s*(?:" + re.escape(CHECK_CLOSE) + r"|$)", re.DOTALL)
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$")


def _json_obj(text: str):
    text = _FENCE_RE.sub("", (text or "").strip())
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        return json.loads(text[a:b + 1])
    except ValueError:
        return None


def split_checks(text: str, known: list[str] | None = None) -> tuple[str, dict | None]:
    """Answer text without the hidden block, and the cleaned check data (or None)."""
    text = text or ""
    i = text.rfind(CHECK_OPEN)
    if i < 0:
        return text, None
    m = _BLOCK_RE.match(text, i)
    body = m.group(1) if m else ""
    clean = text[:i].rstrip()
    return clean, clean_checks(_json_obj(body), known)


def _s(v, n: int) -> str:
    return " ".join(str(v).split())[:n] if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ""


def _mcq_answer(ans, opts: list[str]) -> int | None:
    if isinstance(ans, bool):
        return None
    if isinstance(ans, int):
        return ans if 0 <= ans < len(opts) else None
    if isinstance(ans, str):
        a = ans.strip()
        if a.isdigit():
            return _mcq_answer(int(a), opts)
        if len(a) == 1 and a.isalpha():
            k = ord(a.lower()) - ord("a")
            return k if 0 <= k < len(opts) else None
        for k, o in enumerate(opts):
            if o.strip().lower() == a.lower():
                return k
    return None


def clean_checks(raw, known: list[str] | None = None) -> dict | None:
    """Strict shape for the app: anything malformed is dropped, never shown half-broken."""
    if not isinstance(raw, dict):
        return None
    questions = []
    for q in raw.get("questions") if isinstance(raw.get("questions"), list) else []:
        if not isinstance(q, dict) or len(questions) >= MAX_QUESTIONS:
            continue
        text = _s(q.get("q") or q.get("question"), 300)
        why = _s(q.get("why"), 300)
        if not text:
            continue
        opts = [_s(o, 120) for o in q.get("options") or [] if _s(o, 120)] if isinstance(q.get("options"), list) else []
        kind = q.get("kind")
        if kind == "mcq" or (kind != "fill" and opts):
            opts = opts[:6]
            ans = _mcq_answer(q.get("answer"), opts)
            if len(opts) >= 2 and ans is not None:
                questions.append({"kind": "mcq", "q": text, "options": opts, "answer": ans, "why": why})
            continue
        ans = _s(q.get("answer"), 80)
        if not ans:
            continue
        accept = [_s(a, 80) for a in q.get("accept") or [] if _s(a, 80)][:6] if isinstance(q.get("accept"), list) else []
        questions.append({"kind": "fill", "q": text, "answer": ans, "accept": accept, "why": why})
    known_l = {w.lower() for w in known or []}
    words, seen = [], set()
    for w in raw.get("words") if isinstance(raw.get("words"), list) else []:
        if not isinstance(w, dict) or len(words) >= MAX_WORDS:
            continue
        word, meaning = _s(w.get("w") or w.get("word"), 40), _s(w.get("m") or w.get("meaning"), 160)
        if not word or not meaning or word.lower() in known_l or word.lower() in seen:
            continue
        seen.add(word.lower())
        words.append({"w": word, "m": meaning})
    if not questions and not words:
        return None
    return {"concept": _s(raw.get("concept"), 80), "heavy": raw.get("heavy") is True, "checks": questions, "words": words}


# ----------------------------------------------------------------------------- council modes: one small call
POST_SYSTEM = (
    "You write check questions for a beginner learner (called 'Sir') right after reading an answer. "
    "Output ONLY one JSON object, no prose: "
    '{"concept":"<main concept of the answer>","heavy":true or false,"questions":[...],"words":[...]}. '
)


def post_spec() -> config.ModelSpec:
    return config.use("gpt-oss-20b", "checks", fallbacks=("gemini-3.1-flash-lite",), extra={"reasoning_effort": "low"})


def post_messages(question: str, answer: str, known: list[str], reply_hint: str) -> list[dict]:
    system = POST_SYSTEM + _Q_RULES.format(count=COUNT_FULL) + " Only ask what the answer itself teaches. " + reply_hint
    user = f"Question:\n{question[:1500]}\n\nAnswer he read:\n{answer[:6000]}"
    if known:
        user += "\n\n" + known_note(known)
    return [{"role": "system", "content": system.strip()}, {"role": "user", "content": user}]


async def post_checks(question: str, answer: str, known: list[str], reply_hint: str = "") -> dict | None:
    """Check questions for a council answer. Never raises; None when no key or the call fails."""
    if not POSTPASS or not answer or not any(config.PROVIDERS[p].api_key for p in ("groq", "gemini")):
        return None
    import httpx
    from llm import chat
    try:
        async with httpx.AsyncClient() as client:
            text = await chat(client, post_spec(), post_messages(question, answer, known, reply_hint),
                              temperature=0.3, max_tokens=1400, timeout=40, retries=0, budget=45)
    except Exception:
        return None
    return clean_checks(_json_obj(text), known)
