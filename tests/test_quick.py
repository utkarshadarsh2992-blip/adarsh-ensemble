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
import health  # noqa: E402
import llm  # noqa: E402
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


def test_standard_image_uses_groq_qwen_vision_and_image_only_gets_default_prompt(monkeypatch, quick):
    seen = {}

    class Client:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return False

    async def fake_chat(client, spec, messages, **kw):
        seen.update(spec=spec, messages=messages, kw=kw)
        health.trace_add(spec, spec, True, messages=messages, output="Photo mein ek laal ball dikh rahi hai.")
        return "Photo mein ek laal ball dikh rahi hai."

    monkeypatch.setattr(chat_adapter, "make_client", Client)
    monkeypatch.setattr(chat_adapter, "chat", fake_chat)
    photo = base64.b64encode(b"\xff\xd8\xfffake-jpeg").decode("ascii")
    async def ask():
        result = await chat_adapter.handle({"mode": "standard", "text": "", "attachments": [
            {"kind": "image", "type": "image/jpeg", "dataUrl": "data:image/jpeg;base64," + photo}
        ]})
        return result, health._trace.get()
    out, trace = run(ask())
    assert "Qwen 3.8 27B vision" in out[0]["steps"][0]
    assert seen["spec"].provider == "groq" and seen["spec"].model == "qwen/qwen3.8-27b"
    assert seen["spec"].fallbacks == (), "camera vision never silently falls back to a different provider/model"
    parts = seen["messages"][1]["content"]
    assert parts[0]["text"] == "Is photo mein kya dikh raha hai?"
    assert parts[1]["image_url"]["url"].endswith(photo)
    assert out[0]["text"].startswith("Photo mein")
    assert seen["kw"]["max_tokens"] <= config.tpm_limit(seen["spec"]) - llm._est_tokens(seen["messages"])
    assert trace and all("prompt" not in row for row in trace)
    assert photo not in json.dumps(trace)


def test_photo_analysis_is_rejected_outside_standard_and_when_qwen_is_controller_disabled(monkeypatch, quick):
    photo = base64.b64encode(b"\xff\xd8\xfffake-jpeg").decode("ascii")
    attachment = {"kind": "image", "type": "image/jpeg", "dataUrl": "data:image/jpeg;base64," + photo}
    out = run(chat_adapter.handle({"mode": "physics", "text": "Is photo ko samjhao", "attachments": [attachment]}))
    assert "sirf Standard" in out["text"]
    monkeypatch.setattr(config, "DISABLED_LABELS", frozenset({"qwen3.8-27b"}))
    out = run(chat_adapter.handle({"mode": "standard", "text": "Is photo ko samjhao", "attachments": [attachment]}))
    assert "disabled" in out[0]["text"]


def test_vision_prompt_over_the_groq_tpm_budget_is_rejected_before_call(quick):
    photo = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xffphoto").decode("ascii")
    attachments = [{"kind": "image", "type": "image/jpeg", "dataUrl": photo} for _ in range(3)]
    out = run(chat_adapter.handle({"mode": "standard", "text": "x" * 8000, "attachments": attachments}))
    assert "tokens/min limit" in out[0]["text"]
    assert quick == [], "over-budget image prompts are rejected before model traffic"


def test_multimodal_budget_and_system_merge_do_not_count_or_stringify_base64():
    short_url = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xffx").decode()
    long_url = "data:image/jpeg;base64," + ("A" * 1_000_000)
    def messages(url):
        return [{"role": "system", "content": "Analyze the image."},
                {"role": "user", "content": [{"type": "text", "text": "What is shown?"},
                                                  {"type": "image_url", "image_url": {"url": url}}]}]
    assert llm._est_tokens(messages(short_url)) == llm._est_tokens(messages(long_url))
    merged = llm._merge_system(messages(long_url))
    assert merged[0]["content"][0] == {"type": "text", "text": "Analyze the image."}
    assert merged[0]["content"][2]["image_url"]["url"] == long_url


def test_standard_voice_asks_for_spoken_style(quick):
    run(chat_adapter.handle({"text": "France ki rajdhani kya hai?", "mode": "standard", "meta": {"voice": True}}))
    assert "read aloud" in quick[0][1][0]["content"]


def test_live_delegate_returns_clickable_sources_and_respects_search_setting(monkeypatch, quick):
    async def fake(messages, **kw):
        quick.append(("gpt-oss-120b", messages, kw))
        return {"text": "Lunar eclipses happen when Earth blocks sunlight from the Moon.",
                "used": "gpt-oss-120b", "searches": 0, "wiki": ["lunar eclipse"],
                "sources": [{"title": "Lunar eclipse", "url": "https://en.wikipedia.org/wiki/Lunar_eclipse"}], "secs": 0.1}

    monkeypatch.setattr(chat_adapter.standard_agent, "answer", fake)
    out = run(chat_adapter.handle({
        "text": "Explain how a lunar eclipse happens.", "mode": "standard",
        "meta": {"voice": True, "live_delegate": True},
        "reply": {"web": "off"},
        "access": {"localRead": False, "personalOnline": False, "currentChat": False, "oldChats": False},
    }))
    assert quick[-1][2]["web"] is False, "Live delegation respects the app's web-search-off setting"
    assert out[0]["sources"] == [{"title": "Lunar eclipse", "url": "https://en.wikipedia.org/wiki/Lunar_eclipse"}]
    assert "[Lunar eclipse](https://en.wikipedia.org/wiki/Lunar_eclipse)" in out[0]["text"]


def test_live_delegate_skips_controller_disabled_gpt120b(monkeypatch, quick):
    monkeypatch.setattr(config, "DISABLED_LABELS", frozenset({"gpt-oss-120b"}))
    async def no_sources(_text):
        return "", []
    monkeypatch.setattr(chat_adapter.sources, "gather", no_sources)
    before = len(quick)
    out = run(chat_adapter.handle({
        "text": "Explain how a lunar eclipse happens.", "mode": "standard",
        "meta": {"voice": True, "live_delegate": True},
        "access": {"localRead": False, "personalOnline": False, "currentChat": False, "oldChats": False},
    }))
    assert len(quick) == before, "a controller-disabled GPT-120B is never contacted"
    assert "disabled" in out[0]["text"].lower()


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
    # two live TTS models: model 1 is missing (404 -> skipped), model 2 key 1 is out of quota (429 -> rests),
    # model 2 key 2 speaks
    monkeypatch.setenv("GEMINI_API_KEY_2", "g-test-key-456")
    monkeypatch.delenv("GEMINI_API_KEY_3", raising=False)
    tried = []

    async def fake_post(self, url, **kw):
        tried.append((url.split("/models/")[1].split(":")[0], kw["headers"]["x-goog-api-key"]))
        if len(tried) == 1:
            return _Resp(404, text="not found")
        if len(tried) == 2:
            return _Resp(429, text="quota")
        return _gemini_ok(b"\x01\x00" * 50)

    monkeypatch.setattr("httpx.AsyncClient.post", fake_post)
    out = run(voice.handle({"text": "Hello there my friend"}))
    assert out["type"] == "audio" and out["model"] == voice.GEMINI_MODELS[1] and len(tried) == 3
    assert [m for m, _ in tried] == [voice.GEMINI_MODELS[0], voice.GEMINI_MODELS[1], voice.GEMINI_MODELS[1]]
    assert [key for _, key in tried[1:]] == ["g-test-key-123", "g-test-key-456"]
    assert tried[0][0] in voice._dead and tried[1][0] in voice._rest


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
