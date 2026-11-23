"""Per-mode model combinations + behaviour (mode_plans.py). Offline: models and web are faked (fixture from test_roles)."""
import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
sys.path.insert(0, os.path.dirname(__file__))
import chat_adapter  # noqa: E402
import config  # noqa: E402
import mode_plans  # noqa: E402
import pipeline  # noqa: E402
import roles  # noqa: E402
from test_roles import GOOD, role_of, run, script  # noqa: E402,F401  (script is a fixture)


@pytest.fixture
def seen(script, monkeypatch):
    """Records (role, model label) of every role call; the classifier answers `task` (default general)."""
    rec = {"pairs": [], "task": "general"}
    inner = roles.chat

    async def wrap(client, spec, messages, **kw):
        if spec is config.CLASSIFIER:
            script["calls"].append("classify")
            return rec["task"]
        rec["pairs"].append((role_of(messages), spec.label))
        return await inner(client, spec, messages, **kw)

    for mod in (pipeline, roles):
        monkeypatch.setattr(mod, "chat", wrap)
    return rec


def labels(rec, role):
    return [l for r, l in rec["pairs"] if r == role]


# ------------------------------------------------------------------ the plans themselves

def test_every_mode_plan_is_valid_and_complete():
    assert mode_plans.PLAN_PROBLEMS == []
    assert set(mode_plans.PLANS) == {"standard", "verified", "physics", "math", "business", "coding"}
    for p in mode_plans.PLANS.values():
        assert set(mode_plans.ROLE_KEYS) <= set(p.chains)
        assert len(p.falsifiers) >= max(p.policy.falsifiers)


def test_modes_have_separate_combinations():
    sigs = {m: tuple(p.chains[r].label for r in mode_plans.ROLE_KEYS) + tuple(s.label for s in p.falsifiers)
            for m, p in mode_plans.PLANS.items()}
    assert len(set(sigs.values())) == len(sigs)  # no two modes share the same combination
    P = mode_plans.PLANS
    assert P["coding"].spec("empiricist").label == "qwen3.8-27b" and P["coding"].spec("specialist").label == "glm-5-3-flash"
    assert P["business"].spec("specialist").label == "mistral-large-4"
    assert P["math"].spec("specialist").label == "nemotron-ultra"
    assert P["standard"].spec("theorist").label == "gpt-oss-20b"  # lite models for everyday chat


def test_no_mode_starts_a_big_input_role_on_groq():
    # judge / refiner read everything: Groq's 8K tokens/min would only waste the first try
    for p in mode_plans.PLANS.values():
        for r in ("judge",):
            assert p.spec(r).provider != "groq", (p.mode, r)


def test_describe_for_the_ui():
    d = mode_plans.describe("v")
    assert d["mode"] == "verified" and d["models"]["judge"] and d["policy"]["falsifiers"] == [3, 3]


# ------------------------------------------------------------------ behaviour per mode

def test_each_mode_uses_its_own_models(script, seen):
    for ui, mode in (("coding", "coding"), ("business", "business"), ("math", "math")):
        seen["pairs"].clear()
        script["judge"] = [GOOD]
        run(mode=ui, deep=False)
        plan = mode_plans.get(mode)
        assert labels(seen, "theorist") == [plan.spec("theorist").label], ui
        assert labels(seen, "architect") == [plan.spec("architect").label], ui
        assert labels(seen, "judge")[0] == plan.spec("judge").label


def test_v_mode_forces_deep_and_checks_everything(script, seen):
    script["map"]["conflicts"] = []
    script["falsifier"] = "CLAIM: x\nATTACK: y\nRESULT: SURVIVED"
    res = run(mode="v", deep=False)
    c = script["calls"]
    assert "specialist" in c and "pattern" in c
    assert c.count("falsifier") == 3
    assert "debater" in c                          # V debates even without a clash
    assert "method" in c and "evidence" in c
    assert res["mode"] == "verified" and res["combo"]["mode"] == "verified"
    assert "V MODE" in script["systems"]["judge"][0]


def test_standard_general_is_light(script, seen):
    script["map"]["conflicts"] = []
    script["falsifier"] = "CLAIM: x\nATTACK: y\nRESULT: SURVIVED"
    res = run(q="Mujhe ek chhota sa birthday message likh do", mode="standard", deep=False)
    c = script["calls"]
    assert res["mode"] == "standard"
    assert c.count("falsifier") == 1 and "specialist" not in c and "pattern" not in c
    assert "evidence" in c and "method" not in c
    assert labels(seen, "theorist") == ["gpt-oss-20b"]


def test_business_always_researches_and_checks_numbers(script, seen):
    script["architect"] = "GOAL: pricing\nPARTS: 1. costs\nSEARCH: none"
    res = run(q="Should I price my SaaS at 10 or 20 dollars?", mode="business", deep=False)
    c = script["calls"]
    assert script["queries"] and script["queries"][0][0].startswith("Should I price")  # SEARCH: none, still searched
    assert "specialist" in c and "evidence" in c                  # specialist + evidence reviewer even in fast
    assert "BUSINESS MODE" in script["systems"]["judge"][0] and "BUSINESS MODE" in script["systems"]["falsifier"][0]
    assert res["combo"]["models"]["specialist"] == "mistral-large-4"


def test_math_runs_pattern_finder_and_method_review_in_fast(script, seen):
    seen["task"] = "math"
    run(q="Solve x^2 - 5x + 6 = 0", mode="math", deep=False)
    c = script["calls"]
    assert "pattern" in c and "method" in c and "evidence" not in c
    assert "MATH MODE" in script["systems"]["method"][0]


def test_research_cap_follows_the_mode(script, seen, monkeypatch):
    caps = []

    async def fake_gather(client, queries, max_sources=None):
        caps.append(max_sources)
        return []

    monkeypatch.setattr(roles.research, "gather", fake_gather)
    run(mode="math", deep=False)
    run(mode="v", deep=False)
    assert caps == [mode_plans.MATH.policy.max_sources, mode_plans.VERIFIED.policy.max_sources]


def test_tight_quota_drops_the_always_extras(script, seen):
    script["pressure"], script["left"] = "tight", 0.3
    script["map"]["conflicts"] = []
    script["falsifier"] = "CLAIM: x\nATTACK: y\nRESULT: SURVIVED"
    res = run(mode="v")
    c = script["calls"]
    assert "specialist" not in c and "pattern" not in c and "debater" not in c
    assert c.count("falsifier") == 2 and "judge" in c
    assert res["quota"]["saved"]


def test_v_mode_warns_on_low_confidence(script, seen):
    from test_roles import GOOD
    low = GOOD.replace("CONFIDENCE: high", "CONFIDENCE: low")
    script["judge"] = [low]
    script["refiner"] = "nothing"
    script["evidence"] = '{"issues": []}'
    res = run(mode="v")
    assert any("CONFIDENCE low" in w for w in res["warnings"])


def test_code_proofs_follow_the_mode(script, seen, monkeypatch):
    called = []

    async def fake_verify(client, question, task, m, f, errors, spec=None):
        called.append(spec.label if spec else None)
        return []

    monkeypatch.setattr(roles.verified, "verify_with_code", fake_verify)
    monkeypatch.setattr(config, "CODE_EXEC_SUPPORTED", True)
    script["judge"] = [GOOD]
    run(q="Write a function that returns x", mode="coding", deep=False, run_code=True)  # task general, coding: always
    script["judge"] = [GOOD]
    run(q="Price my SaaS", mode="business", deep=False, run_code=True)                  # business: never
    assert called == [mode_plans.CODING.spec("verifier").label]


def test_adapter_step_shows_the_mode_combo(script, seen):
    out = asyncio.run(chat_adapter.handle({"text": "Is this statistic reliable? 90% of startups fail", "mode": "v"}))
    r = out[0] if isinstance(out, list) else out
    assert any("combo" in s.lower() and "V (verified)" in s for s in r["steps"])
