"""When did the user mean? Relative and absolute Hindi/Hinglish times."""
from __future__ import annotations

import re
import time

WORD_NUM = {
    "ek": 1, "do": 2, "teen": 3, "char": 4, "chaar": 4, "paanch": 5, "panch": 5,
    "chhah": 6, "che": 6, "saat": 7, "aath": 8, "nau": 9, "das": 10,
    "gyarah": 11, "barah": 12, "pandrah": 15, "bees": 20, "pachees": 25,
    "tees": 30, "paintis": 35, "chalees": 40, "pachas": 50, "saath": 60, "aadha": 0.5,
}
UNITS = {
    "second": 1, "seconds": 1, "sec": 1, "secs": 1, "सेकंड": 1,
    "minute": 60, "minutes": 60, "min": 60, "mins": 60, "मिनट": 60,
    "hour": 3600, "hours": 3600, "hr": 3600, "hrs": 3600, "ghanta": 3600,
    "ghante": 3600, "घंटा": 3600, "घंटे": 3600,
}
DAYS = {
    "aaj": 0, "आज": 0, "kal": 1, "कल": 1, "tomorrow": 1,
    "parso": 2, "parson": 2, "परसों": 2, "day after tomorrow": 2,
}
PART = {
    "subah": 0, "savere": 0, "morning": 0, "सुबह": 0,
    "dopahar": 12, "afternoon": 12, "दोपहर": 12,
    "shaam": 12, "sham": 12, "evening": 12, "शाम": 12,
    "raat": 12, "night": 12, "रात": 12,
}
_UNIT = "|".join(sorted(UNITS, key=len, reverse=True))
_DAY = "|".join(sorted(DAYS, key=len, reverse=True))
_PART = "|".join(sorted(PART, key=len, reverse=True))
_SUFFIX = r"(?:ka|ki|ke|baad|बाद|bad|later|mein|me|after|ke baad|baad mein|baad me)"
# Whitespace lookarounds are intentional: Python's \b is unreliable for Devanagari.
REL = re.compile(rf"(?<!\S)(\w+)\s*({_UNIT})(?=\s|$)\s*{_SUFFIX}(?=\s|$)", re.IGNORECASE)
REL2 = re.compile(rf"(?<!\S)(?:in|after)\s+(\w+)\s*({_UNIT})(?=\s|$)", re.IGNORECASE)
ABS = re.compile(
    r"(?:(?P<hour>\d{1,2})(?:\s*-\s*\d{1,2})?(?::(?P<minute>\d{2}))?\s*"
    r"(?:baje|bje|बजे|o'?clock|oclock|hours)\s*"
    r"(?P<baje_ampm>a\.?m\.?|p\.?m\.?|am|pm)?|"
    r"\bat\s+(?P<at_hour>\d{1,2})(?::(?P<at_minute>\d{2}))?\s*"
    r"(?P<at_ampm>a\.?m\.?|p\.?m\.?|am|pm)?|"
    r"(?P<bare_hour>\d{1,2})\s*(?P<bare_ampm>a\.?m\.?|p\.?m\.?|am|pm))",
    re.IGNORECASE,
)
AMPM = re.compile(r"(?<!\S)(am|pm|a\.m\.?|p\.m\.?)\b", re.IGNORECASE)
DUR = re.compile(rf"(?<!\S)(\w+)\s*({_UNIT})(?=\s|$)", re.IGNORECASE)


def _num(tok: str):
    tok = (tok or "").strip().lower()
    if tok.isdigit():
        return int(tok)
    return WORD_NUM.get(tok)


def duration(text: str) -> int | None:
    """Seconds for ``5 minute`` and ``10 मिनट``."""
    for match in DUR.finditer(text.lower()):
        number = _num(match.group(1))
        if number is not None:
            return int(number * UNITS[match.group(2).lower()])
    return None


def _label(ms: int, day_offset: int) -> str:
    current = time.localtime(ms / 1000)
    hour = current.tm_hour
    ampm = "am" if hour < 12 else "pm"
    h12 = hour % 12 or 12
    base = f"{h12}:{current.tm_min:02d} {ampm}"
    return ("kal " if day_offset == 1 else "parso " if day_offset == 2 else "") + base


def _contains_word(text: str, words: list[str]) -> str | None:
    for word in sorted(words, key=len, reverse=True):
        if re.search(rf"(?<!\S){re.escape(word)}(?!\S)", text, re.IGNORECASE):
            return word
    return None


def when(text: str, now: int) -> tuple[int, str] | None:
    """Return ``(epoch milliseconds, human label)`` or ``None``."""
    lowered = (text or "").lower().strip()
    padded = f" {lowered} "
    relative = REL.search(padded) or REL2.search(padded)
    if relative:
        number = _num(relative.group(1))
        if number is not None:
            seconds = int(number * UNITS[relative.group(2).lower()])
            at = now + seconds * 1000
            return at, _label(at, 0)

    absolute = ABS.search(padded)
    if not absolute:
        return None
    hour_text = absolute.group("hour") or absolute.group("at_hour") or absolute.group("bare_hour")
    minute_text = absolute.group("minute") or absolute.group("at_minute") or "0"
    hour, minute = int(hour_text), int(minute_text)
    if hour > 23 or minute > 59:
        return None

    marker = _contains_word(lowered, list(PART))
    part = PART[marker] if marker else None
    ampm = (absolute.group("baje_ampm") or absolute.group("at_ampm") or absolute.group("bare_ampm") or "").lower().replace(".", "")
    if not ampm:
        found = AMPM.search(padded)
        ampm = found.group(1).lower().replace(".", "") if found else ""

    # Explicit AM/PM is authoritative, including in the ``baje`` branch.
    if ampm == "pm" and hour < 12:
        hour += 12
    elif ampm == "am" and hour == 12:
        hour = 0
    elif not ampm and part is not None:
        if hour == 12 and marker in ("raat", "night", "रात"):
            hour = 0
        elif part == 0 and hour == 12:  # subah 12 = midnight
            hour = 0
        elif marker in ("raat", "night", "रात") and 1 <= hour <= 4:
            # The early-morning part of रात remains AM; 8–11 are PM above.
            pass
        elif part == 12 and 1 <= hour <= 11:  # dopahar/shaam/raat 8 = 20
            hour += 12
    elif not ampm and hour < 7:
        # Preserve the long-standing conversational default for a bare early hour.
        hour += 12

    day_word = _contains_word(lowered, list(DAYS))
    requested_offset = DAYS[day_word] if day_word else 0
    current = time.localtime(now / 1000)
    at = int(time.mktime((current.tm_year, current.tm_mon, current.tm_mday + requested_offset,
                          hour, minute, 0, 0, 0, -1)) * 1000)

    # A clock without an explicit future day means the next occurrence. ``aaj`` at
    # a time already passed is also tomorrow (not yesterday), notably ``aaj 12 baje raat``.
    if at <= now and requested_offset == 0 and not ampm:
        at += 86_400_000
        requested_offset = 1
    return at, _label(at, requested_offset)


def strip_time(text: str) -> str:
    """Remove the time expression and day/part words, retaining the subject."""
    original = text or ""
    lower = original.lower()
    has_relative = REL.search(lower) or REL2.search(lower)
    has_absolute = ABS.search(original)
    if not has_relative and not has_absolute:
        return re.sub(r"\s{2,}", " ", original).strip()
    cleaned = re.sub(REL.pattern, " ", original, flags=re.IGNORECASE)
    cleaned = re.sub(REL2.pattern, " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(ABS.pattern, " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(rf"(?<!\S)({_DAY}|{_PART}|aaj|kal|parso|today|tomorrow|at|baje|bje|o'?clock|am|pm|hours)(?!\S)",
                     " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"(?<!\S)\d{1,2}(?!\S)", " ", cleaned)
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def clock(ms: int) -> str:
    current = time.localtime(ms / 1000)
    return f"{current.tm_hour % 12 or 12}:{current.tm_min:02d} {'am' if current.tm_hour < 12 else 'pm'}"
