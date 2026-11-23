"""Voice personality + engine knobs. Everything optional; no paid API is required."""
from __future__ import annotations
import os
from dataclasses import dataclass, asdict

# Benchmarked 2026-11-23 (6-core sandbox): Piper RTF 0.04-0.05, first audio ~0.15 s, 45-170 MB RAM;
# Kokoro RTF 0.58, 243 MB, English only -> not selected.
MODELS = {
    "hi": "hi_IN-rohan-medium",   # male Hindi; also reads Roman Hindi acceptably
    "en": "en_US-ryan-medium",    # male English
}
HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main/{path}"
HF_PATH = {"hi": "hi/hi_IN/rohan/medium/hi_IN-rohan-medium", "en": "en/en_US/ryan/medium/en_US-ryan-medium"}


def model_dir() -> str:
    return os.environ.get("PIPER_DIR") or os.path.join(os.environ.get("TTS_DIR") or os.path.expanduser("~/.adarsh"), "piper")


@dataclass
class VoiceProfile:
    gender: str = "male"
    rate: float = 1.0        # 0.5-2.0 speaking speed
    pitch: float = 1.0       # accepted, applied only where the engine supports it
    pause_ms: int = 220      # silence between sentences
    emotion: str = "neutral"
    fallback: bool = True    # allow offline fallback

    @classmethod
    def of(cls, d: dict | None) -> "VoiceProfile":
        d = d or {}
        p = cls()
        for k, v in d.items():
            if hasattr(p, k):
                try:
                    setattr(p, k, type(getattr(p, k))(v))
                except (TypeError, ValueError):
                    pass
        p.rate = min(2.0, max(0.5, p.rate))
        p.pitch = min(2.0, max(0.5, p.pitch))
        p.pause_ms = min(2000, max(0, p.pause_ms))
        return p

    def dict(self) -> dict:
        return asdict(self)
