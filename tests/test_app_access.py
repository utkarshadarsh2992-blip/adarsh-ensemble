"""Privacy, permission, local-action, and routing regressions.

Imports of modules that transitively import health.py stay inside tests/helpers.  This
keeps collection independent of the quota test's USAGE_FILE setup.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _adapter_modules():
    import chat_adapter
    import pipeline

    return chat_adapter, pipeline


def _fake_result():
    return {
        "answer": "fake answer",
        "engine": "roles",
        "task_type": "general",
        "style": "solve",
        "models_used": {},
        "sources": [],
        "latency_s": 0,
    }


def _capture_pipeline(monkeypatch, *, quick=False):
    chat_adapter, pipeline = _adapter_modules()
    seen = {}
    calls = []

    async def fake_run(question, **kwargs):
        seen["question"] = question
        seen.update(kwargs)
        calls.append((question, kwargs))
        return _fake_result()

    monkeypatch.setattr(pipeline, "run", fake_run)
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", quick)
    return chat_adapter, seen, calls


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
def _reply(value):
    return value[0] if isinstance(value, list) else value


# ---------------------------------------------------------------------------
# Permissions and bounded private context


def test_online_personal_context_and_old_chats_are_opt_in_by_default():
    import app_context

    perms = app_context.access({})
    assert perms == app_context.ACCESS_DEFAULTS
    assert perms["personalOnline"] is False
    assert perms["oldChats"] is False
    # Local app actions and the current selected chat remain available by default;
    # sending private data online and reading old chats do not.
    assert perms["localRead"] is True and perms["localEdit"] is True
    assert perms["currentChat"] is True


def test_context_is_allowlisted_bounded_and_redacts_secret_values():
    import app_context

    body = {
        "access": {"personalOnline": True, "localRead": True},
        "app_context": {
            "records": [
                {
                    "kind": "work",
                    "id": "project-1",
                    "title": "Study plan",
                    "text": "api_key: TOP_SECRET_KEY password=TOP_PASSWORD pin=1234",
                    "goal": "bounded context",
                    "progress": 40,
                    "entries": [
                        {
                            "date": "2026-11-23",
                            "minutes": 25,
                            "text": "safe entry",
                            "conn": "DB_CONN_SENTINEL",
                            "env": "ENV_SENTINEL",
                            "raw_code": "RAW_CODE_SENTINEL",
                        },
                        {"text": "second entry"},
                        {"text": "third entry"},
                        {"text": "fourth entry must be bounded out"},
                    ],
                    "conn": "DB_CONN_SENTINEL",
                    "env": "ENV_SENTINEL",
                    "raw_code": "RAW_CODE_SENTINEL",
                    "pin": "PIN_SENTINEL",
                    "provider_key": "PROVIDER_KEY_SENTINEL",
                }
            ]
        },
    }

    out = app_context.context(body, "Meri progress ka summary do")
    assert out.startswith("\n\n[Permitted relevant app records;")
    assert "Study plan" in out and "second entry" in out and "third entry" in out
    for secret in (
        "TOP_SECRET_KEY",
        "TOP_PASSWORD",
        "1234",
        "PIN_SENTINEL",
        "DB_CONN_SENTINEL",
        "ENV_SENTINEL",
        "RAW_CODE_SENTINEL",
        "PROVIDER_KEY_SENTINEL",
        "safe entry",
    ):
        assert secret not in out
    # The work-entry projection is itself allowlisted and capped at the last three.
    payload = json.loads(out.split("]\n", 1)[1])
    record = payload["records"][0]
    assert set(record) <= {
        "id",
        "kind",
        "title",
        "text",
        "at",
        "done",
        "category",
        "goal",
        "progress",
        "minutes",
        "outcome",
        "date",
        "entries",
    }
    assert len(record["entries"]) == 3
    assert record["entries"][-1]["text"] == "fourth entry must be bounded out"


def test_architecture_reference_is_curated_not_raw_source_or_environment():
    import app_knowledge

    ref = app_knowledge.reference("standard")
    dumped = json.dumps(ref, ensure_ascii=False)
    for sentinel in ("RAW_CODE_SENTINEL", "DB_CONN_SENTINEL", "ENV_SENTINEL", "PIN_SENTINEL", "TOP_SECRET_KEY"):
        assert sentinel not in dumped
    assert ref["readOnly"] is True
    assert ref["selectedMode"] == "standard"
    assert all(set(module) <= {"path", "purpose", "fingerprint", "symbols"} for module in ref["modules"])
    # Reference entries carry symbol names/fingerprints, never source literals.
    assert not any("TOP_SECRET_KEY" in str(module.get("symbols", [])) for module in ref["modules"])


def test_old_chat_context_requires_both_explicit_intent_and_toggle():
    import app_context

    body = {
        "access": {"personalOnline": True, "localRead": True, "oldChats": False},
        "app_context": {"records": [], "oldChats": [{"role": "user", "text": "OLD_CHAT_SENTINEL"}]},
    }
    assert "OLD_CHAT_SENTINEL" not in app_context.context(body, "Purane chat mein maine kya kaha?")

    body["access"]["oldChats"] = True
    assert "OLD_CHAT_SENTINEL" in app_context.context(body, "Purane chat mein maine kya kaha?")
    # Opt-in alone must not attach old turns to an unrelated personal-context query.
    assert "OLD_CHAT_SENTINEL" not in app_context.context(body, "Meri aaj ki progress batao")


def test_private_context_is_passed_to_pipeline_and_disables_web_research(monkeypatch):
    chat_adapter, seen, calls = _capture_pipeline(monkeypatch)
    body = {
        "text": "Meri progress ka summary do",
        "history": [{"role": "user", "text": "OLD_CURRENT_CHAT_SENTINEL"}],
        "access": {"personalOnline": True, "currentChat": True, "localRead": True},
        "app_context": {"records": [{"kind": "task", "id": "t1", "title": "Read", "done": False}]},
    }
    out = _reply(asyncio.run(chat_adapter.handle(body)))
    assert out["type"] == "text"
    assert len(calls) == 1
    assert "OLD_CURRENT_CHAT_SENTINEL" in seen["question"]
    assert "Read" in seen["question"]
    assert "[Permitted relevant app records;" in seen["question"]
    assert seen["web_research"] is False


def test_architecture_off_blocks_reference_and_context(monkeypatch):
    chat_adapter, seen, calls = _capture_pipeline(monkeypatch)

    denied = chat_adapter.local_response({"architecture": True, "access": {"architecture": False}})
    assert denied["type"] == "text"
    assert "Architecture reference access off" in denied["text"]

    out = _reply(
        asyncio.run(
            chat_adapter.handle(
                {
                    "text": "How does this app architecture work?",
                    "access": {"architecture": False},
                }
            )
        )
    )
    assert out["type"] == "text" and len(calls) == 1
    assert "[Read-only app architecture reference;" not in seen["question"]
    assert "architecture reference" not in seen["question"].lower()


# ---------------------------------------------------------------------------
# Local actions, permissions, and selected-mode routing


def test_zero_provider_keys_still_run_task_and_note_commands_locally(monkeypatch):
    import android_entry
    import chat_adapter

    for key in android_entry.KEY_NAMES:
        monkeypatch.delenv(key, raising=False)

    def no_model(*args, **kwargs):
        raise AssertionError("a local task/note command must not reach the model path")

    monkeypatch.setattr(chat_adapter, "handle", no_model)
    for text, action in (
        ("task add karo padhai", "task.add"),
        ("note banao ki paani peena", "note.add"),
    ):
        out = json.loads(android_entry.handle(json.dumps({"text": text})))
        reply = _reply(out)
        assert reply["type"] == "actions"
        assert reply["steps"][0]["action"] == action


@pytest.mark.parametrize(
    "text,permission,expected_fragment",
    [
        ("tasks dikhao", "localRead", "local read/edit access off"),
        ("task add karo padhai", "localEdit", "local read/edit access off"),
    ],
)
def test_local_read_and_edit_permissions_are_enforced_before_models(
    monkeypatch, text, permission, expected_fragment
):
    chat_adapter, seen, calls = _capture_pipeline(monkeypatch)
    out = _reply(
        asyncio.run(
            chat_adapter.handle(
                {"text": text, "access": {permission: False}}
            )
        )
    )
    assert out["type"] == "text"
    assert expected_fragment in out["text"]
    assert calls == [] and seen == {}


@pytest.mark.parametrize(
    "text",
    [
        "delete task homework confirm karo",
        "notes clear confirm karo",
        "PIN change karke 1234 set karo, confirm",
        "security settings change confirm karo",
    ],
)
def test_forbidden_delete_pin_security_actions_stay_blocked_even_with_confirmation(text):
    from actions import plan

    out = plan(text, mode="standard")
    assert out["type"] == "blocked"
    assert out["needsConfirm"] is False
    assert not out["steps"]


def test_nonstandard_action_does_not_auto_switch_mode_or_call_models(monkeypatch):
    chat_adapter, pipeline = _adapter_modules()
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", False)

    async def no_pipeline(*args, **kwargs):
        raise AssertionError("non-Standard local action must not call the pipeline")

    async def no_chat(*args, **kwargs):
        raise AssertionError("non-Standard local action must not call a model")

    monkeypatch.setattr(pipeline, "run", no_pipeline)
    monkeypatch.setattr(chat_adapter, "chat", no_chat)
    monkeypatch.setattr(chat_adapter.standard_agent, "answer", no_chat)
    out = _reply(asyncio.run(chat_adapter.handle({"text": "5 minute ka timer lagao", "mode": "coding"})))
    assert out["type"] == "text"
    assert "Standard select" in out["text"]
    assert out["uiMode"] == "coding"


def test_selected_standard_mode_never_promotes_to_classifier_task_mode():
    import roles

    assert roles.resolve_mode("standard", "math") == "standard"
    assert roles.resolve_mode("standard", "coding") == "standard"
    assert roles.resolve_mode("standard", "science") == "standard"


# ---------------------------------------------------------------------------
# Shortcut and quick-failure routing


def test_casual_greetings_use_shortcut_only_in_standard(monkeypatch):
    chat_adapter, pipeline = _adapter_modules()
    model_calls = []
    pipeline_calls = []

    async def quick_chat(*args, **kwargs):
        model_calls.append(1)
        return "Namaste Sir!"

    async def fake_pipeline(question, **kwargs):
        pipeline_calls.append((question, kwargs))
        return _fake_result()

    standard_calls = []
    fake_std = _fake_standard(standard_calls, "Namaste Sir!")
    async def counted(messages, **kw):
        model_calls.append(1)
        return await fake_std(messages, **kw)
    monkeypatch.setattr(chat_adapter, "chat", quick_chat)
    monkeypatch.setattr(chat_adapter.standard_agent, "answer", counted)
    monkeypatch.setattr(pipeline, "run", fake_pipeline)
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", False)

    standard = _reply(asyncio.run(chat_adapter.handle({"text": "Namaste", "mode": "standard"})))
    assert standard["text"] == "Namaste Sir!"
    assert len(model_calls) == 1 and pipeline_calls == []

    nonstandard = _reply(asyncio.run(chat_adapter.handle({"text": "Namaste", "mode": "math"})))
    assert nonstandard["type"] == "text"
    assert len(pipeline_calls) == 1
    assert len(model_calls) == 1
    assert pipeline_calls[0][1]["mode"] == "math"


def test_quick_failure_does_not_promote_standard_to_council(monkeypatch):
    from llm import LLMError

    chat_adapter, pipeline = _adapter_modules()
    pipeline_calls = []

    async def fail_quick(*args, **kwargs):
        raise LLMError("all quick models unavailable")

    async def no_pipeline(*args, **kwargs):
        pipeline_calls.append(1)
        raise AssertionError("Standard quick failure must not promote to council")

    monkeypatch.setattr(chat_adapter, "chat", fail_quick)
    monkeypatch.setattr(chat_adapter.standard_agent, "answer", _fake_standard(fail=True))
    monkeypatch.setattr(pipeline, "run", no_pipeline)
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", True)
    out = _reply(asyncio.run(chat_adapter.handle({"text": "France ki rajdhani kya hai?", "mode": "standard"})))
    assert "Groq" in out["text"]
    assert out["uiMode"] == "standard"
    assert pipeline_calls == []
