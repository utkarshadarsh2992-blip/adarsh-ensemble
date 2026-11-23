"""Make text speakable: numbers, symbols, abbreviations. Technical terms stay intact."""
from __future__ import annotations
import re

ABBR = {"e.g.": "for example", "i.e.": "that is", "vs.": "versus", "vs": "versus", "etc.": "etcetera",
        "approx.": "approximately", "Dr.": "Doctor", "Mr.": "Mister"}
SYMBOLS = {"%": " percent", "&": " and ", "+": " plus ", "=": " equals ", "→": ", ", "->": ", ", "≈": " approximately ",
           "°C": " degrees Celsius", "°": " degrees", "₹": "rupees ", "$": "dollars ", "×": " times "}
ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def num_words(n: int) -> str:
    if n < 0:
        return "minus " + num_words(-n)
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + (" " + ONES[n % 10] if n % 10 else "")
    if n < 1000:
        return ONES[n // 100] + " hundred" + (" " + num_words(n % 100) if n % 100 else "")
    for size, name in ((10**9, "billion"), (10**6, "million"), (1000, "thousand")):
        if n >= size:
            return num_words(n // size) + " " + name + (" " + num_words(n % size) if n % size else "")
    return str(n)


def _num(m: re.Match) -> str:
    s = m.group(0).replace(",", "")
    if "." in s:
        a, b = s.split(".", 1)
        return f"{num_words(int(a or 0))} point " + " ".join(ONES[int(c)] for c in b)
    return num_words(int(s)) if len(s) <= 12 else " ".join(ONES[int(c)] for c in s)


def normalize(text: str, hindi_digits: bool = False) -> str:
    """Pure-Devanagari text keeps digits (Hindi model reads them); Latin text gets numbers spelled out."""
    t = text
    for k, v in ABBR.items():
        t = t.replace(k, v)
    for k, v in SYMBOLS.items():
        t = t.replace(k, v)
    if not hindi_digits:
        t = re.sub(r"\d[\d,]*(?:\.\d+)?", _num, t)
    t = re.sub(r"\s+", " ", t).strip()
    return t
