"""Existing natural voice (Gemini -> Groq) wrapped unchanged; voice.py is NOT modified by this module."""
from __future__ import annotations


async def synth_remote(text: str, voice: str):
    import voice as v
    return await v._remote_synth(text, voice) if hasattr(v, "_remote_synth") else await v.synth(text, voice)
