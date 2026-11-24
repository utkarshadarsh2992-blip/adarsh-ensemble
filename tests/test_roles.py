"""Offline tests for the roles engine (roles.py + role_prompts.py + research.py). No network: models and web are faked.
Run: python -m pytest tests -q
"""
import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")

import android_entry  # noqa: E402
import chat_adapter  # noqa: E402
import config  # noqa: E402
import pipeline  # noqa: E402
import research  # noqa: E402
import role_prompts as RP  # noqa: E402
import roles  # noqa: E402
import verified  # noqa: E402

GOOD = ("### Short answer\nv = sqrt(2GM/R), about 11.2 km/s for Earth [S1].\n"
        "### Explanation\n1. Energy: KE = GPE [REASONED]\n2. Solve for v [PROVEN by code]\n"
        "### Common mistake / Limits\nIgnoring air drag; it always works everywhere.\n"
        "CONFIDENCE: high - derived and checked")
REVISED = GOOD.replace("it always works everywhere", "it holds without atmosphere or thrust")
CODE_GOOD = ("### Solution (code)\n```python\ndef f(x):\n    return x\n```\n### How it works\nReturns x.\n"
             "### Edge cases and tests\nEmpty input.\nCONFIDENCE: medium - not run")
SOURCES = [{"n": 1, "title": "Wikipedia: Escape velocity", "url": "https://en.wikipedia.org/wiki/Escape_velocity",
            "text": "Escape velocity from Earth is about 11.186 km/s.", "via": "wikipedia"},
           {"n": 2, "title": "Wikipedia: Gravity", "url": "https://en.wikipedia.org/wiki/Gravity",
            "text": "Gravity is a fundamental interaction.", "via": "wikipedia"}]


def role_of(messages) -> str:
    sys_text = messages[0]["content"] if messages else ""
    for r, needle in [("architect", "ROLE: Architect"), ("theorist", "ROLE: Theorist"), ("empiricist", "ROLE: Empiricist"),
                      ("skeptic", "ROLE: Skeptic"), ("pattern", "ROLE: Pattern Finder"), ("falsifier", "ROLE: Falsifier"),
                      ("debater", "ROLE: Debater"), ("judge", "ROLE: Judge"), ("method", "ROLE: Methodology Reviewer"),
                      ("evidence", "ROLE: Evidence Reviewer"), ("refiner", "ROLE: Refiner"), ("specialist", "(specialist)")]:
        if needle in sys_text:
            return r
    return "other"


@pytest.fixture
def script(monkeypatch):
    s = {
        "architect": "GOAL: escape velocity\nPARTS: 1. energy\nSEARCH: escape velocity || gravitational potential energy",
        "theorist": "PRINCIPLE: energy conservation\nRESULT: v = sqrt(2GM/R)",
        "empiricist": "OBSERVED: g = 9.8\nSANITY: ~11 km/s",
        "specialist": "Derivation: v = sqrt(2gR) ~ 11.2 km/s",
        "skeptic": "DOUBT 1: drag ignored | WHY SHAKY: atmosphere | SETTLE IT BY: compare with rockets\nWORST ONE: 1",
        "pattern": "PATTERN: energy conservation\nWHY IT FITS: conservative field",
        "falsifier": "CLAIM: v = 11.2 km/s\nATTACK: from the Moon\nRESULT: SURVIVED",
        "debater": ["OPPOSING CASE:\n 1. drag\nREPLY:\n 1. partly because drag\nAFTER THIS ROUND: keep, add drag note",
                    "OPPOSING CASE:\n 1. drag\nREPLY:\n 1. holds\nAFTER THIS ROUND: keep"],
        "judge": [GOOD],
        "method": "VERDICT: PASS\nChecked energy method.",
        "evidence": json.dumps({"issues": [{"quote": "it always works everywhere", "kind": "overconfident",
                                            "problem": "absolute", "fix": "holds without atmosphere", "confidence": "high"}]}),
        "refiner": f"REVISED:\n{REVISED}\nCHANGES:\n - softened absolute (critique 1)\nSKIPPED:\n - none",
        "map": {"claims": {"A": ["v = sqrt(2GM/R)"], "B": ["~11 km/s"]}, "consensus": ["v = sqrt(2GM/R)"], "conflicts": []},
        "calls": [], "users": {}, "systems": {}, "queries": [],
    }

    async def fake_chat(client, spec, messages, **kw):
        if spec is config.CLASSIFIER:
            s["calls"].append("classify")
            return "science"
        if spec is config.STRIPPER:
            s["calls"].append("stripper")
            return json.dumps(s["map"])
        user = messages[-1]["content"]
        if user.startswith("Format error:"):
            s["calls"].append("repair")
            return s["judge"].pop(0) if s["judge"] else GOOD
        r = role_of(messages)
        s["calls"].append(r)
        s["users"].setdefault(r, []).append(user)
        s["systems"].setdefault(r, []).append(messages[0]["content"])
        v = s.get(r, "x")
        if isinstance(v, list):
            return v.pop(0) if len(v) > 1 else v[0]
        if isinstance(v, Exception):
            raise v
        return v

    async def fake_gather(client, queries, max_sources=None):
        s["queries"].append(list(queries))
        return [dict(x) for x in SOURCES]

    for mod in (pipeline, verified, roles):
        monkeypatch.setattr(mod, "chat", fake_chat)
    monkeypatch.setattr(research, "gather", fake_gather)
    monkeypatch.setattr(config, "CHAT_ENGINE", "roles")
    monkeypatch.setattr(config, "RESEARCH_ENABLED", True)
    monkeypatch.setattr(roles.health, "pressure", lambda chains: (s.get("pressure", "ok"), s.get("left", 1.0)))
    return s


def run(q="Escape velocity of Earth derive karo", **kw):
    kw.setdefault("deep", True)
    kw.setdefault("run_code", False)
    kw.setdefault("use_guard", False)
    kw.setdefault("mode", "physics")  # council fixtures select Physics; Standard is never auto-promoted now
    return asyncio.run(pipeline.run(q, engine="roles", record=True, **kw))


# ------------------------------------------------------------------ full flows

def test_deep_flow_runs_every_role_in_order(script):
    script["map"]["conflicts"] = [{"issue": "value", "kind": "factual", "positions": {"A": "11.2", "B": "7.9"}}]
    res = run()
    c = script["calls"]
    for r in ("architect", "theorist", "empiricist", "specialist", "skeptic", "pattern", "stripper",
              "falsifier", "debater", "judge", "method", "evidence", "refiner"):
        assert r in c, r
    assert c.index("architect") < c.index("theorist") < c.index("skeptic") < c.index("falsifier") < c.index("judge") < c.index("refiner")
    assert c.count("falsifier") == 3
    assert res["engine"] == "roles" and res["mode"] == "physics"  # explicitly selected Physics hint
    assert "holds without atmosphere" in res["answer"]              # refiner applied the high-confidence evidence issue
    assert res["audit"]["applied"] and res["confidence"] == "high"


def test_fast_flow_is_lean(script):
    script["map"]["conflicts"] = []
    script["falsifier"] = "CLAIM: x\nATTACK: y\nRESULT: SURVIVED"
    res = run(deep=False)
    c = script["calls"]
    assert "specialist" not in c and "pattern" not in c
    assert c.count("falsifier") == 2
    assert "debater" not in c                      # no factual conflict, nothing broken -> no debate
    assert "method" in c and "evidence" not in c   # physics mode in fast: methodology reviewer only
    assert res["answer"].startswith("### Short answer")


def test_common_and_mode_hint_in_every_role_prompt(script):
    run()
    for r, systems in script["systems"].items():
        for sys_text in systems:
            assert sys_text.startswith(RP.COMMON.split("\n")[0]), r
            assert RP.MODE_HINTS["physics"] in sys_text, r
    assert "READER PROFILE" in script["systems"]["judge"][0]        # writers get the learner profile
    assert "READER PROFILE" not in script["systems"]["falsifier"][0]  # checkers do not


def test_research_uses_architect_queries_and_sources_reach_roles(script):
    res = run()
    assert script["queries"] == [["escape velocity", "gravitational potential energy"]]
    assert "<sources>" in script["users"]["theorist"][0] and "[S1]" in script["users"]["judge"][0]
    assert "SOURCES:" in script["systems"]["judge"][0]
    assert res["sources"][0]["n"] == 1


def test_adapter_shows_cited_sources_mode_and_notes(script):
    out = asyncio.run(chat_adapter.handle({"text": "Escape velocity derive karo", "mode": "physics"}))
    r = out[0]
    assert "**Sources**" in r["text"] and "https://en.wikipedia.org/wiki/Escape_velocity" in r["text"]
    assert "Gravity" not in r["text"].split("**Sources**")[1]       # S2 not cited -> not under the answer
    assert any("11-role council" in s for s in r["steps"]) and any("Confidence" in s for s in r["steps"])
    titles = [i["title"] for i in r["notes"]["items"]]
    assert "Skeptic ke shak" in titles and any("use nahi hue" in t for t in titles)
    assert r["council"]["roles"]["plan"].startswith("GOAL")


def test_ui_mode_v_and_coding_format(script):
    run(mode="v")
    assert RP.MODE_HINTS["verified"] in script["systems"]["judge"][0]
    script["judge"] = [CODE_GOOD]
    script["refiner"] = "nothing"
    res = run(q="Write a function that returns x", mode="coding")
    assert "### Solution (code)" in script["systems"]["judge"][-1]
    assert res["style"] == "roles:coding" and "### Solution (code)" in res["answer"]


# ------------------------------------------------------------------ debate / review / repair

def test_debate_runs_on_factual_conflict_and_stops_when_resolved(script):
    script["map"]["conflicts"] = [{"issue": "value", "kind": "factual", "positions": {"A": "11.2", "B": "7.9"}}]
    run()
    assert script["calls"].count("debater") == 2  # round 1 had 'partly' -> round 2
    assert "round 2" in script["systems"]["debater"][1]
    script["calls"].clear()
    script["debater"] = ["REPLY:\n 1. holds\nAFTER THIS ROUND: keep"]
    run()
    assert script["calls"].count("debater") == 1


def test_choice_conflict_alone_does_not_trigger_debate(script):
    script["map"]["conflicts"] = [{"issue": "colour", "kind": "choice", "positions": {"A": "red", "B": "blue"}}]
    run(deep=False)
    assert "debater" not in script["calls"]


def test_broken_claim_triggers_debate(script):
    script["falsifier"] = "CLAIM: x\nATTACK: y\nRESULT: BROKEN\nIF BROKEN: z"
    run(deep=False)
    assert "debater" in script["calls"]


def test_missing_section_is_repaired_before_review(script):
    script["judge"] = ["### Short answer\nonly this", GOOD]
    res = run()
    assert "repair" in script["calls"] and res["repairs"] >= 1
    assert "### Explanation" in res["answer"]


def test_refiner_that_drops_sections_is_discarded(script):
    script["refiner"] = "REVISED:\n### Short answer\nshort\nCHANGES:\n - cut"
    script["judge"] = [GOOD, GOOD, GOOD]
    res = run()
    assert "it always works everywhere" in res["answer"]
    assert res["council"]["audit"].get("discarded") and not res["audit"]["applied"]
    assert res["audit"]["unsure"]  # the lost fix is still shown to the user as a doubt


def test_low_confidence_or_unquoted_issue_is_not_applied(script):
    script["evidence"] = json.dumps({"issues": [{"quote": "text that is not in the answer", "problem": "p", "fix": "f",
                                                 "confidence": "high"}]})
    res = run()
    assert "refiner" not in script["calls"]
    assert res["audit"]["unsure"] and res["audit"]["unsure"][0]["confidence"] == "low"


def test_method_fix_lines_become_issues():
    out = roles.parse_method("VERDICT: FIX\nCHECKS:\n - step 2 | problem: sign wrong | fix: use minus | severity: high")
    assert out["verdict"] == "FIX" and out["issues"][0]["confidence"] == "high" and out["issues"][0]["fix"] == "use minus"
    assert roles.parse_method("PASS\nchecked energy method")["issues"] == []


def test_parse_refiner_blocks():
    rev, ch, sk = roles.parse_refiner("REVISED:\nA\nB\nCHANGES:\n - one\nSKIPPED:\n - none")
    assert rev == "A\nB" and ch == ["one"] and sk == []
    assert roles.parse_refiner("no markers")[0] is None


# ------------------------------------------------------------------ failure paths

def test_all_drafters_fail_judge_still_answers(script):
    from llm import LLMError
    for r in ("theorist", "empiricist", "specialist"):
        script[r] = LLMError("down")
    res = run()
    assert "### Short answer" in res["answer"]
    assert any("Sab drafters fail" in w for w in res["warnings"])
    assert "falsifier" not in script["calls"]


def test_architect_failure_falls_back_to_question_for_search(script):
    from llm import LLMError
    script["architect"] = LLMError("down")
    run(q="What is escape velocity")
    assert script["queries"] == [["What is escape velocity"]]
    assert "Architect failed" in script["users"]["theorist"][0]


def test_research_off_means_no_sources_rule(script, monkeypatch):
    monkeypatch.setattr(config, "RESEARCH_ENABLED", False)
    res = run()
    assert script["queries"] == [] and "sources" not in res
    assert "SOURCES:" not in script["systems"]["judge"][0]


def test_hybrid_user_answers_join_the_drafts(script):
    res = run(source="hybrid", answers=[{"source": "ChatGPT", "text": "v = 11.2 km/s"}])
    assert res["user_answers_used"] == 1 and "ChatGPT" in res["council"]["drafts"][0]["name"] or any(
        d["name"] == "ChatGPT" for d in res["council"]["drafts"])


def test_manual_mode_still_uses_master(script, monkeypatch):
    monkeypatch.setattr(config, "MASTER_ENABLED", True)
    res = run(source="manual", answers=[{"source": "A", "text": "x"}])
    assert res["engine"] == "master" and "architect" not in script["calls"]


# ------------------------------------------------------------------ helpers

def test_queries_from_plan():
    assert research.queries_from_plan("GOAL: x\nSEARCH: a b || c d", "q") == ["a b", "c d"]
    assert research.queries_from_plan("SEARCH: NONE", "q") == []
    assert research.queries_from_plan(None, "kya hai x?\n\n[Earlier in this chat, context only]\nUser: y") == ["kya hai x?"]


def test_bad_citations_removed_and_sourced_freshness_allowed():
    assert roles.strip_bad_cites("a [S1] b [S9]", SOURCES) == "a [S1] b"
    assert not verified.freshness_warning("The latest version is 3.4.1 [S1].")
    assert verified.freshness_warning("The latest version is 3.4.1 today.")


def test_resolve_mode():
    assert roles.resolve_mode("v", "general") == "verified"
    assert roles.resolve_mode("standard", "math") == "standard"
    assert roles.resolve_mode(None, "general") == "standard"
    assert roles.resolve_mode("coding", "math") == "coding"


def test_role_chains_are_valid():
    assert config.PLAN_PROBLEMS == []
    names = [n for n, _ in config.all_roles()]
    assert "roles:architect" in names and "roles:specialist:coding" in names


def test_all_eleven_roles_present():
    assert set(RP.ROLE_PROMPTS) == {"skeptic", "architect", "empiricist", "theorist", "debater", "refiner",
                                    "method_reviewer", "evidence_reviewer", "pattern_finder", "falsifier", "judge"}


def test_research_gather_real_function_fails_soft(monkeypatch):
    """The real gather (not faked): every lookup errors -> empty list, no exception."""
    import httpx

    class Boom:
        async def get(self, *a, **k):
            raise httpx.ConnectError("offline")

        async def post(self, *a, **k):
            raise httpx.ConnectError("offline")

    monkeypatch.setattr(config, "RESEARCH_ENABLED", True)
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    assert asyncio.run(research.gather(Boom(), ["x"])) == []


def test_android_key_list_has_tavily():
    assert "TAVILY_API_KEY" in android_entry.KEY_NAMES and "TAVILY_API_KEY" in config.SECRET_ENVS


# ------------------------------------------------------------------ quota saving
def test_tight_quota_turns_deep_into_fast(script):
    script["pressure"], script["left"] = "tight", 0.3
    script["map"]["conflicts"] = [{"issue": "value", "kind": "factual", "positions": {"A": "11.2", "B": "7.9"}}]
    res = run()
    c = script["calls"]
    assert "specialist" not in c and "pattern" not in c
    assert c.count("falsifier") == 2 and c.count("debater") == 1
    assert res["quota"]["level"] == "tight" and res["quota"]["saved"]
    assert any("Quota kam" in w for w in res["warnings"])


def test_low_quota_keeps_only_what_the_answer_needs(script):
    script["pressure"], script["left"] = "low", 0.1
    script["map"]["conflicts"] = [{"issue": "value", "kind": "factual", "positions": {"A": "11.2", "B": "7.9"}}]
    res = run()
    c = script["calls"]
    for r in ("debater", "method", "evidence", "refiner", "specialist"):
        assert r not in c, r
    assert "judge" in c and "architect" in c
    assert res["council"]["roles"]["debate_skipped"] == "quota bachane ke liye band"


def test_ok_quota_changes_nothing(script):
    res = run()
    assert "specialist" in script["calls"] and not res.get("quota", {}).get("saved")
