"""Offline tests: thinking by the weight of the question (thinking.py) and the day-long skip list (health.py).

Thinking: every council mode weighs the question on the phone; each role call then gets a thinking level that fits
its budget (never "empty answer, ran out of tokens while thinking" because of too much thinking on a small budget).
Standard never gets a weight. Skip list: a used-up DAILY quota skips that model+key until the provider's reset,
a retired model (404) is skipped on every key; both survive a restart; a changed key clears its provider's marks.
No test reaches the network.
"""
import asyncio
import copy
import datetime as dt
import importlib
import json
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ.setdefault("USAGE_FILE", os.path.join(os.path.dirname(__file__), ".usage-test.json"))

import config  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402
import thinking  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


class Resp:
    def __init__(self, status=200, body=None, headers=None):
        self.status_code, self._body, self.headers = status, body if body is not None else {}, dict(headers or {})
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


def answer(text="ok", finish="stop"):
    return Resp(200, {"choices": [{"message": {"content": text}, "finish_reason": finish}], "usage": {"total_tokens": 10}})


EMPTY = answer("", "length")


class FakeClient:
    def __init__(self, script=None):
        self.script, self.calls = dict(script or {}), []

    async def post(self, url, json=None, headers=None, timeout=None):
        key = (headers or {}).get("Authorization", "").removeprefix("Bearer ")
        self.calls.append({"model": json["model"], "key": key, "payload": copy.deepcopy(json)})
        beh = self.script.get((json["model"], key), answer())
        if isinstance(beh, list):
            beh = beh.pop(0) if beh else answer()
        return beh


def run(coro):
    return asyncio.run(coro)


def k(provider, slot):
    return f"{provider}-key-{slot}"


Q = [{"role": "user", "content": "sawal?"}]
ENVS = ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY")


@pytest.fixture(autouse=True)
def keys(monkeypatch):
    for env in ENVS:
        for slot in (1, 2, 3):
            monkeypatch.setenv(config.slot_env(env, slot), f"{env.split('_')[0].lower()}-key-{slot}")
    for name in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"):
        for slot in (1, 2, 3):
            monkeypatch.delenv(config.slot_env(name, slot), raising=False)
    health.reset(clear_usage=True)
    yield
    health.reset(clear_usage=True)


def weighted(level, stage, coro_fn):
    """Run coro_fn() with a question weight and a stage set, like chat_adapter + roles._call do."""
    async def go():
        tok = thinking.set_weight(level)
        try:
            health.set_stage(stage)
            return await coro_fn()
        finally:
            thinking.reset(tok)
    return run(go())


# ---------------------------------------------------------------- the weight itself

def test_weight_light_medium_heavy():
    assert thinking.weigh("hi, kaise ho", "business") == thinking.LIGHT
    assert thinking.weigh("Photosynthesis kya hota hai?", "v") == thinking.LIGHT
    medium = "Explain why the Indian monsoon fails in some years and compare El Nino with La Nina effects on rainfall."
    assert thinking.weigh(medium, "v") == thinking.MEDIUM
    heavy = ("1. Prove that the integral of x^2 from 0 to 1 is 1/3.\n2. Derive the equation of motion.\n"
             "3. Solve for t when 2*t = 10?\n4. Explain step by step why energy is conserved?\n") * 4
    assert thinking.weigh(heavy, "physics") == thinking.HEAVY


def test_light_roles_are_capped_and_no_weight_means_untouched():
    assert thinking.level_for("architect", thinking.HEAVY) == thinking.LIGHT
    assert thinking.level_for("skeptic", thinking.HEAVY) == thinking.LIGHT
    assert thinking.level_for("decompose:1", thinking.HEAVY) == thinking.LIGHT
    assert thinking.level_for("falsifier:1", thinking.HEAVY) == thinking.MEDIUM
    assert thinking.level_for("review:method", thinking.HEAVY) == thinking.MEDIUM
    assert thinking.level_for("judge", thinking.HEAVY) == thinking.HEAVY
    assert thinking.level_for("panel:theorist", thinking.MEDIUM) == thinking.MEDIUM
    assert thinking.current() is None
    assert thinking.plan("gemini", "gemini-3.8-flash", {}, 1800, 10, 0, "judge") == (1800, {}, None)


def test_only_models_with_a_known_thinking_switch_are_changed():
    assert thinking.param_for("groq", "openai/gpt-oss-120b") == "effort"
    assert thinking.param_for("groq", "openai/gpt-oss-safeguard-20b") is None  # classifier keeps its own setting
    assert thinking.param_for("gemini", "gemini-3.8-flash") == "effort"
    assert thinking.param_for("gemini", "gemma-4-31b-it") is None
    assert thinking.param_for("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free") == "openrouter"
    assert thinking.param_for("nvidia", "moonshotai/kimi-k3.1-pro") is None
    assert thinking.param_for("groq", "qwen/qwen3.8-27b") is None


# ---------------------------------------------------------------- weight -> request

def test_heavy_judge_on_gemini_thinks_high_with_a_bigger_budget():
    spec = config.use("gemini-3.8-flash", "judge", ["gpt-oss-120b", "nemotron-ultra"])
    c = FakeClient()
    assert weighted(thinking.HEAVY, "judge", lambda: llm.chat(c, spec, Q, max_tokens=6000, retries=0)) == "ok"
    p = c.calls[0]["payload"]
    assert p["reasoning_effort"] == "high" and p["max_tokens"] == 6000 + thinking.THINK_EXTRA_TOKENS[thinking.HEAVY]


def test_light_question_thinks_low_without_extra_tokens():
    spec = config.use("gpt-oss-120b", "theorist", ["gemini-3.8-flash", "nemotron-ultra"])
    c = FakeClient()
    weighted(thinking.LIGHT, "panel:theorist", lambda: llm.chat(c, spec, Q, max_tokens=3000, retries=0))
    p = c.calls[0]["payload"]
    assert p["reasoning_effort"] == "low" and p["max_tokens"] == 3000


def test_heavy_on_groq_thinks_less_so_it_still_fits_tokens_per_minute():
    # 8K tokens/min on Groq: 3000 + 4096 extra + a long prompt does not fit, so the level steps down instead of the
    # request being skipped as too big (or thinking itself empty)
    spec = config.use("gpt-oss-120b", "theorist", ["gemini-3.8-flash", "nemotron-ultra"])
    msgs = [{"role": "user", "content": "x" * 6000}]  # ~2000 tokens
    c = FakeClient()
    assert weighted(thinking.HEAVY, "panel:theorist", lambda: llm.chat(c, spec, msgs, max_tokens=3000, retries=0)) == "ok"
    p = c.calls[0]["payload"]
    assert p["model"] == "openai/gpt-oss-120b"  # not skipped
    room = int(config.tpm_limit(config.REGISTRY["gpt-oss-120b"]) * 0.9) - llm._est_tokens(msgs)
    assert p["max_tokens"] <= room and p["reasoning_effort"] in ("medium", "low")
    assert p["max_tokens"] == 3000 + thinking.THINK_EXTRA_TOKENS[thinking.MEDIUM]


def test_architect_stays_light_even_for_a_heavy_question():
    spec = config.use("gpt-oss-20b", "architect", ["gemini-3.1-flash-lite", "nemotron-lightning"])
    c = FakeClient()
    weighted(thinking.HEAVY, "architect", lambda: llm.chat(c, spec, Q, max_tokens=1800, retries=0))
    assert c.calls[0]["payload"]["reasoning_effort"] == "low" and c.calls[0]["payload"]["max_tokens"] == 1800


def test_openrouter_empty_think_is_retried_with_lower_thinking():
    spec = config.use("nemotron-ultra", "judge", ["gpt-oss-120b", "gemini-3.8-flash"])
    model = config.REGISTRY["nemotron-ultra"].model
    c = FakeClient({(model, k("openrouter", 1)): [EMPTY, answer("ultra ok")]})
    assert weighted(thinking.HEAVY, "judge", lambda: llm.chat(c, spec, Q, max_tokens=3000, retries=0)) == "ultra ok"
    first, second = c.calls[0]["payload"], c.calls[1]["payload"]
    assert first["reasoning"] == {"effort": "high", "exclude": True}
    assert second["reasoning"]["effort"] == "low" and second["max_tokens"] > first["max_tokens"] - 1


def test_standard_mode_never_gets_a_weight():
    src = (ROOT / "chat_adapter.py").read_text()
    assert 'thinking.weigh(text, ui_mode) if ui_mode != "standard" else None' in src
    assert "thinking.reset(weight)" in src
    assert "thinking" not in (ROOT / "standard_agent.py").read_text()


# ---------------------------------------------------------------- skip list

def _ts(y, mo, d, h, mi=0):
    return dt.datetime(y, mo, d, h, mi, tzinfo=dt.timezone.utc).timestamp()


def test_next_reset_per_provider():
    now = _ts(2026, 11, 25, 9, 0)
    assert health.next_reset("gemini", now) == _ts(2026, 11, 26, 8)
    assert health.next_reset("gemini", _ts(2026, 11, 25, 7, 59)) == _ts(2026, 11, 25, 8)
    assert health.next_reset("openrouter", now) == _ts(2026, 11, 26, 0)


def test_daily_skip_gemini_until_reset_groq_trusts_its_rolling_wait():
    now = _ts(2026, 11, 25, 9, 0)
    gem, groq = config.REGISTRY["gemini-3.8-flash"], config.REGISTRY["gpt-oss-120b"]
    assert health.daily_skip_seconds(gem, 34, now) == pytest.approx(23 * 3600)  # "retry in 34s" is not believed
    assert health.daily_skip_seconds(groq, 432, now) == 432                     # Groq's rolling day frees in 7m12s
    assert health.daily_skip_seconds(groq, None, now) == pytest.approx(15 * 3600)


def test_daily_quota_mark_skips_only_that_key_and_survives_restart():
    spec = config.use("gemini-3.8-flash", "judge", ["gpt-oss-120b", "nemotron-ultra"])
    daily = Resp(429, {"error": {"message": "Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier. "
                                            "Please retry in 34s."}})
    c = FakeClient({("gemini-3.8-flash", k("gemini", 1)): [daily]})
    assert run(llm.chat(c, spec, Q, max_tokens=1000, retries=0)) == "ok"
    assert [(x["model"], x["key"]) for x in c.calls] == [("gemini-3.8-flash", k("gemini", 1)),
                                                         ("gemini-3.8-flash", k("gemini", 2))]
    until = health._usage["out"][health.quota_key(config.keyed(config.REGISTRY["gemini-3.8-flash"], 1))]
    assert until >= health.next_reset("gemini") - 5
    importlib.reload(health)  # app restart: the mark is read from disk, no request needed to learn it again
    ok, why = health.available(config.keyed(config.REGISTRY["gemini-3.8-flash"], 1))
    assert not ok and "daily quota used up" in why
    assert health.available(config.keyed(config.REGISTRY["gemini-3.8-flash"], 2))[0]


def test_model_not_found_skips_every_key_and_is_remembered():
    spec = config.use("gemini-3.5-flash-lite", "judge", ["gpt-oss-120b", "gemini-3.1-flash-lite"])
    gone = Resp(404, {"error": {"message": "This model models/gemini-3.5-flash-lite is no longer available."}})
    c = FakeClient({("gemini-3.5-flash-lite", k("gemini", 1)): [gone]})
    assert run(llm.chat(c, spec, Q, max_tokens=1000, retries=0)) == "ok"
    tried = [(x["model"], x["key"]) for x in c.calls]
    assert tried == [("gemini-3.5-flash-lite", k("gemini", 1)), ("gemini-3.1-flash-lite", k("gemini", 1))]
    importlib.reload(health)
    for slot in (1, 2, 3):
        ok, why = health.available(config.keyed(config.REGISTRY["gemini-3.5-flash-lite"], slot))
        assert not ok and why.startswith("skipped today")
    assert health.snapshot()["gone_today"]


def test_a_400_that_says_decommissioned_is_treated_as_gone_not_retried_plain():
    spec = config.use("gpt-oss-20b", "judge", ["gemini-3.1-flash-lite", "nemotron-lightning"])
    dead = Resp(400, {"error": {"message": "The model `openai/gpt-oss-20b` has been decommissioned.",
                                "code": "model_decommissioned"}})
    c = FakeClient({("openai/gpt-oss-20b", k("groq", 1)): [dead]})
    assert run(llm.chat(c, spec, Q, max_tokens=1000, retries=0)) == "ok"
    assert [x["model"] for x in c.calls] == ["openai/gpt-oss-20b", "gemini-3.1-flash-lite"]


def test_a_normal_400_is_not_a_gone_model():
    assert not llm._model_gone({"error": {"message": "Unsupported parameter: reasoning_effort"}}, Resp(400))
    assert llm._model_gone({"error": {"message": "x", "code": "model_not_found"}}, Resp(400))


def test_marks_survive_the_utc_day_roll_while_in_the_future_and_a_new_key_clears_them():
    gem = config.keyed(config.REGISTRY["gemini-3.8-flash"], 2)
    health._usage["out"][health.quota_key(gem)] = time.time() + 3600
    health.model_gone(config.REGISTRY["gemini-3.1-flash-lite"], "model not found")
    health._usage["day"] = "2000-01-01"
    health._roll()
    assert health.quota_key(gem) in health._usage["out"] and health._usage["gone"]
    health.forget_provider("gemini")
    assert not health._usage["out"] and not health._usage["gone"]
    assert health.available(gem)[0] and health.available(config.REGISTRY["gemini-3.1-flash-lite"])[0]


def test_saving_a_key_on_android_clears_that_providers_marks():
    src = (ROOT / "android_entry.py").read_text()
    assert "_forget_marks(name)" in src and 'sys.modules["health"].forget_provider(provider)' in src
