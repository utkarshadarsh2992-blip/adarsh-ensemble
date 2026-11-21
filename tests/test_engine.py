"""Offline tests: no network. Providers are faked by patching llm.chat.
Run: python -m pytest tests -q
"""
import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")

import android_entry  # noqa: E402
import config  # noqa: E402
import llm  # noqa: E402
import pipeline  # noqa: E402
import sandbox  # noqa: E402
import verified  # noqa: E402

JUDGE_TEXT = "1. Direct Core Truth: 4.\n2. Verified Mechanism: 2+2 [PROVEN by code]\n3. Trap Warning: none"


@pytest.fixture(autouse=True)
def fake_models(monkeypatch):
    calls = []

    async def fake_chat(client, spec, messages, **kw):
        calls.append(spec.label)
        sys_text = messages[0]["content"] if messages else ""
        if spec is config.CLASSIFIER:
            return "math"
        if spec is config.STRIPPER:
            return json.dumps({"claims": []})
        return JUDGE_TEXT

    monkeypatch.setattr(pipeline, "chat", fake_chat)
    monkeypatch.setattr(verified, "chat", fake_chat)
    return calls


def test_provider_config_valid():
    assert config.PLAN_PROBLEMS == []
    assert set(config.PROVIDERS) == {"groq", "gemini", "openrouter"}


def test_every_role_has_fallbacks():
    for name, spec in config.all_roles():
        assert spec.fallbacks, name


def test_set_key_roundtrip(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    assert not config.PROVIDERS["groq"].api_key
    assert android_entry.set_key("GROQ_API_KEY", "gsk_test_123456")
    assert config.PROVIDERS["groq"].api_key == "gsk_test_123456"
    assert android_entry.set_key("GROQ_API_KEY", "")
    assert not config.PROVIDERS["groq"].api_key
    assert not android_entry.set_key("NOT_A_KEY", "x")


def test_pipeline_runs_fast_and_deep():
    for deep in (False, True):
        res = asyncio.run(pipeline.run("2+2 kya hai?", deep=deep, run_code=False, use_guard=False))
        assert "Direct Core Truth" in res["answer"]
        assert res["task_type"] == "math"


def test_lint_downgrades_unproven():
    out, warns = verified.lint_answer("x [PROVEN by code]", [])
    assert "[REASONED]" in out and warns


def test_sandbox_blocks_bad_code_and_unsupported(monkeypatch):
    monkeypatch.setattr(config, "CODE_EXEC_SUPPORTED", True)
    assert sandbox.run_python("import os\nprint('PASS')")["status"] == "REJECTED"
    assert sandbox.run_python("print('PASS')")["status"] == "PASS"
    monkeypatch.setattr(config, "CODE_EXEC_SUPPORTED", False)
    assert sandbox.run_python("print('PASS')")["status"] == "UNSUPPORTED"


def test_handle_without_keys(monkeypatch):
    for k in android_entry.KEY_NAMES:
        monkeypatch.delenv(k, raising=False)
    out = json.loads(android_entry.handle(json.dumps({"text": "hi there"})))
    assert "API key" in out["text"]


def test_handle_with_key_returns_replies(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    out = json.loads(android_entry.handle(json.dumps({"text": "2+2 kya hai?", "history": []})))
    assert out[0]["type"] == "text" and "Direct Core Truth" in out[0]["text"]


def test_handle_bad_json_and_ping():
    assert "samajh" in json.loads(android_entry.handle("{not json"))["text"]
    assert json.loads(android_entry.handle(json.dumps({"ping": True}))) == {"ok": True}


def test_provider_error_is_reported_and_key_scrubbed(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_secret_abcdef")

    async def boom(*a, **k):
        raise RuntimeError("401 for key gsk_secret_abcdef")

    monkeypatch.setattr(pipeline, "run", boom)
    out = json.loads(android_entry.handle(json.dumps({"text": "hello world"})))
    assert "gsk_secret_abcdef" not in out["text"] and "***" in out["text"]


def test_network_failure_falls_back_to_error_reply(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")

    async def down(*a, **k):
        raise llm.LLMError("all providers unreachable")

    monkeypatch.setattr(pipeline, "chat", down)
    monkeypatch.setattr(verified, "chat", down)
    out = json.loads(android_entry.handle(json.dumps({"text": "hello world"})))
    assert out["type"] == "text" if isinstance(out, dict) else out[0]["type"] == "text"
