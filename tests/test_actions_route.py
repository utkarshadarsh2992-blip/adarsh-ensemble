"""Standard mode routes in-app commands to the action layer without any model call."""
import asyncio
import os
import sys
import pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# imported inside the tests: importing at collection time would bind health.py to the wrong USAGE_FILE
# before test_quota.py sets it (module import order), which breaks that file's restart test.

run = asyncio.run


def mods():
    import chat_adapter, pipeline
    return chat_adapter, pipeline


@pytest.fixture
def no_models(monkeypatch):
    chat_adapter, pipeline = mods()
    calls = []

    async def fake_chat(*a, **k):
        calls.append(1)
        return "model answer"

    async def boom(*a, **k):
        raise AssertionError("the council must not run for a local command")

    monkeypatch.setattr(chat_adapter, "chat", fake_chat)
    monkeypatch.setattr(pipeline, "run", boom)
    return calls


def ask(text, mode="standard", **kw):
    chat_adapter, _ = mods()
    return run(chat_adapter.handle({"text": text, "mode": mode, **kw}))


def test_command_runs_locally(no_models):
    r = ask("5 minute ka timer lagao")
    r = r[0] if isinstance(r, list) else r
    assert r["type"] == "actions" and r["steps"][0]["action"] == "timer.start"
    assert r["text"].startswith("Ji Sir")
    assert no_models == []          # no model was asked


def test_multi_step_reply(no_models):
    r = ask("note banao ki paani peena aur YouTube kholo")
    r = r[0] if isinstance(r, list) else r
    assert len(r["steps"]) == 2 and r["needsConfirm"] is False


def test_normal_question_still_goes_to_model(no_models):
    r = ask("entropy kya hai")
    r = r[0] if isinstance(r, list) else r
    assert r["type"] == "text" and no_models


def test_actions_only_in_standard_mode(monkeypatch):
    chat_adapter, pipeline = mods()

    async def fake_run(*a, **k):
        return {"answer": "model answer", "models_used": {}, "task_type": "general", "style": "solve"}
    monkeypatch.setattr(pipeline, "run", fake_run)
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", False)
    r = ask("5 minute ka timer lagao", mode="research")
    r = r[0] if isinstance(r, list) else r
    assert r["type"] == "text" and "Standard select" in r["text"]


def test_manual_source_is_not_hijacked(monkeypatch):
    chat_adapter, pipeline = mods()

    async def fake_run(*a, **k):
        return {"answer": "model answer", "models_used": {}, "task_type": "general", "style": "solve"}
    monkeypatch.setattr(pipeline, "run", fake_run)
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", False)
    r = ask("5 minute ka timer lagao", source="manual", answers=[{"text": "x"}])
    r = r[0] if isinstance(r, list) else r
    assert r["type"] == "text"
