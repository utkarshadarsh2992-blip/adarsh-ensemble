"""Standard mode = one quick call; natural voice (voice.py); Council fast/deep switch."""
import asyncio
import base64
import json
import os
import struct
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import chat_adapter  # noqa: E402
import config  # noqa: E402
import pipeline  # noqa: E402
import voice  # noqa: E402


def _fake_standard(calls=None, text="model answer", fail=False):
    """Stand-in for standard_agent.answer (Standard mode = Groq gpt-oss-120b only)."""
    import standard_agent
    async def fake(messages, **kw):
        if calls is not None:
            calls.append(("gpt-oss-120b", messages, kw))
        if fail:
            raise standard_agent.StandardError("Sir, Groq ki teeno keys se jawab nahi aaya. Standard mode sirf Groq use karta hai.")
        return {"text": text, "used": "gpt-oss-120b", "searches": 0, "wiki": [], "sources": [], "secs": 0.1}
    return fake
def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def quick(monkeypatch):
    calls = []

    async def fake_chat(client, spec, messages, **kw):
        raise AssertionError("Standard must not use the multi-provider chat() chain")
    async def boom(*a, **k):
        raise AssertionError("the council pipeline must not run for Standard")
    monkeypatch.setattr(chat_adapter, "chat", fake_chat)
    monkeypatch.setattr(chat_adapter.standard_agent, "answer", _fake_standard(calls, "Paris hai France ki rajdhani."))
    monkeypatch.setattr(pipeline, "run", boom)
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", True)
    return calls


def test_quick_plan_is_valid():
    assert config.check_chains([("quick", config.QUICK)]) == []
    assert any(n == "quick" for n, _ in config.all_roles())


def test_standard_is_one_call(quick):
    out = run(chat_adapter.handle({"text": "France ki rajdhani kya hai?", "mode": "standard"}))
    assert len(quick) == 1 and quick[0][0] == "gpt-oss-120b"
    assert out[0]["text"].startswith("Paris")
    assert "Groq" in out[0]["steps"][0] and "sirf Groq" in out[0]["steps"][0]
    assert quick[0][2]["tools"] is True  # web search + Wikipedia tools offered


def test_standard_voice_asks_for_spoken_style(quick):
    run(chat_adapter.handle({"text": "France ki rajdhani kya hai?", "mode": "standard", "meta": {"voice": True}}))
    assert "read aloud" in quick[0][1][0]["content"]


def test_depth_changes_the_instruction(quick):
    run(chat_adapter.handle({"text": "Explain TCP", "mode": "standard", "reply": {"depth": "simple"}}))
    assert "very short" in quick[0][1][0]["content"]


def test_other_modes_still_use_the_council(monkeypatch, quick):
    seen = {}

    async def fake_run(q, **kw):
        seen.update(kw)
        return {"answer": "ok", "task_type": "math", "style": "solve"}

    monkeypatch.setattr(pipeline, "run", fake_run)
    run(chat_adapter.handle({"text": "Prove sqrt2 is irrational", "mode": "math", "reply": {"think": "deep"}}))
    assert seen["mode"] == "math" and seen["deep"] is True and not quick
    run(chat_adapter.handle({"text": "Prove sqrt2 is irrational", "mode": "math", "reply": {"think": "fast"}}))
    assert seen["deep"] is False


def test_quick_failure_keeps_standard_without_council(monkeypatch, quick):
    async def fake_run(q, **kw):
        raise AssertionError("Standard must not promote to the council on failure")
    monkeypatch.setattr(chat_adapter.standard_agent, "answer", _fake_standard(fail=True))
    monkeypatch.setattr(pipeline, "run", fake_run)
    out = run(chat_adapter.handle({"text": "France ki rajdhani kya hai?", "mode": "standard"}))
    assert "Groq" in out[0]["text"] and out[0]["uiMode"] == "standard"


# ------------------------------------------------------------------ voice.py
def test_wav_wrapper_has_valid_header():
    pcm = b"\x01\x00" * 100
    w = voice.wav(pcm)
    assert w[:4] == b"RIFF" and w[8:12] == b"WAVE" and w[36:40] == b"data"
    assert struct.unpack("<I", w[40:44])[0] == len(pcm)
    assert struct.unpack("<I", w[24:28])[0] == 24000
    assert voice.pcm_of(w) == pcm


def test_clean_speakable_text():
    t = voice.clean("## Short answer\n**Paris** hai [S1]. See https://x.org and `code`.\n- one\n```py\nprint(1)\n```\nConfidence: high")
    assert "#" not in t and "*" not in t and "[S1]" not in t and "http" not in t and "print" not in t and "Confidence" not in t
    assert "Paris hai" in t


def test_chunks_respect_limit():
    text = " ".join(["Yeh ek chhota vakya hai."] * 30)
    parts = voice.chunks(text, 200)
    assert all(len(p) <= 200 for p in parts) and " ".join(parts).split() == text.split()


class _Resp:
    def __init__(self, code, data=None, text=""):
        self.status_code, self._d, self.text = code, data, text

    def json(self):
        return self._d


def _gemini_ok(pcm):
    return _Resp(200, {"candidates": [{"content": {"parts": [{"inlineData": {
        "mimeType": "audio/L16;codec=pcm;rate=24000", "data": base64.b64encode(pcm).decode()}}]}}]})


@pytest.fixture
def tts_env(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "g-test-key-123")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setenv("TTS_DIR", str(tmp_path))
    voice._dead.clear(); voice._rest.clear(); voice._cache.clear()
    return tmp_path


def test_voice_returns_wav_file_and_caches(monkeypatch, tts_env):
    posts = []

    async def fake_post(self, url, **kw):
        posts.append((url, kw["json"]))
        return _gemini_ok(b"\x02\x00" * 500)

    monkeypatch.setattr("httpx.AsyncClient.post", fake_post)
    out = run(voice.handle({"text": "Namaste, **main** Adarsh hoon.", "voice": "Orus"}))
    assert out["type"] == "audio" and out["file"].endswith(".wav")
    data = open(out["file"], "rb").read()
    assert data[:4] == b"RIFF" and len(data) > 1000
    sent = posts[0][1]
    assert sent["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Orus"
    assert "*" not in json.dumps(sent["contents"])
    again = run(voice.handle({"text": "Namaste, **main** Adarsh hoon.", "voice": "Orus"}))
    assert again.get("cached") and len(posts) == 1


def test_voice_skips_missing_model_and_rests_on_429(monkeypatch, tts_env):
    tried = []

    async def fake_post(self, url, **kw):
        tried.append(url.split("/models/")[1].split(":")[0])
        if len(tried) == 1:
            return _Resp(404, text="not found")
        if len(tried) == 2:
            return _Resp(429, text="quota")
        return _gemini_ok(b"\x01\x00" * 50)

    monkeypatch.setattr("httpx.AsyncClient.post", fake_post)
    out = run(voice.handle({"text": "Hello there my friend"}))
    assert out["type"] == "audio" and len(tried) == 3
    assert tried[0] in voice._dead and tried[1] in voice._rest


def test_voice_without_any_key_reports_error(monkeypatch, tmp_path):
    for k in ("GEMINI_API_KEY", "GROQ_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("TTS_DIR", str(tmp_path))
    out = run(voice.handle({"text": "Hello there"}))
    assert out["type"] == "error"


def test_adapter_routes_tts(monkeypatch):
    async def fake(req):
        return {"type": "audio", "b64": "AA=="}

    monkeypatch.setattr(voice, "handle", fake)
    assert run(chat_adapter.handle({"tts": {"text": "hi"}}))["type"] == "audio"
