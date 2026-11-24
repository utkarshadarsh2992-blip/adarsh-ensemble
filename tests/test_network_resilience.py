"""Offline tests: slow providers are streamed so a silent connection is never dropped ("network error: ReadError").

Contract (llm._post_stream / llm._try_model / llm.make_client):
  * OpenRouter and NVIDIA (config.STREAM_PROVIDERS) are asked with stream=true; the deltas become ONE normal answer,
    thinking deltas and ": keep-alive" comments are dropped; Groq / Gemini stay plain requests;
  * a server that ignores stream=true (JSON back), a 429 and a mid-stream error event are handled like before;
  * a stream that just stops (no finish_reason, no [DONE]) is a network error, never a half answer;
  * a network error names its type and how long the connection lived, then the next key / model is tried;
  * make_client() sets TCP keep-alive. Real httpx is used through httpx.MockTransport; nothing reaches the network.
"""
import asyncio
import json
import os
import re
import socket
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ.setdefault("USAGE_FILE", os.path.join(os.path.dirname(__file__), ".usage-test.json"))

import config  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402
import pipeline  # noqa: E402

ENVS = ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY")
Q = [{"role": "user", "content": "claims nikalo"}]
NEMO = config.REGISTRY["nemotron-lightning"].model
LING = config.REGISTRY["ling-3.2-flash"].model
MISTRAL = config.REGISTRY["mistral-large-4"].model


@pytest.fixture(autouse=True)
def keys(monkeypatch):
    for env in ENVS:
        for slot in (1, 2, 3):
            monkeypatch.setenv(config.slot_env(env, slot), f"{env.split('_')[0].lower()}-key-{slot}")
    for name in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"):
        for slot in (1, 2, 3):
            monkeypatch.delenv(config.slot_env(name, slot), raising=False)
    monkeypatch.setattr(config, "STREAM_PROVIDERS", frozenset({"openrouter", "nvidia"}))  # conftest turns it off
    health.reset(clear_usage=True)
    yield
    health.reset(clear_usage=True)


def k(provider, slot):
    return f"{provider}-key-{slot}"


def sse(*events, done=True):
    lines = [": OPENROUTER PROCESSING", ""]
    for e in events:
        lines += ["data: " + json.dumps(e), ""]
    if done:
        lines += ["data: [DONE]", ""]
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content="\n".join(lines).encode())


def delta(text=None, reasoning=None, finish=None):
    d = {}
    if text is not None:
        d["content"] = text
    if reasoning is not None:
        d["reasoning"] = reasoning
        d["reasoning_content"] = reasoning
    return {"choices": [{"index": 0, "delta": d, "finish_reason": finish}]}


def plain(text="ok", finish="stop"):
    return httpx.Response(200, json={"choices": [{"message": {"content": text}, "finish_reason": finish}],
                                     "usage": {"total_tokens": 12}})


class Server:
    """script: (model id, key) -> list of httpx.Response or Exception (used in order). Unlisted: plain "ok"."""

    def __init__(self, script=None):
        self.script, self.calls = dict(script or {}), []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        key = request.headers["authorization"].removeprefix("Bearer ")
        self.calls.append({"model": body["model"], "key": key, "body": body,
                           "read_timeout": (request.extensions.get("timeout") or {}).get("read")})
        todo = self.script.get((body["model"], key))
        beh = todo.pop(0) if todo else plain()
        if isinstance(beh, Exception):
            raise beh
        return beh

    def client(self):
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


async def ask(server, spec, **kw):
    async with server.client() as c:
        return await llm.chat(c, spec, Q, max_tokens=kw.pop("max_tokens", 3000), retries=kw.pop("retries", 0), **kw)


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- streaming for the slow providers

def test_openrouter_is_streamed_and_the_deltas_become_one_answer():
    s = Server({(NEMO, k("openrouter", 1)): [sse(delta(reasoning="soch raha hu"), delta("Ji "), delta("Sir"),
                                                 delta(finish="stop"), {"choices": [], "usage": {"total_tokens": 40}})]})
    assert run(ask(s, config.use("nemotron-lightning", "judge", ["gpt-oss-20b"]))) == "Ji Sir"
    assert s.calls[0]["body"]["stream"] is True and s.calls[0]["body"]["max_tokens"] == 3000


def test_nvidia_mistral_is_streamed_and_thinking_deltas_are_dropped():
    s = Server({(MISTRAL, k("nvidia", 1)): [sse(delta(reasoning="lamba soch"), delta("pattern mila"), delta(finish="stop"))]})
    assert run(ask(s, config.use("mistral-large-4", "pattern_finder", ["gpt-oss-120b"]))) == "pattern mila"
    assert s.calls[0]["body"]["stream"] is True


def test_groq_and_gemini_stay_plain_requests():
    s = Server()
    assert run(ask(s, config.use("gpt-oss-20b", "judge", ["gemini-3.5-flash-lite"]))) == "ok"
    assert run(ask(s, config.use("gemini-3.5-flash-lite", "judge", ["gpt-oss-20b"]))) == "ok"
    assert all("stream" not in x["body"] for x in s.calls)


def test_server_that_ignores_stream_and_sends_json_still_works():
    s = Server({(NEMO, k("openrouter", 1)): [plain("json jawab")]})
    assert run(ask(s, config.use("nemotron-lightning", "judge", ["gpt-oss-20b"]))) == "json jawab"


def test_streamed_empty_thinking_answer_gets_the_bigger_retry_on_the_same_key():
    s = Server({(NEMO, k("openrouter", 1)): [sse(delta(reasoning="bahut soch"), delta(finish="length")),
                                             sse(delta("ab jawab"), delta(finish="stop"))]})
    assert run(ask(s, config.use("nemotron-lightning", "judge", ["gpt-oss-20b"]))) == "ab jawab"
    assert [(x["model"], x["key"], x["body"]["max_tokens"]) for x in s.calls] == [
        (NEMO, k("openrouter", 1), 3000), (NEMO, k("openrouter", 1), 6000)]


# ---------------------------------------------------------------- failures move on, never a half answer

def test_mid_stream_error_event_moves_to_the_next_key():
    err = {"error": {"code": 502, "message": "upstream died"}, "choices": [{"index": 0, "delta": {}, "finish_reason": "error"}]}
    s = Server({(NEMO, k("openrouter", 1)): [sse(delta("adha"), err)]})
    assert run(ask(s, config.use("nemotron-lightning", "judge", ["gpt-oss-20b"]))) == "ok"
    assert [(x["model"], x["key"]) for x in s.calls] == [(NEMO, k("openrouter", 1)), (NEMO, k("openrouter", 2))]


def test_stream_that_just_stops_is_a_network_error_not_a_half_answer():
    cut = [sse(delta("adha jawab"), done=False) for _ in range(3)]
    s = Server({(m, k("openrouter", n)): list(cut) for m in (NEMO, LING) for n in (1, 2, 3)})
    s.script.update({("openai/gpt-oss-20b", k("groq", n)): [httpx.ReadError("reset")] for n in (1, 2, 3)})
    with pytest.raises(llm.LLMError) as e:
        run(ask(s, config.use("nemotron-lightning", "judge", ["ling-3.2-flash", "gpt-oss-20b"])))
    assert "RemoteProtocolError" in str(e.value) and "adha jawab" not in str(e.value)


def test_read_error_names_how_long_the_connection_lived_and_the_next_key_answers():
    s = Server({(NEMO, k("openrouter", 1)): [httpx.ReadError("connection reset")]})
    assert run(ask(s, config.use("nemotron-lightning", "judge", ["gpt-oss-20b"]))) == "ok"
    assert [x["key"] for x in s.calls] == [k("openrouter", 1), k("openrouter", 2)]
    health.reset(clear_usage=True)
    s = Server({(m, k(p, n)): [httpx.ReadError("reset")] * 3
                for m, p in ((NEMO, "openrouter"), ("openai/gpt-oss-20b", "groq")) for n in (1, 2, 3)})
    with pytest.raises(llm.LLMError) as e:
        run(ask(s, config.use("nemotron-lightning", "judge", ["gpt-oss-20b"])))
    assert re.search(r"network error: ReadError after \d+s", str(e.value))


def test_rate_limit_on_a_stream_request_is_read_from_the_headers():
    s = Server({(NEMO, k("openrouter", 1)): [httpx.Response(429, headers={"retry-after": "30"},
                                                            json={"error": {"message": "rate limited"}})]})
    assert run(ask(s, config.use("nemotron-lightning", "judge", ["gpt-oss-20b"]))) == "ok"
    assert [x["key"] for x in s.calls] == [k("openrouter", 1), k("openrouter", 2)]


# ---------------------------------------------------------------- TCP keep-alive on the pipeline client

def test_make_client_turns_on_tcp_keepalive_and_zero_turns_it_off(monkeypatch):
    c = llm.make_client()
    try:
        opts = c._transport._pool._socket_options
        assert (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1) in opts
        if hasattr(socket, "TCP_KEEPIDLE"):
            assert (socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, config.TCP_KEEPALIVE_S) in opts
    finally:
        run(c.aclose())
    monkeypatch.setattr(config, "TCP_KEEPALIVE_S", 0)
    c = llm.make_client()
    try:
        assert not c._transport._pool._socket_options
    finally:
        run(c.aclose())
    assert pipeline.make_client is llm.make_client


# ---------------------------------------------------------------- per-model attempt timeouts

GEMINI_FLASH = config.REGISTRY["gemini-3.8-flash"].model
GPT20 = config.REGISTRY["gpt-oss-20b"].model


def test_gemini_flash_waits_200s_and_its_fallback_keeps_the_default():
    s = Server({(GEMINI_FLASH, k("gemini", n)): [httpx.Response(503, json={"error": {"message": "overloaded"}})]
                for n in (1, 2, 3)})
    assert run(ask(s, config.use("gemini-3.8-flash", "judge", ["gpt-oss-20b"]))) == "ok"
    waits = {(x["model"], x["key"]): x["read_timeout"] for x in s.calls}
    assert [waits[(GEMINI_FLASH, k("gemini", n))] for n in (1, 2, 3)] == [200.0, 200.0, 200.0]
    assert waits[(GPT20, k("groq", 1))] == config.LLM_TIMEOUT_S == 120.0


def test_a_caller_timeout_still_wins_for_every_model():
    s = Server({(GEMINI_FLASH, k("gemini", 1)): [httpx.Response(503, json={})]})
    assert run(ask(s, config.use("gemini-3.8-flash", "judge", ["gpt-oss-20b"]), timeout=60)) == "ok"
    assert {x["read_timeout"] for x in s.calls} == {60.0}


def test_model_timeouts_setting_is_parsed_per_label_and_shared_by_all_keys(monkeypatch):
    assert config._timeouts("mistral-large-4=300, nemotron-ultra = 240,bad,x=abc,y=0,=5") == {
        "mistral-large-4": 300.0, "nemotron-ultra": 240.0}
    monkeypatch.setitem(config.MODEL_TIMEOUT_S, "mistral-large-4", 300.0)
    assert config.model_timeout(config.keyed(config.REGISTRY["mistral-large-4"], 2)) == 300.0
    assert config.model_timeout(config.REGISTRY["gemini-3.8-flash"]) == 200.0
    assert config.model_timeout(config.REGISTRY["gpt-oss-120b"]) == config.LLM_TIMEOUT_S
