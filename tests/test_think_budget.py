"""Offline tests: a thinking model that spends the whole max_tokens on thinking (empty answer, finish "length").

Contract (llm._try_model / llm._think_retry):
  * the SAME model and key is asked once more with a bigger budget and lighter thinking;
  * if that is empty too, the model's other keys are skipped and the chain moves on, still provider-first;
  * Gemma (no effort setting) only gets the bigger budget; a Groq model never goes past its tokens/min limit.
Also: the retired gemini-2.5-flash-lite is no longer in any chain. No test here reaches the network.
"""
import asyncio
import copy
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ.setdefault("USAGE_FILE", os.path.join(os.path.dirname(__file__), ".usage-test.json"))

import config  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402
import mode_plans  # noqa: E402


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code, self._body, self.headers = status, body if body is not None else {}, {}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


def answer(text="ok", finish="stop"):
    return Resp(200, {"choices": [{"message": {"content": text}, "finish_reason": finish}],
                      "usage": {"total_tokens": 10}})


EMPTY = answer("", "length")


class FakeClient:
    """script: (model id, key) -> list of Resp (popped in order) or one Resp. Unlisted calls answer "ok"."""

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


Q = [{"role": "user", "content": "ek lamba sawal?"}]
ENVS = ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY")


@pytest.fixture(autouse=True)
def keys(monkeypatch):
    for env in ENVS:
        for slot in (1, 2, 3):
            name = config.slot_env(env, slot)
            monkeypatch.setenv(name, f"{env.split('_')[0].lower()}-key-{slot}")
    for name in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"):
        for slot in (1, 2, 3):
            monkeypatch.delenv(config.slot_env(name, slot), raising=False)
    health.reset(clear_usage=True)
    yield
    health.reset(clear_usage=True)


def k(provider, slot):
    return f"{provider}-key-{slot}"


# ---------------------------------------------------------------- one retry on the same model and key

def test_gemini_empty_thinking_answer_is_retried_on_the_same_key_with_more_tokens_and_low_effort():
    spec = config.use("gemini-3.8-flash", "judge", ["gpt-oss-120b", "nemotron-ultra"])
    c = FakeClient({("gemini-3.8-flash", k("gemini", 1)): [EMPTY, answer("final jawab")]})
    out = run(llm.chat(c, spec, Q, max_tokens=1800, retries=0))
    assert out == "final jawab"
    assert [(x["model"], x["key"]) for x in c.calls] == [("gemini-3.8-flash", k("gemini", 1))] * 2
    first, second = c.calls[0]["payload"], c.calls[1]["payload"]
    assert first["max_tokens"] == 1800 and "reasoning_effort" not in first  # normal calls keep the model's default
    assert second["max_tokens"] == 1800 + 2048 and second["reasoning_effort"] == "low"


def test_groq_medium_effort_drops_to_low_and_stays_inside_tokens_per_minute():
    spec = config.use("gpt-oss-120b", "judge", ["gemini-3.5-flash-lite", "nemotron-ultra"])
    c = FakeClient({("openai/gpt-oss-120b", k("groq", 1)): [EMPTY, answer("ok 120b")]})
    assert run(llm.chat(c, spec, Q, max_tokens=1800, retries=0)) == "ok 120b"
    second = c.calls[1]["payload"]
    assert c.calls[0]["payload"]["reasoning_effort"] == "medium" and second["reasoning_effort"] == "low"
    room = int(config.tpm_limit(config.REGISTRY["gpt-oss-120b"]) * 0.9) - llm._est_tokens(Q)
    assert second["max_tokens"] == 1800 + 2048 <= room  # bigger, but never past Groq's 8K tokens/min


def test_groq_retry_that_does_not_fit_this_minute_moves_to_the_next_model_not_the_next_key():
    # 6000 tokens already reserved in Groq's 8K/min window: a bigger retry cannot run now. Keys 2/3 at the same
    # 6000 budget would think themselves out too, so the chain goes on (here: Gemini, the next provider in the chain).
    spec = config.use("gpt-oss-120b", "judge", ["gemini-3.5-flash-lite", "nemotron-ultra"])
    c = FakeClient({("openai/gpt-oss-120b", k("groq", s)): [EMPTY, EMPTY] for s in (1, 2, 3)})
    assert run(llm.chat(c, spec, Q, max_tokens=6000, retries=0)) == "ok"
    assert [(x["model"], x["key"]) for x in c.calls] == [("openai/gpt-oss-120b", k("groq", 1)),
                                                         ("gemini-3.5-flash-lite", k("gemini", 1))]


def test_gemma_on_gemini_only_gets_the_bigger_budget_no_effort_param():
    spec = config.use("gemma-4-31b-g", "judge", ["gpt-oss-120b", "nemotron-ultra"])
    model = config.REGISTRY["gemma-4-31b-g"].model
    c = FakeClient({(model, k("gemini", 1)): [EMPTY, answer("gemma ok")]})
    assert run(llm.chat(c, spec, Q, max_tokens=1000, retries=0)) == "gemma ok"
    second = c.calls[1]["payload"]
    assert second["max_tokens"] == 1000 + 2048 and "reasoning_effort" not in second


def test_the_retry_cap_is_respected_and_zero_turns_it_off(monkeypatch):
    spec = config.use("gemini-3.8-flash", "judge", ["gpt-oss-120b", "nemotron-ultra"])
    c = FakeClient({("gemini-3.8-flash", k("gemini", 1)): [EMPTY, answer("capped")]})
    assert run(llm.chat(c, spec, Q, max_tokens=6000, retries=0)) == "capped"
    assert c.calls[1]["payload"]["max_tokens"] == config.THINK_RETRY_MAX_TOKENS

    health.reset(clear_usage=True)
    monkeypatch.setattr(config, "THINK_RETRY_MAX_TOKENS", 0)
    c = FakeClient({("gemini-3.8-flash", k("gemini", 1)): [EMPTY]})
    assert run(llm.chat(c, spec, Q, max_tokens=1800, retries=0)) == "ok"
    assert [x["model"] for x in c.calls][:1] == ["gemini-3.8-flash"]
    assert sum(x["model"] == "gemini-3.8-flash" and x["key"] == k("gemini", 1) for x in c.calls) == 1


# ---------------------------------------------------------------- still empty: next MODEL, provider-first

def test_still_empty_skips_the_models_other_keys_and_tries_the_same_provider_next_model():
    spec = config.use("gemini-3.8-flash", "judge", ["gpt-oss-120b", "gemini-3.5-flash-lite", "nemotron-ultra"])
    c = FakeClient({("gemini-3.8-flash", k("gemini", s)): [EMPTY, EMPTY] for s in (1, 2, 3)})
    assert run(llm.chat(c, spec, Q, max_tokens=1800, retries=0)) == "ok"
    tried = [(x["model"], x["key"]) for x in c.calls]
    # key 1 twice (first try + bigger retry); keys 2/3 of the SAME model are not burnt; then Gemini's next model
    assert tried == [("gemini-3.8-flash", k("gemini", 1)), ("gemini-3.8-flash", k("gemini", 1)),
                     ("gemini-3.5-flash-lite", k("gemini", 1))]


def test_every_model_empty_reports_the_thinking_reason():
    spec = config.use("gemini-3.8-flash", "judge", ["gpt-oss-120b", "nemotron-ultra"])
    script = {}
    for model in ("gemini-3.8-flash", "openai/gpt-oss-120b", config.REGISTRY["nemotron-ultra"].model):
        prov = "gemini" if model.startswith("gemini") else ("groq" if model.startswith("openai/") else "openrouter")
        for s in (1, 2, 3):
            script[(model, k(prov, s))] = [EMPTY, EMPTY]
    c = FakeClient(script)
    with pytest.raises(llm.LLMError) as e:
        run(llm.chat(c, spec, Q, max_tokens=1800, retries=0))
    assert "ran out of tokens while thinking, also after a retry with" in str(e.value)
    assert len(c.calls) == 6  # 3 models x (first try + one retry); no other key, no second round


def test_empty_without_length_is_not_a_token_problem_and_keeps_the_key_order():
    spec = config.use("gemini-3.8-flash", "judge", ["gpt-oss-120b", "nemotron-ultra"])
    c = FakeClient({("gemini-3.8-flash", k("gemini", 1)): [answer("", "stop")]})
    assert run(llm.chat(c, spec, Q, max_tokens=1800, retries=0)) == "ok"
    tried = [(x["model"], x["key"]) for x in c.calls]
    assert tried == [("gemini-3.8-flash", k("gemini", 1)), ("gemini-3.8-flash", k("gemini", 2))]


# ---------------------------------------------------------------- retired Gemini model

def _all_chains():
    rows = list(config.all_roles()) + [("guard_llm", config.GUARD_LLM)]
    rows += list(mode_plans.plan_roles())
    return rows


def test_retired_gemini_2_5_flash_lite_is_in_no_chain_and_plans_stay_valid():
    for name, spec in _all_chains():
        labels = [spec.label, *spec.fallbacks]
        assert "gemini-2.5-flash-lite" not in labels, name
        assert all(not m.model.startswith("gemini-2.5-flash-lite") for m in config.chain_of(spec)), name
    assert config.PLAN_PROBLEMS == [] and mode_plans.PLAN_PROBLEMS == []
