"""Offline tests for the rate-limit handling (health.reserve_slot, 429 parsing, chain behaviour in llm.chat).
No network: the HTTP client is a fake that answers per model id.
Run: python -m pytest tests -q
"""
import asyncio
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")

import config  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for env in ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY"):
        monkeypatch.setenv(env, "test-key-123456")
    health.reset(clear_usage=True)
    yield
    health.reset(clear_usage=True)


# ---------------------------------------------------------------- fake HTTP

class Resp:
    def __init__(self, status=200, body=None, headers=None, text=""):
        self.status_code, self._body, self.headers, self.text = status, body, headers or {}, text

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


def ok(text="ok", finish="stop"):
    return Resp(200, {"choices": [{"message": {"content": text}, "finish_reason": finish}], "usage": {"total_tokens": 10}})


class Client:
    """script: model id -> Resp | Exception | callable returning one. Unlisted models answer "ok"."""

    def __init__(self, script=None, delay=0.0):
        self.script, self.calls, self.delay = script or {}, [], delay

    async def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append(json["model"])
        if self.delay:
            await asyncio.sleep(self.delay)
        beh = self.script.get(json["model"], ok())
        beh = beh() if callable(beh) else beh
        if isinstance(beh, Exception):
            raise beh
        return beh


def run(coro):
    return asyncio.run(coro)


BIG = [{"role": "user", "content": "x" * 40000}]   # ~13K tokens: never fits Groq's 8K tokens/min
SMALL = [{"role": "user", "content": "q?"}]

GEMINI_DAILY_429 = [{"error": {
    "code": 429,
    "message": "You exceeded your current quota. Please retry in 28s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
        {"@type": "type.googleapis.com/google.rpc.QuotaFailure",
         "violations": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},
        {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "28s"},
    ],
}}]

GEMINI_MINUTE_429 = [{"error": {
    "code": 429,
    "message": "You exceeded your current quota.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
        {"@type": "type.googleapis.com/google.rpc.QuotaFailure",
         "violations": [{"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},
        {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "34s"},
    ],
}}]


# ---------------------------------------------------------------- the window

def test_window_allows_rpm_then_makes_the_next_one_wait():
    t = 1000.0
    assert health.reserve_slot("k", 2, 0, 10, 12, now=t) == (True, 0.0)
    assert health.reserve_slot("k", 2, 0, 10, 12, now=t) == (True, 0.0)
    got, wait = health.reserve_slot("k", 2, 0, 10, 12, now=t)   # 3rd in the same minute: next slot is 60 s away
    assert got is False and 59 < wait < 61
    got, wait = health.reserve_slot("k", 2, 0, 10, 100, now=t)  # willing to wait: it gets the slot when the first leaves
    assert got is True and 59 < wait < 61
    assert health.reserve_slot("other", 2, 0, 10, 12, now=t) == (True, 0.0)  # another model has its own window


def test_window_frees_up_after_a_minute():
    health.reserve_slot("k", 1, 0, 10, 12, now=1000.0)
    assert health.reserve_slot("k", 1, 0, 10, 12, now=1030.0)[0] is False
    assert health.reserve_slot("k", 1, 0, 10, 12, now=1061.0) == (True, 0.0)


def test_window_counts_tokens_per_minute():
    assert health.reserve_slot("g", 0, 8000, 5000, 12, now=1000.0) == (True, 0.0)
    got, wait = health.reserve_slot("g", 0, 8000, 5000, 12, now=1000.0)   # 5000 + 5000 > 8000
    assert got is False and 59 < wait < 61
    assert health.reserve_slot("g", 0, 8000, 2500, 12, now=1000.0) == (True, 0.0)  # 5000 + 2500 fits


def test_completed_reservation_settles_only_its_actual_token_usage():
    assert health.reserve_slot("g", 0, 1000, 600, 0, now=1000.0, reservation_id="request-a") == (True, 0.0)
    assert health.reserve_slot("g", 0, 1000, 300, 0, now=1000.0, reservation_id="request-b") == (True, 0.0)
    assert health.settle_slot("g", "request-a", 20)
    assert health._minute("g", 1000.0) == (2, 320)  # request count/timestamps stay; unused TPM reserve is released
    assert not health.settle_slot("g", "missing", 1)


def test_slots_are_handed_out_in_order():
    health.reserve_slot("k", 1, 0, 1, 100, now=1000.0)
    _, w1 = health.reserve_slot("k", 1, 0, 1, 200, now=1000.0)   # at ~1060
    _, w2 = health.reserve_slot("k", 1, 0, 1, 200, now=1000.0)   # must come after it, ~1120
    assert 59 < w1 < 61 and 119 < w2 < 121


def test_no_limit_means_no_waiting():
    assert health.reserve_slot("none", 0, 0, 10**6, 0, now=1.0) == (True, 0.0)


# ---------------------------------------------------------------- reading a 429

@pytest.mark.parametrize("text,secs", [
    ("Rate limit reached. Please try again in 7.2s. Need more tokens?", 7.2),
    ("Please try again in 2m4.8s.", 124.8),
    ("... Please retry in 34.019s.", 34.019),
    ("try again in 650ms", 0.65),
    ("nothing useful here", None),
])
def test_parse_wait(text, secs):
    got = llm._parse_wait(text)
    assert (got is None) if secs is None else abs(got - secs) < 1e-6


def test_rate_info_reads_gemini_list_body_and_tells_minute_from_day():
    r = Resp(429, GEMINI_MINUTE_429)
    wait, daily = llm._rate_info(r, llm._json(r))
    assert wait == 34 and daily is False
    r = Resp(429, GEMINI_DAILY_429)
    assert llm._rate_info(r, llm._json(r))[1] is True


def test_rate_info_prefers_retry_after_header():
    r = Resp(429, {"error": {"message": "slow down"}}, headers={"retry-after": "7"})
    assert llm._rate_info(r, llm._json(r)) == (7.0, False)


# ---------------------------------------------------------------- the chain

def test_429_with_retry_after_cools_the_model_and_the_chain_moves_on():
    c = Client({"openai/gpt-oss-120b": Resp(429, {"error": {"message": "x"}}, headers={"retry-after": "7"})})
    out = run(llm.chat(c, config.AUDITOR, SMALL, retries=0))
    # Exhaust the Groq models already in this role's chain before contacting Gemini.
    assert out == "ok" and c.calls == ["openai/gpt-oss-120b", config.REGISTRY["qwen3.8-27b"].model]
    assert health.snapshot()["cooling_down"]["gpt-oss-120b"] >= 7


def test_big_prompt_skips_groq_without_any_call_and_goes_to_gemini_lite():
    c = Client()
    assert run(llm.chat(c, config.AUDITOR, BIG, retries=0)) == "ok"
    assert c.calls == ["gemini-3.5-flash-lite"]  # both Groq models were skipped before a request was sent


def test_daily_quota_429_is_not_retried_for_an_hour():
    c = Client({"gemini-3.5-flash-lite": Resp(429, GEMINI_DAILY_429)})
    assert run(llm.chat(c, config.AUDITOR, BIG, retries=0)) == "ok"
    assert c.calls == ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
    assert health.snapshot()["cooling_down"]["gemini-3.5-flash-lite"] >= 3500


def test_openrouter_daily_cap_takes_the_whole_provider_out():
    spec = config.REGISTRY["nemotron-lightning"]
    health.rate_limited(spec, None, daily=True)
    # the daily cap belongs to ONE key: every :free model on that key is out (another OpenRouter key is not)
    assert health.snapshot()["cooling_down"]["key:openrouter"] >= 3500
    assert not health.available(config.REGISTRY["gemma-4-31b"])[0]


def test_empty_answer_is_not_retried_in_the_second_round():
    c = Client({m.model: ok("", finish="length") for m in config.chain_of(config.AUDITOR)})
    with pytest.raises(llm.LLMError) as e:
        run(llm.chat(c, config.AUDITOR, SMALL, retries=0))
    # every model: the first try plus at most ONE bigger-budget retry, and nothing again in round two
    assert all(c.calls.count(m) <= 2 for m in set(c.calls))
    assert len(set(c.calls)) == len(config.chain_of(config.AUDITOR))
    assert "ran out of tokens while thinking" in str(e.value)


def test_budget_stops_the_chain_instead_of_trying_every_model():
    c = Client({m.model: Resp(500, {}) for m in config.chain_of(config.AUDITOR)}, delay=0.15)
    with pytest.raises(llm.LLMError) as e:
        run(llm.chat(c, config.AUDITOR, SMALL, retries=0, budget=0.1))
    assert len(c.calls) == 1 and "time budget used up" in str(e.value)


def test_own_window_spreads_calls_and_the_chain_moves_on_when_full(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_RPM", 2)
    monkeypatch.setattr(config, "RL_MAX_WAIT_S", 0.05)
    spec = config.use("gemini-3.5-flash-lite", "judge", ["nemotron-lightning", "gpt-oss-20b"])
    c = Client()

    async def go():
        for _ in range(3):
            await llm.chat(c, spec, SMALL, retries=0)

    run(go())
    assert c.calls == ["gemini-3.5-flash-lite", "gemini-3.5-flash-lite", "nvidia/nemotron-3.5-lightning:free"]


def test_network_error_tries_the_next_same_provider_model_first():
    c = Client({"openai/gpt-oss-120b": httpx.ConnectError("boom")})
    assert run(llm.chat(c, config.AUDITOR, SMALL, retries=0)) == "ok"
    assert c.calls[:2] == ["openai/gpt-oss-120b", config.REGISTRY["qwen3.8-27b"].model]


def test_auditor_plan_still_follows_the_rules():
    assert config.PLAN_PROBLEMS == []
    assert config.AUDITOR.provider != config.SYNTHESIZER.provider  # not the judge's family
    assert config.rpm_limit(config.REGISTRY["gemini-3.8-flash"]) == config.GEMINI_RPM
    assert config.rpm_limit(config.REGISTRY["safeguard-20b"]) == 3
