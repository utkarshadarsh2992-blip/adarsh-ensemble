"""Whole-text offline synth used by voice.synth() as the last neural fallback."""
from __future__ import annotations
import asyncio
from . import hinglish_processor as hp, voice_config as cfg, voice_router as r
from .providers import local_tts


async def synth(text: str) -> tuple[bytes, str]:
    import voice
    if r.is_dead("local"):
        raise voice.VoiceError("piper unavailable")
    plan = hp.plan(text)
    if not plan:
        raise voice.VoiceError("bolne ko kuch nahi")
    try:
        wavs = [await asyncio.to_thread(r.local_wav, s, cfg.VoiceProfile()) for s in plan]
    except local_tts.VoiceUnavailable as e:
        r.mark_dead("local")
        raise voice.VoiceError(str(e))
    import io, wave
    pcm, rate = b"", 22050
    for w in wavs:
        with wave.open(io.BytesIO(w)) as f:
            rate = f.getframerate(); pcm += f.readframes(f.getnframes()) + b"\x00\x00" * int(rate * 0.22)
    return local_tts.wav_bytes(pcm, rate), "piper-offline"
