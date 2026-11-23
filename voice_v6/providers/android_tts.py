"""Last resort: Android's own TextToSpeech. It runs in Kotlin (Speaker.kt), so the engine only tells the UI to use it."""
from __future__ import annotations


def directive(text: str, lang: str) -> dict:
    return {"type": "device", "text": text, "lang": "hi-IN" if lang in ("hi", "hinglish") else "en-US"}
