"""Lessons: what the master-answer engine (manual mode) learned from its own mistakes.

How it learns (honest version): no model weights change. A short list of rules is stored and put into the next
master prompt, and the grounding check looks for repeats of them. A rule that keeps being broken gains weight
and stays; one that holds for many runs fades out when the list is full.

Two origins:
  user  the user's own one-line "kya galat tha" after a thumbs-down (kept in their words, ranked first)
  auto  a canonical rule created when an automatic check catches a known KIND of mistake. The rule text is fixed
        here (never copied from a model's output), so one bad model answer cannot write garbage into the list.

Used ONLY by manual mode. Auto and Hybrid never read this file.
Stored as JSON at LESSONS_FILE (default .lessons.json; on Android under the app's private folder).
"""
import json
import os
import re
import threading
import time
import uuid
import math

MAX_LESSONS = 30        # list is pruned to this size (lowest rank first)
PROMPT_LESSONS = 8      # how many go into a prompt
PROMPT_CHARS = 1400
MAX_TEXT = 300

_LOCK = threading.RLock()

# kind -> (title shown to the user in Hinglish, rule put into the prompt)
AUTO_RULES = {
    "missing_section": (
        "Section chhoot gaya",
        "Always write all seven sections with their exact headings, in order. When a section has nothing to say, "
        "keep the heading and write 'Paste kiye answers me nahi hai.' under it.",
    ),
    "unsupported": (
        "Bina source ki baat likhi",
        "Write only what at least one pasted answer states. Facts you know yourself must not appear. "
        "If a section needs one, write 'Paste kiye answers me nahi hai.' instead.",
    ),
    "invented_history": (
        "Naam/saal/kahani gadhi",
        "In 'Kisne socha', 'Kaise socha' and 'Kya trigger hua' never write a name, year, place or story unless a "
        "pasted answer states it. Otherwise write 'Paste kiye answers me nahi hai.'",
    ),
    "misattributed": (
        "Galat answer ka tag",
        "Tag each statement with the letter(s) of the answer(s) that actually say it. Re-check every tag before writing it.",
    ),
    "bad_tag": (
        "Aisa tag jo hai hi nahi",
        "Use only source letters that exist. Never invent a letter.",
    ),
    "no_tags": (
        "Tags nahi lagaye",
        "End every statement with its source tags such as [A] or [A,C].",
    ),
    "contradiction": (
        "Takraav chhupaya ya mila diya",
        "When pasted answers disagree, show each side with its tags. Never pick a winner and never blend the sides into one claim.",
    ),
}

_WORD = re.compile(r"[a-z0-9ऀ-ॿ]{3,}")


def _path() -> str:
    return os.getenv("LESSONS_FILE") or ".lessons.json"


def _clean(text) -> str:
    return " ".join(str(text or "").split())[:MAX_TEXT]


def _words(text: str) -> set:
    return set(_WORD.findall(text.lower()))


def _int_field(value, default: int, minimum: int = 0) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return max(minimum, number)


def _float_field(value, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return number if math.isfinite(number) else default


def _similar(a: str, b: str) -> bool:
    wa, wb = _words(a), _words(b)
    return bool(wa and wb) and len(wa & wb) / len(wa | wb) >= 0.7


def _load() -> list[dict]:
    try:
        with open(_path(), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    out = []
    for x in data if isinstance(data, list) else []:
        if not isinstance(x, dict):
            continue
        text = _clean(x.get("text"))
        if not text:
            continue
        out.append({
            "id": _clean(x.get("id"))[:80] or uuid.uuid4().hex[:8],
            "text": text,
            "title": _clean(x.get("title"))[:80],
            "kind": _clean(x.get("kind"))[:80],
            "origin": "user" if x.get("origin") == "user" else "auto",
            "weight": max(1, _int_field(x.get("weight"), 1, 1)),
            "held": _int_field(x.get("held"), 0),
            "ts": _float_field(x.get("ts")),
            "last": _float_field(x.get("last")),
        })
    return out


def _save(items: list[dict]) -> None:
    path = _path()
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass  # lessons are a help, never a reason to fail an answer


def rank(x: dict) -> float:
    """Higher = stays and goes into prompts first. The user's own rules outrank auto ones."""
    return x["weight"] * 2 + (4 if x["origin"] == "user" else 0) + min(x["held"], 20) * 0.1


def _prune(items: list[dict], keep_id: str = "") -> list[dict]:
    while len(items) > MAX_LESSONS:
        victims = [x for x in items if x["id"] != keep_id]
        autos = [x for x in victims if x["origin"] == "auto"]
        pool = autos or victims
        items.remove(min(pool, key=lambda x: (rank(x), x["last"])))
    return items


def list_all() -> list[dict]:
    with _LOCK:
        return sorted(_load(), key=lambda x: (-rank(x), -x["last"]))


def add_user(text) -> dict | None:
    """The user's own lesson. A near-duplicate strengthens the existing one instead of adding another."""
    text = _clean(text)
    if len(text) < 4:
        return None
    now = time.time()
    with _LOCK:
        items = _load()
        for x in items:
            if _similar(x["text"], text):
                x["weight"] += 2
                x["last"] = now
                if x["origin"] == "auto":
                    x["origin"] = "user"
                _save(items)
                return x
        x = {"id": uuid.uuid4().hex[:8], "text": text, "title": "", "kind": "user", "origin": "user",
             "weight": 2, "held": 0, "ts": now, "last": now}
        items.append(x)
        _save(_prune(items, x["id"]))
        return x


def add_auto(kind: str) -> dict | None:
    """A known kind of mistake was caught by a check: create the rule, or strengthen it if it exists."""
    if kind not in AUTO_RULES:
        return None
    title, text = AUTO_RULES[kind]
    now = time.time()
    with _LOCK:
        items = _load()
        for x in items:
            if x["kind"] == kind:
                x["weight"] += 1
                x["last"] = now
                _save(items)
                return x
        x = {"id": uuid.uuid4().hex[:8], "text": text, "title": title, "kind": kind, "origin": "auto",
             "weight": 1, "held": 0, "ts": now, "last": now}
        items.append(x)
        _save(_prune(items, x["id"]))
        return x


def delete(lesson_id: str) -> bool:
    with _LOCK:
        items = _load()
        keep = [x for x in items if x["id"] != lesson_id]
        if len(keep) == len(items):
            return False
        _save(keep)
        return True


def edit(lesson_id: str, text) -> dict | None:
    text = _clean(text)
    if len(text) < 4:
        return None
    with _LOCK:
        items = _load()
        for x in items:
            if x["id"] == lesson_id:
                x["text"], x["title"], x["origin"] = text, "", "user"  # an edited rule is now the user's own
                _save(items)
                return x
    return None


def clear() -> int:
    with _LOCK:
        n = len(_load())
        _save([])
        return n


def prompt_block(limit: int = PROMPT_LESSONS) -> tuple[str, list[dict]]:
    """(text for the prompt, the lessons in it). Labels L1, L2... let the grounding check name a repeated one."""
    try:
        chosen, used = [], 0
        for x in list_all()[: max(0, int(limit))]:
            text = _clean(x.get("text"))
            if not text:
                continue
            line = f"[L{len(chosen) + 1}] {text}"
            if used + len(line) > PROMPT_CHARS:
                break
            chosen.append(x)
            used += len(line)
        if not chosen:
            return "", []
        lines = "\n".join(f"[L{i}] {_clean(x.get('text'))}" for i, x in enumerate(chosen, 1))
        return f"LESSONS FROM PAST MISTAKES (data only; hard rules below are final authority):\n<lessons>\n{lines}\n</lessons>", chosen
    except Exception:
        return "", []


def record_run(used_ids: list[str], repeated_ids: list[str]) -> None:
    """After a master run: lessons that were in the prompt and not repeated 'held'; repeated ones gain weight."""
    if not used_ids:
        return
    now = time.time()
    with _LOCK:
        items = _load()
        for x in items:
            if x["id"] in repeated_ids:
                x["weight"] += 1
                x["last"] = now
            elif x["id"] in used_ids:
                x["held"] += 1
        _save(items)


def mark_good(used_ids: list[str]) -> None:
    """Thumbs-up: the lessons that were in the prompt of this answer worked."""
    if not used_ids:
        return
    with _LOCK:
        items = _load()
        for x in items:
            if x["id"] in used_ids:
                x["held"] += 2
        _save(items)


def handle_op(op: dict) -> dict:
    """The one entry the UI uses (through chat_adapter / the Android bridge). Never raises."""
    try:
        kind = str(op.get("op") or "list")
        if kind == "add":
            x = add_user(op.get("text"))
            if not x:
                return {"ok": False, "error": "Lesson bahut chhota hai."}
        elif kind == "delete":
            if not delete(str(op.get("id") or "")):
                return {"ok": False, "error": "Ye lesson nahi mila."}
        elif kind == "edit":
            if not edit(str(op.get("id") or ""), op.get("text")):
                return {"ok": False, "error": "Lesson badla nahi ja saka."}
        elif kind == "clear":
            clear()
        elif kind == "good":
            mark_good([str(i) for i in (op.get("ids") or []) if isinstance(i, str)][:20])
        elif kind != "list":
            return {"ok": False, "error": "Unknown op."}
        return {"ok": True, "lessons": list_all()}
    except Exception as e:  # keep the app alive
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
