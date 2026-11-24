"""voice.py TTS model list: the Gemini TTS previews Google shut down on Nov 17, 2026 are never tried."""
import importlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))


def _load(monkeypatch, value=None):
    if value is None:
        monkeypatch.delenv("TTS_MODELS", raising=False)
    else:
        monkeypatch.setenv("TTS_MODELS", value)
    import voice
    return importlib.reload(voice)


def test_default_list_has_only_the_live_3_8_tts_models(monkeypatch):
    voice = _load(monkeypatch)
    assert voice.GEMINI_MODELS == ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"]


def test_an_old_setting_that_still_names_retired_models_drops_them(monkeypatch):
    voice = _load(monkeypatch, "gemini-3.8-flash-tts, gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts")
    assert voice.GEMINI_MODELS == ["gemini-3.8-flash-tts"]
    _load(monkeypatch)  # leave the module as the other tests expect it
