"""Split text into sentences, then each sentence into language spans (hi / en) for routing."""
from __future__ import annotations
import re
from dataclasses import dataclass
from .language_detector import word_lang, detect, DEVA
from .text_normalizer import normalize

_SENT = re.compile(r"(?<=[.!?।॥])\s+|\n+")
_TOK = re.compile(r"\s+|[A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F']*|[^\sA-Za-z\u0900-\u097F]+")


@dataclass
class Span:
    lang: str   # 'hi' | 'en'
    text: str


def sentences(text: str, max_len: int = 220) -> list[str]:
    out = []
    for s in _SENT.split(text.strip()):
        s = s.strip()
        while len(s) > max_len:  # break very long sentences at a comma/space
            cut = max(s.rfind(",", 0, max_len), s.rfind(" ", 0, max_len))
            cut = cut if cut > 40 else max_len
            out.append(s[:cut + 1].strip())
            s = s[cut + 1:].strip()
        if s:
            out.append(s)
    return out


def spans(sentence: str) -> list[Span]:
    """Hindi words (Devanagari or Roman Hindi) go to the Hindi voice, everything else to English.
    Punctuation/digits stick to the preceding span. A lone English word inside Hindi stays with Hindi
    (the Hindi model reads short English terms fine; switching voices mid-phrase sounds choppy)."""
    toks = _TOK.findall(sentence)
    raw: list[Span] = []
    for t in toks:
        if t.isspace() or not re.match(r"[A-Za-z\u0900-\u097F]", t):
            lang = raw[-1].lang if raw else "en"
        else:
            lang = word_lang(t)
        if raw and raw[-1].lang == lang:
            raw[-1].text += t
        else:
            raw.append(Span(lang, t))
    # absorb tiny English islands (<=2 words) that sit between Hindi spans, or at the edge of a Hindi sentence
    for i, s in enumerate(raw):
        if s.lang == "en" and len(s.text.split()) <= 2:
            near = [raw[j].lang for j in (i - 1, i + 1) if 0 <= j < len(raw)]
            if near and all(n == "hi" for n in near):
                s.lang = "hi"
    merged: list[Span] = []
    for s in raw:
        if merged and merged[-1].lang == s.lang:
            merged[-1].text += s.text
        else:
            merged.append(Span(s.lang, s.text))
    return merged


def plan(text: str) -> list[dict]:
    """[{index, text, lang, spans:[{lang,text}]}] with numbers normalised per span."""
    out = []
    for i, s in enumerate(sentences(text)):
        sp = []
        for x in spans(s):
            t = normalize(x.text, hindi_digits=bool(DEVA.search(x.text)))
            if t:
                sp.append(Span(x.lang, t))
        if sp:
            out.append({"index": len(out), "text": " ".join(x.text for x in sp), "lang": detect(s),
                        "spans": [{"lang": x.lang, "text": x.text} for x in sp]})
    return out
