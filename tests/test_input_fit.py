"""The user's message is never cut silently: extra context is trimmed first, a real cut is shown as a note."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")
import chat_adapter  # noqa: E402
import config  # noqa: E402
import pipeline  # noqa: E402
from tests.test_quick import _fake_standard, quick  # noqa: E402,F401


def test_fit_trims_context_before_the_message():
    text, extra, note = chat_adapter._fit("q" * 7000, "c" * 6000)
    assert text == "q" * 7000 and extra == "c" * 1000 and note == ""


def test_fit_keeps_short_input_whole():
    assert chat_adapter._fit("hello", "ctx") == ("hello", "ctx", "")


def test_fit_cut_is_announced():
    text, extra, note = chat_adapter._fit("q" * 9000, "c" * 100)
    assert len(text) == chat_adapter.MAX_QUESTION_CHARS and extra == ""
    assert "9,000" in note and "1,000" in note


def test_standard_long_message_reaches_model_and_note_is_shown(quick):
    long = "Mera sawaal: " + "x" * 8500
    out = asyncio.run(chat_adapter.handle({"text": long, "mode": "standard"}))
    sent = quick[0][1][1]["content"]
    assert sent.startswith(long[:7000]) and len(quick) == 1
    assert "Note:" in out[0]["text"] and out[0]["text"].startswith("Paris")


def test_standard_normal_message_has_no_note(quick):
    out = asyncio.run(chat_adapter.handle({"text": "France ki rajdhani?", "mode": "standard"}))
    assert "Note:" not in out[0]["text"]


def test_council_question_keeps_the_message_first(monkeypatch, quick):
    seen = {}

    async def fake_run(q, **kw):
        seen["q"] = q
        return {"answer": "ok", "task_type": "general", "style": "explain"}

    monkeypatch.setattr(pipeline, "run", fake_run)
    msg = "y" * 7990
    asyncio.run(chat_adapter.handle({"text": msg, "mode": "physics"}))
    assert seen["q"].startswith(msg) and len(seen["q"]) <= chat_adapter.MAX_QUESTION_CHARS


def test_heavy_models_get_300s_and_stage_total_480():
    assert config.model_timeout(config.REGISTRY["mistral-large-4"]) == 300.0
    assert config.model_timeout(config.REGISTRY["nemotron-ultra"]) == 300.0
    assert config.model_timeout(config.REGISTRY["gemini-3.8-flash"]) == 200.0
    assert config.PANEL_TIMEOUT_S >= 480.0
    assert config.PANEL_TIMEOUT_S > config.model_timeout(config.REGISTRY["mistral-large-4"])
