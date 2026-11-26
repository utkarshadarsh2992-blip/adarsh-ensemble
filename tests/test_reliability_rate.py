import asyncio
import json
import os
import sys
import time

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ.setdefault("USAGE_FILE", os.path.join(os.path.dirname(__file__), ".usage-test.json"))

import config  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402
import standard_agent  # noqa: E402
import android_entry  # noqa: E402


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body or {}
        self.headers = {}
        self.text = ""

    def json(self):
        return self._body


def success(text="ok", tokens=10, finish="stop"):
    return Resp(200, {"choices": [{"message": {"content": text}, "finish_reason": finish}],
                     "usage": {"total_tokens": tokens}})


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for slot in ("", "_2", "_3"):
        monkeypatch.delenv("GROQ_API_KEY" + slot, raising=False)
    health.reset(clear_usage=True)
    yield
    health.reset(clear_usage=True)


class Client:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append(json)
        return self.response


def run(coro):
    return asyncio.run(coro)


def test_llm_success_releases_conservative_tpm_reservation_to_actual_usage(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    monkeypatch.setattr(config, "GROQ_RPM", 0)
    monkeypatch.setattr(config, "GROQ_TPM_DEFAULT", 1000)
    client = Client(success(tokens=11))
    spec = config.keyed(config.REGISTRY["gpt-oss-20b"], 1)

    assert run(llm.chat(client, spec, [{"role": "user", "content": "short"}],
                        max_tokens=700, retries=0)) == "ok"
    assert health._minute(health.quota_key(spec), time.time())[1] == 11


def test_standard_http_failure_does_not_leave_full_output_estimate_in_window(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    monkeypatch.setattr(config, "GROQ_RPM", 0)
    monkeypatch.setattr(config, "GROQ_TPM_DEFAULT", 1000)

    async def answer():
        class Failing:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def post(self, *args, **kwargs):
                return Resp(503, {"error": "down"})

        original = standard_agent._client
        standard_agent._client = lambda: Failing()
        try:
            with pytest.raises(standard_agent.StandardError):
                await standard_agent.answer([{"role": "user", "content": "hello"}],
                                            tools=False, web=False, max_tokens=700, budget=5)
        finally:
            standard_agent._client = original

    run(answer())
    key = health.quota_key(standard_agent._base_spec())
    assert health._minute(key, time.time())[1] == 0


def test_standard_rejects_a_single_prompt_that_cannot_fit_without_calling_provider(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    monkeypatch.setattr(config, "GROQ_RPM", 0)
    monkeypatch.setattr(config, "GROQ_TPM_DEFAULT", 1000)
    called = []

    class Never:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, *args, **kwargs):
            called.append(True)
            raise AssertionError("oversized request was sent")

    monkeypatch.setattr(standard_agent, "_client", lambda: Never())
    with pytest.raises(standard_agent.StandardError) as exc:
        run(standard_agent.answer([{"role": "user", "content": "x" * 10000}],
                                  tools=False, web=False, max_tokens=700, budget=5))
    message = str(exc.value)
    assert not called
    assert "single request too big" in message
    assert "own rate window full" not in message


def test_standard_tool_rounds_settle_each_short_call_instead_of_reserving_max_tokens(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    monkeypatch.setattr(config, "GROQ_RPM", 0)
    monkeypatch.setattr(config, "GROQ_TPM_DEFAULT", 8000)
    replies = [
        (200, {"choices": [{"message": {"content": "", "tool_calls": [{
            "id": f"c{i}", "type": "function", "function": {
                "name": "wikipedia_search", "arguments": json.dumps({"query": f"q{i}"})}}]},
                    "finish_reason": "tool_calls"}], "usage": {"total_tokens": 30}})
        for i in range(3)
    ] + [(200, {"choices": [{"message": {"content": "final",}, "finish_reason": "stop"}],
                "usage": {"total_tokens": 40}})]

    class ToolClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json=None, headers=None, timeout=None):
            status, body = replies.pop(0)
            return Resp(status, body)

    async def fake_wiki(client, query):
        return json.dumps({"query": query, "results": []}), []

    monkeypatch.setattr(standard_agent, "_client", lambda: ToolClient())
    monkeypatch.setattr(standard_agent, "_wikipedia", fake_wiki)
    out = run(standard_agent.answer([{"role": "user", "content": "x" * 3000}], max_tokens=3000, budget=10))
    assert out["text"] == "final"
    key = health.quota_key(standard_agent._base_spec())
    assert health._minute(key, time.time())[1] == 130


def test_parallel_news_debate_calls_fit_after_short_reservations_settle(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    monkeypatch.setattr(config, "GROQ_RPM", 0)
    monkeypatch.setattr(config, "GROQ_TPM_DEFAULT", 8000)

    class DebateClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, *args, **kwargs):
            await asyncio.sleep(0)
            return success("debate point", tokens=25)

    monkeypatch.setattr(standard_agent, "_client", lambda: DebateClient())

    async def fanout():
        return await asyncio.gather(*[
            standard_agent.answer([{"role": "user", "content": f"news claim {i}"}],
                                  tools=False, web=False, max_tokens=3000, budget=10)
            for i in range(3)
        ])

    out = run(fanout())
    assert [item["text"] for item in out] == ["debate point"] * 3
    key = health.quota_key(standard_agent._base_spec())
    assert health._minute(key, time.time())[1] == 75


def test_standard_length_response_continues_a_bounded_number_of_parts(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    monkeypatch.setattr(config, "GROQ_RPM", 0)
    replies = [success("part one", tokens=10, finish="length"), success("part two", tokens=12)]

    class ContinuationClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, *args, **kwargs):
            return replies.pop(0)

    monkeypatch.setattr(standard_agent, "_client", lambda: ContinuationClient())
    out = run(standard_agent.answer([{"role": "user", "content": "q"}], tools=False, web=False, budget=10))
    assert out["text"] == "part one part two"


def test_duplicate_request_id_cannot_replace_the_running_task_and_stale_stop_is_harmless():
    import threading

    entered = threading.Event()
    release = threading.Event()
    first_result = {}

    async def first():
        entered.set()
        await asyncio.to_thread(release.wait)
        return "first"

    def run_first():
        try:
            first_result["value"] = android_entry._run_cancellable(first, 5, "same-id")
        except BaseException as exc:  # the test expects Stop to cancel this one
            first_result["error"] = exc

    thread = threading.Thread(target=run_first)
    thread.start()
    assert entered.wait(2)

    async def duplicate():
        return "duplicate"

    with pytest.raises(asyncio.CancelledError):
        android_entry._run_cancellable(duplicate, 1, "same-id")
    assert android_entry.cancel("same-id") is True
    release.set()
    thread.join(3)
    assert not thread.is_alive()
    assert isinstance(first_result.get("error"), asyncio.CancelledError)
    assert android_entry.cancel("same-id") is False

    async def next_request():
        return "next"

    assert android_entry._run_cancellable(next_request, 1, "same-id") == "next"
