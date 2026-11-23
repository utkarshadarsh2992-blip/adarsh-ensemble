"""Offline neural voice: Piper (ONNX). Optional dependency; every failure is a clean VoiceUnavailable."""
from __future__ import annotations
import io, os, threading, wave
from .. import voice_config as cfg


class VoiceUnavailable(Exception):
    pass


_voices: dict = {}
_lock = threading.Lock()


def _paths(lang: str) -> tuple[str, str]:
    base = os.path.join(cfg.model_dir(), cfg.MODELS[lang])
    return base + ".onnx", base + ".onnx.json"


def installed(lang: str) -> bool:
    return all(os.path.exists(p) for p in _paths(lang))


def available() -> dict:
    try:
        import piper  # noqa: F401
        engine = True
    except Exception:
        engine = False
    return {"engine": engine, "hi": installed("hi"), "en": installed("en"), "dir": cfg.model_dir()}


def _load(lang: str):
    with _lock:
        if lang in _voices:
            return _voices[lang]
        try:
            from piper import PiperVoice
        except Exception as e:
            raise VoiceUnavailable(f"piper not installed ({type(e).__name__})")
        if not installed(lang):
            raise VoiceUnavailable(f"piper model '{cfg.MODELS[lang]}' missing in {cfg.model_dir()}")
        try:
            _voices[lang] = PiperVoice.load(_paths(lang)[0], config_path=_paths(lang)[1])
        except Exception as e:
            raise VoiceUnavailable(f"piper load failed: {str(e)[:120]}")
        return _voices[lang]


def pcm(text: str, lang: str, rate: float = 1.0) -> tuple[bytes, int]:
    """(16-bit mono PCM, sample rate). rate>1 = faster (Piper length_scale)."""
    v = _load(lang)
    try:
        from piper import SynthesisConfig
        kw = {"syn_config": SynthesisConfig(length_scale=1.0 / max(0.5, min(2.0, rate)))}
    except Exception:
        kw = {}
    try:
        data = b"".join(c.audio_int16_bytes for c in v.synthesize(text, **kw))
    except Exception as e:
        raise VoiceUnavailable(f"piper synth failed: {str(e)[:120]}")
    if not data:
        raise VoiceUnavailable("piper produced no audio")
    return data, int(v.config.sample_rate)


def wav_bytes(data: bytes, rate: int) -> bytes:
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(data)
    return b.getvalue()


def install(langs=("hi", "en"), fetch=None) -> dict:
    """Download missing models (~60 MB each) once. `fetch(url, dest)` is injectable for tests."""
    import urllib.request
    fetch = fetch or (lambda u, d: urllib.request.urlretrieve(u, d))
    os.makedirs(cfg.model_dir(), exist_ok=True)
    res = {}
    for lang in langs:
        if installed(lang):
            res[lang] = "present"
            continue
        try:
            onnx, js = _paths(lang)
            for url_suffix, dest in ((".onnx", onnx), (".onnx.json", js)):
                tmp = dest + ".part"
                fetch(cfg.HF.format(path=cfg.HF_PATH[lang] + url_suffix), tmp)
                os.replace(tmp, dest)
            res[lang] = "installed"
        except Exception as e:
            res[lang] = f"failed: {str(e)[:100]}"
    return res
