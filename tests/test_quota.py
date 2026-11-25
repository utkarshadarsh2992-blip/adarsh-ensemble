"""Quota saving: judge reserve, learned daily caps (kept on disk), load balancing, pressure levels. No network."""
import asyncio
import importlib
import time
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")

import config  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code, self._body, self.headers, self.text = status, body, {}, ""

    def json(self):
        return self._body


def ok():
    return Resp(200, {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}], "usage": {"total_tokens": 10}})


class Client:
    def __init__(self, script=None):
        self.script, self.calls = script or {}, []

    async def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append(json["model"])
        return self.script.get(json["model"], ok())


SMALL = [{"role": "user", "content": "q?"}]
GEMINI_DAILY_429 = [{"error": {"code": 429, "message": "You exceeded your current quota. Please retry in 28s.",
                               "status": "RESOURCE_EXHAUSTED", "details": [
    {"@type": "type.googleapis.com/google.rpc.QuotaFailure",
     "violations": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},
    {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "28s"}]}}]

G120 = config.REGISTRY["gpt-oss-120b"]
GEM = config.REGISTRY["gemini-3.8-flash"]


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for env in ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY"):
        monkeypatch.setenv(env, "test-key-123456")
    health.reset(clear_usage=True)
    health.set_stage("")
    yield
    health.reset(clear_usage=True)
    health.set_stage("")


def use_tokens(spec, share):
    health._usage["tok"][health.quota_key(spec)] = int(config.GROQ_TPD * share)


def test_helpers_leave_the_last_part_of_a_quota_for_the_judge():
    use_tokens(G120, 0.85)
    health.set_stage("panel:theorist")
    ok, why = health.available(G120)
    assert not ok and "kept for the judge" in why
    health.set_stage("judge")
    assert health.available(G120)[0]
    use_tokens(G120, 0.96)
    assert not health.available(G120)[0]  # the hard 95% stop still holds for everyone


def test_no_stage_means_old_behaviour():
    use_tokens(G120, 0.85)
    assert health.available(G120)[0]


def test_daily_429_teaches_the_cap_and_survives_restart_and_day_roll():
    key = health.quota_key(GEM)
    health._usage["req"][key] = 30
    health.rate_limited(GEM, 28, daily=True)
    assert health._usage["learned"][key] == 30
    # restart: a fresh module load reads the file, the model stays out without a new request
    importlib.reload(health)
    assert not health.available(GEM)[0]
    assert health.req_limit(GEM) == 30
    # next day: counters reset, the learned cap stays, so we stop at 95% of it BEFORE a 429
    health._usage["day"] = "2000-01-01"
    health._roll()
    # the UTC day rolled, but Gemini's own day (midnight Pacific) has not: the saved mark still holds
    assert not health.available(GEM)[0]
    # ... once the provider's reset time has passed, the model is back, with the learned cap
    health._usage["out"][key] = time.time() - 1
    health.reset()
    assert health.req_limit(GEM) == 30 and health.available(GEM)[0]
    health._usage["req"][key] = 29
    assert not health.available(GEM)[0]


def test_a_tiny_count_is_not_learned_as_a_cap():
    health._usage["req"][health.quota_key(GEM)] = 3
    health.rate_limited(GEM, 28, daily=True)
    assert health.quota_key(GEM) not in health._usage["learned"]


def test_configured_caps_are_not_overwritten_by_learning():
    g = config.REGISTRY["gpt-oss-20b"]
    health._usage["req"][health.quota_key(g)] = 500
    health.rate_limited(g, 60, daily=True)
    assert health.req_limit(g) == config.GROQ_RPD


def test_end_to_end_daily_429_learns(monkeypatch):
    c = Client({"gemini-3.8-flash": Resp(429, GEMINI_DAILY_429)})
    health._usage["req"][health.quota_key(GEM)] = 40
    with pytest.raises(llm.LLMError):  # a bare registry model has no fallbacks
        asyncio.run(llm.chat(c, GEM, SMALL))
    assert health._usage["learned"][health.quota_key(GEM)] == 41
    # the judge chain (gemini first) now skips gemini without spending a request and answers from the next model
    c2 = Client({"gemini-3.8-flash": Resp(429, GEMINI_DAILY_429)})
    assert asyncio.run(llm.chat(c2, config.SYNTHESIZER, SMALL)) == "ok"
    assert "gemini-3.8-flash" not in c2.calls


def test_helper_chain_keeps_a_usable_primary_even_when_quota_is_heavy(monkeypatch):
    use_tokens(G120, 0.7)
    monkeypatch.setattr(config, "QUOTA_BALANCE_AT", 0.6)  # an old deployment value cannot bypass provider priority
    health.set_stage("panel:theorist")
    c = Client()
    asyncio.run(llm.chat(c, config.THEORIST, SMALL))
    assert c.calls[0] == G120.model
    health.set_stage("judge")  # critical calls also keep the primary provider first
    chain = [G120, GEM]
    assert llm.balance(chain) == chain


def test_balance_keeps_order_when_everything_is_heavy():
    chain = [G120, config.REGISTRY["gpt-oss-20b"]]
    for s in chain:
        use_tokens(s, 0.7)
    health.set_stage("skeptic")
    assert llm.balance(chain) == chain


def test_pressure_levels():
    chains = [config.THEORIST, config.EVIDENCE_REVIEWER, config.SKEPTIC]
    assert health.pressure(chains)[0] == "ok"
    for s in chains:
        if s.provider == "groq":
            use_tokens(s, 0.75)
    level, left = health.pressure(chains)
    assert level == "tight" and abs(left - 0.25) < 0.01
    for s in chains:
        if s.provider == "groq":
            use_tokens(s, 0.9)
    assert health.pressure(chains)[0] == "low"


def test_snapshot_shows_learned_caps():
    key = health.quota_key(GEM)
    health._usage["req"][key] = 25
    health.rate_limited(GEM, None, daily=True)
    snap = health.snapshot()
    assert snap["learned_daily_caps"][key] == 25 and key in snap["out_today"]
