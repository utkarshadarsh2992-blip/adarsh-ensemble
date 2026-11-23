"""The chat UI's "model calls" panel: structured events from llm.chat, the compact list in the reply. No network."""
import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")

import config  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402
import pipeline  # noqa: E402


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code, self._body, self.headers, self.text = status, body, {}, ""

    def json(self):
        return self._body


def ok(text="ok"):
    return Resp(200, {"choices": [{"message": {"content": text}, "finish_reason": "stop"}], "usage": {"total_tokens": 10}})


QUOTA_429 = Resp(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED",
                                 "details": [{"@type": "type.googleapis.com/google.rpc.QuotaFailure",
                                              "violations": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}})


class Client:
    def __init__(self, script=None):
        self.script, self.calls = script or {}, []

    async def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append(json["model"])
        return self.script.get(json["model"], ok())


SMALL = [{"role": "user", "content": "q?"}]


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for env in ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY"):
        monkeypatch.setenv(env, "test-key-123456")
    health.reset(clear_usage=True)
    health.set_stage("")
    yield
    health.reset(clear_usage=True)
    health.set_stage("")


def collect():
    seen = []
    config.PROGRESS.set(lambda s: seen.append(s))
    return seen


def events(seen):
    out = []
    for s in seen:
        if s.startswith(config.CALL_TAG):
            out.append(json.loads(s[len(config.CALL_TAG):]))
    return out


def test_events_are_tagged_and_plain_lines_are_not():
    seen = collect()
    config.emit("Architect chal raha hai")
    config.emit_call({"t": "try", "stage": "architect", "model": "gemma-4-31b-g"})
    assert seen[0] == "Architect chal raha hai"
    assert seen[1].startswith("\x01call ")
    assert events(seen) == [{"t": "try", "stage": "architect", "model": "gemma-4-31b-g"}]


def test_success_emits_try_then_ok_with_stage_and_seconds():
    seen = collect()
    health.set_stage("panel:theorist")
    asyncio.run(llm.chat(Client(), config.THEORIST, SMALL))
    ev = events(seen)
    assert [e["t"] for e in ev] == ["try", "ok"]
    assert ev[0]["stage"] == ev[1]["stage"] == "panel:theorist"
    assert ev[1]["model"] == "gpt-oss-120b" and ev[1]["secs"] >= 0
    assert ev[0]["provider"] == "groq"


def test_failover_shows_the_failed_model_and_the_reason():
    seen = collect()
    health.set_stage("judge")
    c = Client({"gemini-3.8-flash": QUOTA_429})
    asyncio.run(llm.chat(c, config.SYNTHESIZER, SMALL))
    ev = events(seen)
    kinds = [(e["t"], e["model"]) for e in ev]
    assert ("fail", "gemini-3.8-flash") in kinds
    fail = [e for e in ev if e["t"] == "fail"][0]
    assert "quota" in fail["why"].lower()
    assert ("ok", "nemotron-ultra") in kinds  # the chain moved on and said who answered


def test_dead_role_emits_a_dead_event():
    seen = collect()
    health.set_stage("judge")
    c = Client({"gemini-3.8-flash": QUOTA_429, "nvidia/nemotron-3-ultra-550b-a55b:free": QUOTA_429,
                "openai/gpt-oss-120b": QUOTA_429, "mistralai/mistral-large-4-1t-a52b": QUOTA_429,
                "openrouter/free": QUOTA_429})
    with pytest.raises(llm.LLMError):
        asyncio.run(llm.chat(c, config.SYNTHESIZER, SMALL))
    assert events(seen)[-1]["t"] == "dead"


def test_no_callback_is_harmless():
    config.PROGRESS.set(None)
    config.emit_call({"t": "try"})
    asyncio.run(llm.chat(Client(), config.THEORIST, SMALL))


def test_compact_calls_keeps_stage_model_and_fail_reason():
    trace = [
        {"stage": "guard", "asked": "safeguard-20b", "used": "safeguard-20b", "ok": True},
        {"stage": "panel:theorist", "asked": "gpt-oss-120b", "used": "gemini-3.8-flash", "ok": True, "secs": 2.1,
         "skips": {"gpt-oss-120b": "daily token quota used up"}},
        {"stage": "judge", "asked": "gemini-3.8-flash", "used": "gemini-3.8-flash", "ok": False, "secs": 1.0},
    ]
    calls = pipeline._compact_calls(trace)
    assert [c["stage"] for c in calls] == ["panel:theorist", "judge"]  # the guard is not a role call
    assert calls[0] == {"stage": "panel:theorist", "model": "gemini-3.8-flash", "ok": True, "secs": 2.1,
                        "asked": "gpt-oss-120b", "fails": ["gpt-oss-120b: daily token quota used up"]}
    assert calls[1]["ok"] is False and "fails" not in calls[1]


def test_compact_calls_is_capped_and_survives_empty():
    assert pipeline._compact_calls([]) == []
    assert pipeline._compact_calls(None) == []
    many = [{"stage": "panel:x", "asked": "a", "used": "a", "ok": True} for _ in range(200)]
    assert len(pipeline._compact_calls(many)) == pipeline.MAX_CALLS


def test_reply_carries_the_calls_list(monkeypatch):
    import chat_adapter

    async def fake_run(question, **kw):
        return {"answer": "jawab", "task_type": "general", "style": "solve", "engine": "roles",
                "models_used": {"gpt-oss-120b": 1}, "latency_s": 3.0, "warnings": [],
                "calls": [{"stage": "judge", "model": "gemini-3.8-flash", "ok": True, "secs": 2.0}]}

    monkeypatch.setattr(chat_adapter.pipeline, "run", fake_run)
    out = asyncio.run(chat_adapter.handle({"text": "escape velocity kya hai", "mode": "physics"}))
    reply = out[0] if isinstance(out, list) else out
    assert reply["calls"][0]["stage"] == "judge"
