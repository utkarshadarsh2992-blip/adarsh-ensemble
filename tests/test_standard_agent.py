"""Standard mode = Groq only (openai/gpt-oss-120b) with Groq's built-in browser_search and a local
wikipedia_search tool. No network: an httpx.MockTransport plays Groq and Wikipedia and records every request."""
import asyncio
import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")
import chat_adapter  # noqa: E402
import config  # noqa: E402
import health  # noqa: E402
import pipeline  # noqa: E402
import standard_agent  # noqa: E402

KEYS = [config.slot_env(n, s) for s in (1, 2, 3)
        for n in ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN",
                  "CLOUDFLARE_ACCOUNT_ID", "NVIDIA_API_KEY")]
Q = [{"role": "system", "content": "sys"}, {"role": "user", "content": "Chandrayaan-3 kab land hua?"}]


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for env in KEYS:
        monkeypatch.delenv(env, raising=False)
    health.reset(clear_usage=True)
    yield
    health.reset(clear_usage=True)


def fake_net(monkeypatch, groq_replies):
    """groq_replies: list of (status, body) served in order to Groq calls. Returns the request log."""
    log = []
    replies = list(groq_replies)

    def handler(request: httpx.Request):
        host = request.url.host
        body = json.loads(request.content) if request.content else None
        log.append({"host": host, "auth": request.headers.get("authorization", ""), "body": body,
                    "params": dict(request.url.params)})
        if host == "api.groq.com":
            status, data = replies.pop(0)
            return httpx.Response(status, json=data)
        if host.endswith("wikipedia.org"):
            return httpx.Response(200, json={"query": {"pages": {"1": {
                "index": 1, "title": "Chandrayaan-3", "fullurl": "https://en.wikipedia.org/wiki/Chandrayaan-3",
                "extract": "Chandrayaan-3 is the third Indian lunar mission. Its lander touched down near the lunar "
                           "south pole on 23 August 2023, making India the fourth country to land on the Moon."}}}})
        raise AssertionError(f"Standard mode must not contact {host}")

    monkeypatch.setattr(standard_agent, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    return log


def final(text, **msg):
    return 200, {"choices": [{"message": {"content": text, **msg}, "finish_reason": "stop"}],
                 "usage": {"total_tokens": 50}}


def wiki_call(query):
    return 200, {"choices": [{"message": {"content": "", "tool_calls": [{
        "id": "call_1", "type": "function",
        "function": {"name": "wikipedia_search", "arguments": json.dumps({"query": query})}}]},
        "finish_reason": "tool_calls"}], "usage": {"total_tokens": 30}}


def run(coro):
    return asyncio.run(coro)


def test_request_uses_only_gpt_oss_120b_with_both_tools(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    monkeypatch.setenv("GEMINI_API_KEY", "gem")  # other providers set: still never called
    log = fake_net(monkeypatch, [final("23 August 2023 ko.")])
    out = run(standard_agent.answer(Q))
    assert out["text"] == "23 August 2023 ko." and out["used"] == "gpt-oss-120b"
    [req] = log
    assert req["host"] == "api.groq.com" and req["auth"] == "Bearer gsk_one"
    body = req["body"]
    assert body["model"] == "openai/gpt-oss-120b" and body["reasoning_effort"] == "low"
    types = [t["type"] for t in body["tools"]]
    assert types == ["browser_search", "function"]
    assert body["tools"][1]["function"]["name"] == "wikipedia_search"


def test_completed_short_requests_settle_their_tpm_reservations(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    monkeypatch.setattr(config, "GROQ_RPM", 0)
    monkeypatch.setattr(config, "GROQ_TPM_DEFAULT", 3000)
    monkeypatch.setattr(config, "RL_MAX_WAIT_S", 0.0)
    log = fake_net(monkeypatch, [final("short answer"), final("another short answer")])

    run(standard_agent.answer(Q, tools=False, web=False, max_tokens=1500, budget=5))
    run(standard_agent.answer(Q, tools=False, web=False, max_tokens=1500, budget=5))

    assert len(log) == 2  # without settlement, two 1,500-token reservations exceed the 2,700-token guard
    key = health.quota_key(standard_agent._base_spec())
    assert health._minute(key, __import__("time").time()) == (2, 100)  # actual usage: 50 tokens each


def test_configured_standard_chain_selects_its_groq_model(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    monkeypatch.setattr(config, "STANDARD_CHAIN_LABELS", ("gpt-oss-20b",))
    log = fake_net(monkeypatch, [final("configured model answered")])

    out = run(standard_agent.answer(Q, tools=False, web=False))

    assert out["used"] == "gpt-oss-20b"
    assert log[0]["body"]["model"] == config.REGISTRY["gpt-oss-20b"].model
    assert standard_agent._base_spec().model == config.REGISTRY["gpt-oss-20b"].model


def test_wikipedia_tool_round_trip_and_citation_markers_removed(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    log = fake_net(monkeypatch, [wiki_call("Chandrayaan-3"), final("Lander 23 August 2023 ko utra\u30101\u2020L1-L3\u3011.")])
    out = run(standard_agent.answer(Q))
    assert out["text"] == "Lander 23 August 2023 ko utra."
    assert out["wiki"] == ["Chandrayaan-3"]
    assert out["sources"][0]["url"] == "https://en.wikipedia.org/wiki/Chandrayaan-3"
    hosts = [r["host"] for r in log]
    assert hosts == ["api.groq.com", "en.wikipedia.org", "api.groq.com"]
    second = log[2]["body"]["messages"]
    assert second[-2]["role"] == "assistant" and second[-2]["tool_calls"][0]["id"] == "call_1"
    assert second[-1]["role"] == "tool" and "south pole" in second[-1]["content"]


def test_browser_search_sources_are_collected(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    executed = [{"type": "browser_search", "arguments": "{}", "search_results": {"results": [
        {"title": "ISRO news", "url": "https://www.isro.gov.in/x", "content": "..."},
        {"title": "bad", "url": "http://insecure.example/x"}]}}]
    fake_net(monkeypatch, [final("Aaj ka update.", executed_tools=executed)])
    out = run(standard_agent.answer(Q))
    assert out["searches"] == 1
    assert out["sources"] == [{"title": "ISRO news", "url": "https://www.isro.gov.in/x"}]
    assert "isro.gov.in" in standard_agent.sources_block(out["sources"])


def test_limit_402_and_server_down_switch_to_next_groq_key(monkeypatch):
    for env, v in (("GROQ_API_KEY", "gsk_one"), ("GROQ_API_KEY_2", "gsk_two"), ("GROQ_API_KEY_3", "gsk_three")):
        monkeypatch.setenv(env, v)
    log = fake_net(monkeypatch, [(429, {"error": {"message": "Rate limit reached. Please try again in 20s"}}),
                                 (402, {"error": {"message": "credits"}}), final("teesri key se jawab")])
    out = run(standard_agent.answer(Q))
    assert out["text"] == "teesri key se jawab" and out["used"] == "gpt-oss-120b#3"
    assert [r["auth"] for r in log] == ["Bearer gsk_one", "Bearer gsk_two", "Bearer gsk_three"]


def test_5xx_switches_key_and_all_failing_raises_without_other_providers(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    monkeypatch.setenv("GROQ_API_KEY_2", "gsk_two")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or")
    log = fake_net(monkeypatch, [(503, {"error": "down"}), (500, {"error": "down"})])
    with pytest.raises(standard_agent.StandardError) as e:
        run(standard_agent.answer(Q))
    assert "Groq" in str(e.value) and "HTTP 503" in str(e.value)
    assert {r["host"] for r in log} == {"api.groq.com"}


def test_refused_tool_combo_steps_down_on_the_same_key(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    log = fake_net(monkeypatch, [(400, {"error": {"message": "tools not supported together"}}), final("ok")])
    out = run(standard_agent.answer(Q))
    assert out["text"] == "ok"
    assert [t["type"] for t in log[0]["body"]["tools"]] == ["browser_search", "function"]
    # Wikipedia is kept first when the combination is refused (user: Wikipedia research must keep working)
    assert [t["type"] for t in log[1]["body"]["tools"]] == ["function"]
    assert log[1]["body"]["tools"][0]["function"]["name"] == "wikipedia_search"
    assert log[0]["auth"] == log[1]["auth"] == "Bearer gsk_one"


def test_web_search_off_keeps_only_wikipedia(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    log = fake_net(monkeypatch, [wiki_call("Chandrayaan-3"), final("23 August 2023.")])
    out = run(standard_agent.answer(Q, web=False))
    assert out["text"] == "23 August 2023." and out["wiki"] == ["Chandrayaan-3"]
    groq = [r for r in log if r["host"] == "api.groq.com"]
    for req in groq:
        assert all(t["type"] != "browser_search" for t in req["body"].get("tools", []))
    assert [t["function"]["name"] for t in groq[0]["body"]["tools"]] == ["wikipedia_search"]
    assert "en.wikipedia.org" in [r["host"] for r in log]


def test_web_search_off_refused_wikipedia_never_falls_back_to_browser(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    log = fake_net(monkeypatch, [(400, {"error": {"message": "tool refused"}}), final("bina tools")])
    out = run(standard_agent.answer(Q, web=False))
    assert out["text"] == "bina tools"
    assert "tools" not in log[1]["body"]
    assert standard_agent.research_hint(False) != standard_agent.research_hint(True)
    assert "browser_search" not in standard_agent.research_hint(False)


def test_no_groq_key_is_a_clear_error_even_with_other_keys(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "gem")
    fake_net(monkeypatch, [])
    with pytest.raises(standard_agent.StandardError) as e:
        run(standard_agent.answer(Q))
    assert "Groq key" in str(e.value)


def test_tool_rounds_are_bounded(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one")
    replies = [wiki_call(f"q{i}") for i in range(standard_agent.MAX_TOOL_ROUNDS)] + [final("bas")]
    log = fake_net(monkeypatch, replies)
    out = run(standard_agent.answer(Q))
    assert out["text"] == "bas"
    groq = [r for r in log if r["host"] == "api.groq.com"]
    assert len(groq) == standard_agent.MAX_TOOL_ROUNDS + 1
    assert "tools" not in groq[-1]["body"]  # after the last allowed round the model must answer


def test_chat_adapter_standard_is_groq_only_and_private_records_disable_search(monkeypatch):
    seen = []

    async def fake_answer(messages, **kw):
        seen.append(kw)
        return {"text": "jawab", "used": "gpt-oss-120b", "searches": 1, "wiki": ["x"],
                "sources": [{"title": "Wikipedia: X", "url": "https://en.wikipedia.org/wiki/X"}], "secs": 1.0}

    async def no_pipeline(*a, **k):
        raise AssertionError("Standard must never run the multi-provider council")

    monkeypatch.setattr(standard_agent, "answer", fake_answer)
    monkeypatch.setattr(pipeline, "run", no_pipeline)
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", True)
    out = run(chat_adapter.handle({"text": "Photosynthesis samjhao", "mode": "standard", "meta": {"deep": True},
                                   "attachments": [{"name": "a.txt"}]}))
    assert seen[-1]["tools"] is True and seen[-1]["effort"] == "medium"
    assert "en.wikipedia.org/wiki/X" in out[0]["text"] and "Attachment nahi padha" in out[0]["text"]
    assert any("Wikipedia" in s for s in out[0]["steps"]) and any("Web search" in s for s in out[0]["steps"])
    # voice replies are spoken: no sources block
    out = run(chat_adapter.handle({"text": "Photosynthesis samjhao", "mode": "standard", "meta": {"voice": True}}))
    assert "Sources" not in out[0]["text"]

    monkeypatch.setattr(chat_adapter.app_context, "context",
                        lambda body, text: "\n\n[Permitted relevant app records; private]\n- reminder: doctor 5pm")
    n = len(seen)
    run(chat_adapter.handle({"text": "doctor ke baare mein maine kya likha tha, samjhao", "mode": "standard"}))
    assert len(seen) == n + 1 and seen[-1]["tools"] is False


def test_chat_adapter_passes_the_web_search_setting(monkeypatch):
    seen = []

    async def fake_answer(messages, **kw):
        seen.append((messages, kw))
        return {"text": "jawab", "used": "gpt-oss-120b", "searches": 0, "wiki": ["Moon"],
                "sources": [], "secs": 1.0}

    monkeypatch.setattr(standard_agent, "answer", fake_answer)
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", True)
    q = "Chand ki doori kitni hai, samjhao"
    out = run(chat_adapter.handle({"text": q, "mode": "standard", "reply": {"web": "off"}}))
    assert seen[-1][1]["web"] is False and seen[-1][1]["tools"] is True
    assert "browser_search" not in seen[-1][0][0]["content"]
    assert any("web search off" in s for s in out[0]["steps"])
    run(chat_adapter.handle({"text": q, "mode": "standard", "reply": {"web": "on"}}))
    assert seen[-1][1]["web"] is True
    run(chat_adapter.handle({"text": q, "mode": "standard"}))  # older app / background voice config: default on
    assert seen[-1][1]["web"] is True


def test_auto_factcheck_and_quota_warning_follow_the_model_actually_used(monkeypatch):
    monkeypatch.setattr(config, "STANDARD_CHAIN_LABELS", ("gpt-oss-120b",))
    seen_specs, checked = [], []

    async def fake_answer(messages, **kw):
        return {"text": "A fact from 2023.", "used": "gpt-oss-20b#2", "searches": 0,
                "wiki": [], "sources": [], "secs": 1.0}

    def used_frac(spec):
        seen_specs.append(spec)
        return 0.9 if spec.model == config.REGISTRY["gpt-oss-20b"].model else 0.0

    async def fake_check(*args, **kwargs):
        checked.append(True)
        return None

    monkeypatch.setattr(standard_agent, "answer", fake_answer)
    monkeypatch.setattr(health, "used_frac", used_frac)
    monkeypatch.setattr(chat_adapter.truth, "should_check", lambda *args: True)
    monkeypatch.setattr(chat_adapter.truth, "check", fake_check)

    out = run(chat_adapter.handle({"text": "Photosynthesis kya hai?", "mode": "standard",
                                   "truth": {"check": "auto"}, "meta": {"deep": True}}))[0]

    assert not checked  # 20b has only 10% left, so its optional auto check is skipped
    assert seen_specs and all(s.model == config.REGISTRY["gpt-oss-20b"].model and s.key_slot == 2
                              for s in seen_specs)
    assert out["quota"] == {"provider": "groq", "left": 0.1}


def test_standard_answer_strips_citations_without_a_displayed_source(monkeypatch):
    async def fake_gather(_text):
        row = {"provider": "reuters", "label": "Reuters", "title": "Verified report",
               "url": "https://reuters.com/story"}
        return ("\n\n[SOURCES — fetched just now]\n[S1] Reuters · Verified report · https://reuters.com/story", [row])

    async def fake_answer(_messages, **_kw):
        return {"text": "Claim [S1] is supported; invented citation [S2] is not.", "used": "gpt-oss-120b",
                "searches": 0, "wiki": [], "sources": [], "secs": 1.0}

    monkeypatch.setattr(chat_adapter.sources, "gather", fake_gather)
    monkeypatch.setattr(standard_agent, "answer", fake_answer)
    out = run(chat_adapter.handle({"text": "Alibaba sold shares <news> fact check this claim", "mode": "standard",
                                   "meta": {"deep": True}}))[0]

    assert "Claim [S1] is supported" in out["text"]
    assert "[S2]" not in out["text"]
    assert "[S1] Reuters: Verified report — https://reuters.com/story" in out["text"]
