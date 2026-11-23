"""Rule-based command parser: Hindi, Hinglish and English. No model, no network."""
from __future__ import annotations
import re
import time
from . import schema
from . import timeparse as tp

FILLER = r"(?:please|plz|kar do|kardo|kar de|karo|krdo|lagao|lagado|lag do|set karo|set kar do|banao|bana do|bana de|" \
         r"likh do|likh lo|save karo|save kar do|shuru karo|start karo|start|do|de|dena|chalu karo|bhejo|bhej do)"
TRIM = re.compile(rf"\s*{FILLER}\s*$", re.I)
TAIL = re.compile(r"\s+(?:ka|ki|ke|ke liye|liye)$", re.I)
LEAD = re.compile(r"^\s*(?:ki|that|to|se)\s+", re.I)


def _clean(s: str) -> str:
    s = s.strip().strip(".!?।,;: ")
    s = TRIM.sub("", s).strip()
    s = TAIL.sub("", s).strip()
    s = LEAD.sub("", s).strip()
    s = re.sub(r"\s{2,}", " ", s)
    return s


def _clauses(text: str) -> list[str]:
    parts = re.split(r"\s+(?:aur|and|phir|then|uske baad|iske baad)\s+|;\s*|,\s*(?=\w+\s+(?:bhi\s+)?(?:kholo|lagao|banao|karo|open|add|set))", text, flags=re.I)
    return [p for p in (x.strip() for x in parts) if p]


def _app(t: str) -> str | None:
    for key, words in schema.APPS.items():
        for w in words:
            if re.search(rf"(?<!\w){re.escape(w)}(?!\w)", t):
                return key
    return None


def _step(action: str, **args) -> dict:
    return {"action": action, "args": args}


def one(text: str, now: int) -> dict | None:
    """One clause -> one raw step (validation happens later)."""
    t = " " + text.lower() + " "
    t = re.sub(r"[!?।]+", " ", t)

    # ---- notes first: "notes clear karo" must not become a note named "clear"
    if re.search(r"\b(note|notes|list)\b.*\b(clear|delete|hata|saaf|mita)\b", t) or re.search(r"\b(saare|all) notes\b", t):
        return _step("note.clear")

    # ---- phone status
    if re.search(r"\b(battery|charge|charging|phone status|device status|storage|ram)\b", t) and not re.search(r"\b(search|google|open|kholo)\b", t):
        return _step("phone.status")

    # ---- voice conversation
    if re.search(r"\b(voice mode|voice conversation|voice chat|baat karni hai|baat karte hain|bol ke baat)\b", t):
        return _step("voice.open")

    # ---- torch
    if re.search(r"\b(torch|flashlight|flash light)\b", t):
        off = re.search(r"\b(off|band|bnd|buza|bujha)\b", t)
        return _step("torch.set", on=not off)

    # ---- panels (wifi/bluetooth/brightness/dnd) - these only OPEN settings; Android forbids silent toggles
    for panel, words in schema.PANELS.items():
        if any(re.search(rf"(?<!\w){re.escape(w)}(?!\w)", t) for w in words):
            if panel == "dnd":
                off = re.search(r"\b(off|band|bnd|chalu|on)\b", t)
                if off and re.search(r"\b(dnd|do not disturb|silent)\b", t):
                    return _step("dnd.set", on=off.group(1) in ("chalu", "on"))
            if re.search(r"\b(band|bnd|off|on|chalu|kholo|khol do|open|settings?)\b", t):
                return _step("panel.open", panel=panel)

    # ---- timer
    if re.search(r"\btimer\b", t) or re.search(r"\bcountdown\b", t):
        secs = tp.duration(t)
        if secs:
            return _step("timer.start", seconds=secs, text=_clean(re.sub(r"\b(timer|countdown|ka|ki|ke|lagao|set|karo)\b", " ", t)))

    # ---- alarm
    if re.search(r"\balarm\b", t):
        w = tp.when(t, now)
        if w:
            label = _clean(tp.strip_time(re.sub(r"\b(alarm|lagao|set|karo|laga|do)\b", " ", t)))
            return _step("alarm.add", at=w[0], text=label or "Alarm", human=w[1])

    # ---- reminder
    if re.search(r"\b(reminder|remind|yaad dila|yaad dilao|yaad dilana|yaad karna)\b", t):
        w = tp.when(t, now)
        default = w is None
        if default:  # "reminder lagao" with no time: say so, use 10 minutes
            w = (now + 600_000, tp.clock(now + 600_000) + " (default 10 min)")
        body = re.sub(r"\b(reminder|remind|yaad dila|yaad dilao|yaad dilana|yaad karna|mujhe|me|to)\b", " ", t)
        body = _clean(tp.strip_time(body))
        return _step("reminder.add", at=w[0], text=body or "yaad dilana", human=w[1])

    # ---- calendar
    if re.search(r"\b(calendar|meeting|appointment|event)\b", t) and re.search(r"\b(add|banao|create|schedule|lagao|set)\b", t):
        w = tp.when(t, now)
        if w:
            title = _clean(tp.strip_time(re.sub(r"\b(calendar|meeting|appointment|event|add|banao|create|schedule|lagao|set|karo|mein|me)\b", " ", t)))
            return _step("calendar.add", at=w[0], title=title or ("Meeting" if "meeting" in t else "Event"),
                         minutes=60, human=w[1])

    # ---- message draft / call (always confirmed)
    m = re.search(r"\b(?:message|msg|text)\s+(?:karo|kar do|bhej do|bhejo|draft)\b", t) or \
        re.search(r"\b(?:whatsapp|sms)\b.*\b(?:bhej|bhejo|message|msg|text)\b", t)
    if m:
        to = re.search(r"([a-z\u0900-\u097F][\w\u0900-\u097F]{0,20})\s+ko\s+(?:message|msg|text|whatsapp)", t)
        body = re.search(r"\b(?:ki|that|:)\s+(.+)$", t)
        return _step("message.draft", to=(to.group(1).strip() if to else ""), text=(body.group(1).strip() if body else ""),
                     channel="whatsapp" if "whatsapp" in t else "sms")
    if re.search(r"\b(call karo|phone karo|dial karo|call lagao)\b", t):
        num = re.search(r"(\+?\d[\d ]{6,14})", t)
        who = re.search(r"\b(?:to|ko)\s+([a-z\u0900-\u097F][\w\u0900-\u097F ]{1,24})", t)
        return _step("call.dial", to=(num.group(1).strip() if num else (who.group(1).strip() if who else "")))

    # ---- app open
    app = _app(t)
    if app and re.search(r"\b(kholo|khol do|khol|open|launch|start|chalu karo)\b", t):
        return _step("app.open", app=app)
    if re.search(r"\b(open|kholo|launch)\b", t):
        m2 = re.search(r"\b(?:open|kholo|launch)\s+([a-z][\w ]{1,20})", t)
        if m2:
            key = _app(" " + m2.group(1) + " ")
            if key:
                return _step("app.open", app=key)

    # ---- web search
    m = re.search(r"\b(?:google|search|dhundo|dhunde)\b(?:\s+(?:par|pe|mein|me|for))?\s*(.*)$", t)
    if m and re.search(r"\b(google|search|dhundo|dhunde)\b", t):
        q = _clean(re.sub(r"\b(google|par|pe|mein|me|search|dhundo|dhunde|karo|kar|do|for)\b", " ", m.group(1)))
        if len(q) >= 2:
            return _step("web.search", query=q)

    # ---- note
    if re.search(r"\b(note|notes|likh lo|likh do|yaad rakho|save karo|save kar)\b", t):
        body = re.sub(r"\b(note|notes|banao|bana do|bana|likh lo|likh do|yaad rakho|save karo|save kar|mein|me|"
                      r"bhi|ek|new|naya|nayi|karo|kar do|ki|that)\b", " ", t)
        body = _clean(body)
        return _step("note.add", text=body)
    return None


def parse(text: str, now: int | None = None) -> list[dict]:
    """Command text -> raw steps (0-3). Empty list means "not a command"."""
    now = int(time.time() * 1000) if now is None else now
    src = (text or "").strip()
    if not src or len(src) > 400:
        return []
    parts = _clauses(src)
    steps: list[dict] = []
    if len(parts) > 1:
        for p in parts[: schema.MAX_STEPS]:
            s = one(p, now)
            if not s:
                steps = []     # one unclear clause: fall back to the whole sentence
                break
            steps.append(s)
    if not steps:
        whole = one(src, now)
        if not whole:
            return []
        steps = [whole]
    # "isi baat ka note bhi bana do": the note refers to the step before it
    for i, s in enumerate(steps):
        if s["action"] == "note.add" and i and re.match(r"^(isi|us|iske|uske|same|isko|yeh|ye|this)\b|^$", s["args"].get("text", "")):
            prev = steps[i - 1]["args"]
            s["args"]["text"] = prev.get("text") or prev.get("query") or prev.get("title") or "Note"
    return steps
