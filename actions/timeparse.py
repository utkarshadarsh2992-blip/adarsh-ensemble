"""When did the user mean? Relative ("10 minute baad") and absolute ("kal 7 baje", "at 7:30 pm")."""
from __future__ import annotations
import re
import time

WORD_NUM = {"ek": 1, "do": 2, "teen": 3, "char": 4, "chaar": 4, "paanch": 5, "panch": 5, "chhah": 6, "che": 6,
            "saat": 7, "aath": 8, "nau": 9, "das": 10, "gyarah": 11, "barah": 12, "pandrah": 15, "bees": 20,
            "pachees": 25, "tees": 30, "paintis": 35, "chalees": 40, "pachas": 50, "saath": 60, "aadha": 0.5}
UNITS = {"second": 1, "seconds": 1, "sec": 1, "secs": 1, "second": 1, "सेकंड": 1,
         "minute": 60, "minutes": 60, "min": 60, "mins": 60, "मिनट": 60,
         "hour": 3600, "hours": 3600, "hr": 3600, "hrs": 3600, "ghanta": 3600, "ghante": 3600,
         "घंटा": 3600, "घंटे": 3600}
DAYS = {"aaj": 0, "आज": 0, "today": 0, "kal": 1, "कल": 1, "tomorrow": 1,
        "parso": 2, "parson": 2, "परसों": 2, "day after tomorrow": 2}
PART = {"subah": 0, "savere": 0, "morning": 0, "सुबह": 0, "dopahar": 12, "afternoon": 12, "दोपहर": 12,
        "shaam": 12, "sham": 12, "evening": 12, "शाम": 12, "raat": 12, "night": 12, "रात": 12}
_UNIT = "|".join(sorted(UNITS, key=len, reverse=True))
_DAY = "|".join(sorted(DAYS, key=len, reverse=True))
_PART = "|".join(sorted(PART, key=len, reverse=True))
REL = re.compile(rf"(\w+)\s*({_UNIT})\s*(?:ka|ki|ke|baad|bad|later|mein|me|after|ke baad|baad mein|baad me)\b")
REL2 = re.compile(rf"\b(?:in|after)\s+(\w+)\s*({_UNIT})\b")
ABS = re.compile(r"(?:(\d{1,2})(?::(\d{2}))?\s*(?:baje|bje|बजे|o'?clock|oclock|hours))|(?:\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)")
AMPM = re.compile(r"\b(am|pm|a\.m|p\.m)\b")
DUR = re.compile(rf"(\w+)\s*({_UNIT})\b")


def _num(tok: str):
    tok = (tok or "").strip().lower()
    if tok.isdigit():
        return int(tok)
    return WORD_NUM.get(tok)


def duration(text: str) -> int | None:
    """Seconds for "5 minute", "do ghante", "90 sec"."""
    for m in DUR.finditer(text.lower()):
        n = _num(m.group(1))
        if n is None:
            continue
        return int(n * UNITS[m.group(2)])
    return None


def _label(ms: int, day_offset: int) -> str:
    t = time.localtime(ms / 1000)
    h = t.tm_hour
    ampm = "am" if h < 12 else "pm"
    h12 = h % 12 or 12
    base = f"{h12}:{t.tm_min:02d} {ampm}"
    return ("kal " if day_offset == 1 else "parso " if day_offset == 2 else "") + base


def when(text: str, now: int) -> tuple[int, str] | None:
    """(epoch ms, human label) or None."""
    t = " " + text.lower().strip() + " "
    rel = REL.search(t) or REL2.search(t)
    if rel:
        n = _num(rel.group(1))
        if n:
            secs = int(n * UNITS[rel.group(2)])
            at = now + secs * 1000
            return at, _label(at, 0)
    absm = ABS.search(t)
    if absm:
        hh = absm.group(1) or absm.group(3)
        mm = absm.group(2) or absm.group(4) or "0"
        hour, minute = int(hh), int(mm)
        if hour > 23 or minute > 59:
            return None
        low = t
        part = next((v for k, v in PART.items() if re.search(rf"\b{re.escape(k)}\b", low)), None)
        ampm = (absm.group(5) or "").lower() or (AMPM.search(low).group(1)[0] if AMPM.search(low) else "")
        if part is not None:
            if part == 0 and hour == 12:
                hour = 0
            elif part == 12 and hour < 12:
                hour += 12
        elif ampm == "pm" and hour < 12:
            hour += 12
        elif ampm == "am" and hour == 12:
            hour = 0
        elif ampm == "" and hour < 7:
            hour += 12   # "7 baje" said in the evening usually means 19:00
        day = next((v for k, v in DAYS.items() if re.search(rf"\b{re.escape(k)}\b", low)), None)
        lt = time.localtime(now / 1000)
        offset = day or 0
        at = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday + offset, hour, minute, 0, 0, 0, -1)) * 1000)
        if at < now - 60_000 and day is None:
            at += 86_400_000
            offset = 1
        return at, _label(at, offset)
    return None


def strip_time(text: str) -> str:
    """Remove the time expression and day/part words, so only the subject is left."""
    # Match case-insensitively but retain the user's original casing in the
    # subject (names and titles should not be silently lowercased).
    t = text or ""
    has_relative = REL.search(t.lower()) or REL2.search(t.lower())
    has_absolute = ABS.search(t)
    # A bare "kal/aaj" is often part of a task or note title.  Only strip day
    # and part-of-day words when a complete relative or clock expression was
    # actually found.
    if not has_relative and not has_absolute:
        return re.sub(r"\s{2,}", " ", t).strip()
    t = re.sub(REL.pattern, " ", t, flags=re.I)
    t = re.sub(REL2.pattern, " ", t, flags=re.I)
    t = re.sub(ABS.pattern, " ", t, flags=re.I)
    t = re.sub(rf"\b({_DAY}|{_PART}|aaj|kal|parso|today|tomorrow|at|baje|bje|o'?clock|am|pm|hours)\b", " ", t, flags=re.I)
    t = re.sub(r"\b(\d{1,2})\b", " ", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def clock(ms: int) -> str:
    t = time.localtime(ms / 1000)
    return f"{t.tm_hour % 12 or 12}:{t.tm_min:02d} {'am' if t.tm_hour < 12 else 'pm'}"
