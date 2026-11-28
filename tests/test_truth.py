"""Change 1.4: hallucination controls (truth.py), the Standard fact-check call and the API usage report (health.report)."""
import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# same quota file as tests/test_quota.py: health.py binds USAGE_FILE when it is first imported
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")

import android_entry  # noqa: E402
import chat_adapter  # noqa: E402
import config  # noqa: E402
import health  # noqa: E402
import pipeline  # noqa: E402
import standard_agent  # noqa: E402
import truth  # noqa: E402

ANSWER = ("Chandrayaan-3 ne 23 August 2023 ko Moon ke south pole ke paas landing ki. ISRO ka lander Vikram tha "
          "aur rover Pragyan. Mission ka budget lagbhag 615 crore rupaye tha, jo duniya ke sabse saste missions mein hai.")
CLAIMS = {"claims": [
    {"c": "Landing 23 August 2023 ko hui", "v": "ok", "why": "E1 mein yahi date", "fix": "kuch nahi", "refs": ["E1"]},
    {"c": "Budget 615 crore", "v": "unverifiable", "why": "evidence mein budget nahi", "fix": "ISRO report dekho"},
    {"c": "Rover ka naam Vikram", "v": "wrong", "why": "Vikram lander hai", "fix": "Rover Pragyan hai", "refs": ["E1"], "fix_refs": ["E1"]},
    {"c": "", "v": "ok"},
    {"c": "Opinion", "v": "maybe"},
]}


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    for n in ("GROQ_API_KEY", "GROQ_API_KEY_2", "GROQ_API_KEY_3"):
        monkeypatch.delenv(n, raising=False)
    health.reset(clear_usage=True)
    yield
    health.reset(clear_usage=True)


class Calls(list):
    out: dict


@pytest.fixture
def std(monkeypatch):
    calls = Calls()
    out = {"text": ANSWER, "evidence": [{"title": "Wikipedia: Chandrayaan-3", "url": "https://en.wikipedia.org/wiki/C3",
                                         "text": "Chandrayaan-3 landed on 23 August 2023 near the lunar south pole. Vikram was the lander and Pragyan the rover."}]}

    async def fake(messages, **kw):
        calls.append((messages, kw))
        return {"text": out["text"], "used": "gpt-oss-120b", "searches": 0, "wiki": ["Chandrayaan-3"],
                "sources": [], "evidence": out["evidence"], "secs": 0.1}

    async def boom(*a, **k):
        raise AssertionError("the council pipeline must not run for Standard")

    monkeypatch.setattr(chat_adapter.standard_agent, "answer", fake)
    monkeypatch.setattr(pipeline, "run", boom)
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", True)
    calls.out = out
    return calls


class Checks(list):
    pass


@pytest.fixture
def fact(monkeypatch):
    seen = Checks()

    async def fake_check(question, answer, evidence=None, reply_hint=""):
        seen.append({"q": question, "a": answer, "e": evidence})
        return truth.clean(CLAIMS, "sources" if evidence else "model", evidence=evidence, question=question, answer=answer)

    monkeypatch.setattr(truth, "check", fake_check)
    return seen


def body(text="Chandrayaan-3 kab land hua?", **kw):
    b = {"text": text, "mode": "standard", "learn": {"checks": False, "known": []}}
    b.update(kw)
    return b


# ------------------------------------------------------------------ options / rules / heuristics
def test_options_default_to_balanced_and_no_extra_call():
    assert truth.options({}) == {"level": "balanced", "check": "off"}
    assert truth.options({"truth": {"level": "x", "check": "never"}}) == {"level": "balanced", "check": "off"}
    assert truth.options({"truth": {"level": "strict", "check": "always"}}) == {"level": "strict", "check": "always"}
    assert truth.temperature({"level": "strict"}) == 0.2 and truth.temperature({"level": "creative"}) == 0.8
    assert truth.temperature({}) == 0.5


def test_rules_per_level_and_web_switch():
    strict = truth.rules("strict", True)
    assert "HALLUCINATION CONTROL" in strict and "STRICT" in strict and "web search or Wikipedia" in strict
    assert "never invent" in strict and "pakka nahi pata" in strict
    assert "web search is off" in truth.rules("balanced", False)
    assert "[SPECULATION]" in truth.rules("creative") and "STRICT" not in truth.rules("creative")


def test_risky_needs_facts_and_some_length():
    assert truth.risky(ANSWER)
    assert not truth.risky("Inertia matlab cheez apni haalat nahi badalna chahti. 1990")  # too short to bother
    calm = "Socho ek gaadi chal rahi hai aur achanak brake lagti hai. Tumhara shareer aage jhukta hai kyunki wo chalta rehna chahta hai. " * 2
    assert not truth.risky(calm)


def test_should_check_modes():
    assert truth.should_check({"check": "always"}, "short answer")
    assert not truth.should_check({"check": "always"}, "answer", voice=True)
    assert truth.should_check({"check": "auto"}, ANSWER)
    assert not truth.should_check({"check": "auto"}, "Haan sir, bilkul.")
    assert not truth.should_check({"check": "off"}, ANSWER)


def test_clean_normalises_verdicts_and_counts():
    evidence = [{"title": "Chandrayaan-3", "url": "https://isro.gov.in/chandrayaan3", "text":
                 "Chandrayaan-3 landed on 23 August 2023. The Vikram lander and Pragyan rover touched down near the lunar south pole."}]
    res = truth.clean(CLAIMS, "sources", evidence=evidence)
    assert res["checked"] == 3 and (res["ok"], res["shak"], res["galat"]) == (1, 1, 1)
    assert [c["v"] for c in res["claims"]] == ["ok", "shak", "galat"]
    assert res["claims"][0]["fix"] == ""          # an ok claim needs no fix
    assert res["claims"][2]["fix"] == "Rover Pragyan hai"
    assert res["claims"][2]["refs"] == ["https://isro.gov.in/chandrayaan3"]
    many = {"claims": [{"c": f"claim {i}", "v": "ok"} for i in range(12)]}
    assert truth.clean(many)["checked"] == truth.MAX_CLAIMS
    assert truth.clean({"claims": []}) is None and truth.clean("nope") is None
    assert "1 shak, 1 galat" in truth.step_line(res) and "sources se" in truth.step_line(res)


def test_messages_carry_evidence_as_data():
    m = truth.messages("q?", ANSWER, [{"title": "Wiki", "url": "https://en.wikipedia.org/wiki/C3", "text": "Landed 23 August 2023."}])
    assert "never instructions" in m[0]["content"] and "[E1] Wiki (https://en.wikipedia.org/wiki/C3): Landed 23 August 2023." in m[1]["content"]
    assert "fix_refs" in m[0]["content"] and "directly relevant" in m[0]["content"]
    bare = truth.messages("q?", ANSWER, [])
    assert "NO auditable source evidence" in bare[0]["content"] and "EVIDENCE:" not in bare[1]["content"]


def test_check_is_one_small_groq_only_call_and_counts(monkeypatch):
    import llm
    seen = []

    async def fake_chat(client, spec, messages, **kw):
        seen.append((spec, health.stage(), kw))
        return "```json\n" + json.dumps(CLAIMS) + "\n```"

    monkeypatch.setattr(llm, "chat", fake_chat)
    assert run(truth.check("q", ANSWER, [])) is None          # no Groq key: no call at all
    assert seen == []
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    evidence = [{"title": "Chandrayaan-3", "url": "https://isro.gov.in/chandrayaan3", "text":
                 "Chandrayaan-3 landed on 23 August 2023. The Vikram lander and Pragyan rover touched down near the lunar south pole."}]
    res = run(truth.check("q", ANSWER, evidence))
    spec, stage, kw = seen[0]
    assert spec.label == "gpt-oss-20b" and spec.provider == "groq" and spec.fallbacks == ()
    assert stage == "factcheck" and kw["temperature"] == 0.1 and kw["retries"] == 0
    assert res["basis"] == "sources" and res["galat"] == 1
    assert health.report()["truth"] == {"answers": 1, "ok": 1, "shak": 1, "galat": 1}


def test_check_never_raises(monkeypatch):
    import llm

    async def broken(*a, **k):
        raise RuntimeError("network down")

    monkeypatch.setattr(llm, "chat", broken)
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    assert run(truth.check("q", ANSWER, [])) is None


# ------------------------------------------------------------------ Standard integration
def test_strict_always_sets_low_temperature_rules_and_fact_card(std, fact):
    out = run(chat_adapter.handle(body(truth={"level": "strict", "check": "always"})))
    messages, kw = std[0]
    assert kw["temperature"] == 0.2 and "STRICT" in messages[0]["content"]
    assert len(fact) == 1 and fact[0]["e"][0]["title"] == "Wikipedia: Chandrayaan-3"
    assert "Chandrayaan-3" in fact[0]["a"] and "**Sources**" not in fact[0]["a"]
    rep = out[0]
    assert rep["truth"]["level"] == "strict" and rep["truth"]["galat"] == 1
    assert any(s.startswith("Fact-check (sources se): 3 claims") for s in rep["steps"])


def test_auto_skips_plain_answers_and_off_never_calls(std, fact):
    std.out["text"] = "Haan sir, bilkul sahi socha."
    run(chat_adapter.handle(body(truth={"level": "balanced", "check": "auto"})))
    std.out["text"] = ANSWER
    run(chat_adapter.handle(body(truth={"level": "creative", "check": "off"})))
    assert fact == [] and std[1][1]["temperature"] == 0.8


def test_old_request_without_truth_keeps_old_temperature_and_no_check(std, fact):
    out = run(chat_adapter.handle(body()))
    assert std[0][1]["temperature"] == 0.5 and fact == [] and "truth" not in out[0]
    assert "BALANCED" in std[0][0][0]["content"]


def test_answers_about_private_records_are_not_fact_checked(std, fact):
    b = body("Meri padhai ki progress kaisi hai?", truth={"level": "strict", "check": "always"},
             access={"personalOnline": True, "localRead": True},
             app_context={"records": [{"kind": "task", "title": "Calculus chapter 2", "due": "kal"}]})
    run(chat_adapter.handle(b))
    assert fact == [] and std[0][1]["tools"] is False


def test_failed_check_says_so_in_steps(std, monkeypatch):
    async def none(*a, **k):
        return None

    monkeypatch.setattr(truth, "check", none)
    out = run(chat_adapter.handle(body(truth={"level": "balanced", "check": "always"})))
    assert "truth" not in out[0] and any(s.startswith("Fact-check: chala nahi") for s in out[0]["steps"])


def test_low_groq_quota_is_reported_with_the_answer(std, fact):
    health._usage["req"]["groq:openai/gpt-oss-120b"] = int(config.GROQ_RPD * 0.9)
    out = run(chat_adapter.handle(body()))
    assert out[0]["quota"] == {"provider": "groq", "left": 0.1}
    assert any("quota ~10% bacha" in s for s in out[0]["steps"])


def test_council_modes_get_the_rules_in_the_learner_note(monkeypatch):
    seen = {}

    async def fake_run(question, **kw):
        seen.update(kw)
        return {"answer": "Jawab", "engine": "roles", "models_used": {}, "latency_s": 1}

    monkeypatch.setattr(pipeline, "run", fake_run)
    run(chat_adapter.handle({"text": "Torque kya hai?", "mode": "physics", "truth": {"level": "strict"},
                             "learn": {"checks": False, "known": ["Force"]}}))
    assert seen["learner_note"].startswith("HALLUCINATION CONTROL") and "STRICT" in seen["learner_note"]
    assert "Force" in seen["learner_note"]


# ------------------------------------------------------------------ usage report
def test_usage_op_works_without_any_key():
    rep = chat_adapter.local_response({"usage": True})
    assert rep["type"] == "usage" and rep["usage"]["totals"] == {"req": 0, "tok": 0}
    raw = json.loads(android_entry.handle(json.dumps({"usage": True})))
    assert raw["type"] == "usage" and [p["id"] for p in raw["usage"]["providers"]][:1] == ["groq"]


def test_report_rows_per_key_and_model(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one_123456")
    monkeypatch.setenv("GROQ_API_KEY_2", "gsk_two_123456")
    base = config.REGISTRY["gpt-oss-120b"]
    k2 = config.keyed(base, 2)
    health.set_stage("standard")
    health.note_request(k2)
    health.success(k2, 1500)
    health.set_stage("panel:logic_math")
    health.note_request(config.keyed(config.REGISTRY["gpt-oss-20b"], 1))
    health.set_stage("")
    health.reserve_slot(health.quota_key(k2), 25, 7000, 900, 0)
    rep = health.report()
    groq = rep["providers"][0]
    assert groq["id"] == "groq" and groq["set"] == 2 and "alag account" in groq["limits"]
    k1, k2r, k3 = groq["keys"]
    assert [k["state"] for k in groq["keys"]] == ["ok", "ok", "nokey"]
    assert {m["model"] for m in k1["models"]} == {"openai/gpt-oss-120b", "openai/gpt-oss-20b"}  # Standard row always there
    row = k2r["models"][0]
    assert row["model"] == "openai/gpt-oss-120b" and row["req"] == 1 and row["tok"] == 1500
    assert row["req_limit"] == config.GROQ_RPD and row["tok_limit"] == config.GROQ_TPD
    assert row["min_req"] == 1 and row["min_tok"] == 900 and row["rpm"] == config.GROQ_RPM
    assert rep["features"] == {"standard": 1, "council": 1}
    assert rep["totals"] == {"req": 2, "tok": 1500} and rep["standard"]["state"] == "ok"
    assert 0 <= rep["reset_in_s"] <= 86400 and rep["days"][-1]["req"] == 2


def test_daily_429_marks_the_key_out_and_cooldown_marks_cool(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_one_123456")
    monkeypatch.setenv("GROQ_API_KEY_2", "gsk_two_123456")
    base = config.REGISTRY["gpt-oss-120b"]
    health.rate_limited(config.keyed(base, 1), 3600, daily=True)
    health.cooldown_key(config.keyed(base, 2), 600)
    keys = health.report()["providers"][0]["keys"]
    assert keys[0]["state"] == "out" and keys[0]["models"][0]["out_s"] > 3000
    assert keys[1]["state"] == "cool" and keys[1]["cool_s"] > 500


def test_history_survives_the_day_roll_and_a_restart(tmp_path, monkeypatch):
    health._usage["req"]["groq:openai/gpt-oss-120b"] = 40
    health._usage["tok"]["groq:openai/gpt-oss-120b"] = 9000
    health._usage["feat"] = {"standard": 40}
    health._usage["day"] = "2026-11-20"
    health._roll()
    assert health._usage["req"] == {} and health._usage["hist"][-1]["day"] == "2026-11-20"
    days = health.report()["days"]
    assert days[0] == {"day": "2026-11-20", "req": 40, "tok": 9000, "by": {"groq": 40}}
    f = tmp_path / "u.json"
    f.write_text(json.dumps({"day": "2026-11-21", "req": {"gemini:x": 3}, "tok": {}, "hist": [{"day": "2026-11-20", "req": {"groq": 1}}]}))
    monkeypatch.setattr(health, "STATE_FILE", str(f))
    data = health._load()
    assert [h["day"] for h in data["hist"]] == ["2026-11-20", "2026-11-21"] and data["req"] == {}


def test_feature_names():
    assert health.feature("standard") == "standard" and health.feature("casual") == "standard"
    assert health.feature("factcheck") == "factcheck" and health.feature("judge") == "council"
    assert health.feature("debate:x") == "council" and health.feature("") == "other"


# ------------------------------------------------------------------ evidence from the Standard agent
def test_browser_results_keep_a_snippet_and_sources_stay_clean():
    msg = {"executed_tools": [{"search_results": {"results": [
        {"title": "ISRO", "url": "https://isro.gov.in/c3", "content": "Chandrayaan-3   landed on 23 Aug 2023."},
        {"title": "dup", "url": "https://isro.gov.in/c3", "content": "again"},
        {"title": "bad", "url": "http://plain.example"},
    ]}}]}
    n, found = standard_agent._browser_sources(msg)
    assert n == 1 and found[0]["text"] == "Chandrayaan-3 landed on 23 Aug 2023."
    uniq, ev = standard_agent._split_evidence(found)
    assert uniq == [{"title": "ISRO", "url": "https://isro.gov.in/c3"}]
    assert ev == [{"title": "ISRO", "url": "https://isro.gov.in/c3", "text": "Chandrayaan-3 landed on 23 Aug 2023."}]


def test_only_https_urls_inside_news_or_pattern_blocks_are_researched(monkeypatch):
    src = standard_agent.source_research
    monkeypatch.setattr(src, "_safe_url", lambda url: "unsafe" not in url)
    prompt = ("Outside https://ignored.example/story <news>Article: https://reuters.com/a). "
              "Plain HTTP: http://insecure.example/x</news><pattern>Article: https://example.com/b.</pattern>")
    assert src.supplied_news_urls(prompt) == ["https://reuters.com/a", "https://example.com/b"]


def test_current_news_without_relevant_source_cannot_be_ok_or_galat():
    raw = {"claims": [
        {"c": "FCC authorized SpaceX for one million satellites", "v": "ok", "why": "I remember this", "refs": []},
        {"c": "JERA talks with Anthropic and Meta are in India", "v": "galat", "why": "Japan company", "fix": "They are only Japanese domestic talks"},
    ]}
    res = truth.clean(raw, "model", question="<news>Fact-check this current news claim</news>")
    assert res["basis"] == "model" and (res["ok"], res["shak"], res["galat"]) == (0, 2, 0)
    assert all(c["refs"] == [] for c in res["claims"])
    assert all("current claim" in c["why"].lower() for c in res["claims"])
    assert all("reliable" in c["fix"].lower() for c in res["claims"])


def test_volatile_quota_claims_need_relevant_source_refs_and_cannot_invent_explanations():
    question = "Kaggle free GPU quota har hafte reset hota hai kya?"
    answer = ("Kaggle ka free GPU quota weekly reset hota hai. Har hafte ek naya limit milta hai, "
              "jaise 30 GPU-hour per week.")
    assert truth.is_volatile_policy(question, answer)
    raw = {"claims": [
        {"c": "Kaggle ka free GPU quota weekly reset hota hai", "v": "ok",
         "why": "Kaggle documentation states weekly reset", "refs": []},
        {"c": "Har hafte 30 GPU-hour ka limit milta hai", "v": "galat",
         "why": "Exact limit varies by account", "fix": "Check current quota on Kaggle account page", "refs": []},
    ]}
    res = truth.clean(raw, "model", question=question, answer=answer)
    assert (res["ok"], res["shak"], res["galat"], res["basis"]) == (0, 2, 0, "model")
    assert all("quota or service-policy" in c["why"] for c in res["claims"])
    assert all("official documentation" in c["fix"] for c in res["claims"])
    assert "changing service policy, quota" in truth.messages(question, answer, [])[0]["content"]


def test_official_kaggle_evidence_can_support_weekly_quota_claims():
    evidence = [{"title": "Efficient GPU Usage Tips", "url": "https://www.kaggle.com/docs/efficient-gpu-usage",
                 "text": "Kaggle weekly GPU quota resets weekly and is 30 hours or sometimes higher depending on demand and resources."}]
    raw = {"claims": [
        {"c": "Kaggle ka free GPU quota weekly reset hota hai", "v": "ok", "refs": ["E1"]},
        {"c": "Kaggle weekly GPU quota 30 hours or sometimes higher depending on demand and resources hai",
         "v": "ok", "refs": ["E1"]},
    ]}
    res = truth.clean(raw, "sources", evidence=evidence, question="Kaggle GPU quota", answer="Weekly quota 30 hours ya zyada hai.")
    assert (res["ok"], res["shak"], res["basis"]) == (2, 0, "sources")
    assert all(c["refs"] == [evidence[0]["url"]] for c in res["claims"])


def test_irrelevant_news_evidence_does_not_support_verdict_or_correction():
    evidence = [{"title": "Japan business trends", "url": "https://example.com/japan", "text":
                 "Japan business trends and Japanese companies are expanding regional energy infrastructure."}]
    raw = {"claims": [{"c": "JERA talks with Anthropic and Meta are in India", "v": "galat", "refs": ["E1"],
                       "fix": "JERA is Japanese", "fix_refs": ["E1"]}]}
    res = truth.clean(raw, "sources", evidence=evidence, question="<pattern>current news</pattern>")
    assert res["galat"] == 0 and res["shak"] == 1
    assert not res["claims"][0]["refs"] and "needs verification" in res["claims"][0]["why"]


def test_relevant_urls_can_back_news_galat_but_unreferenced_correction_is_removed():
    evidence = [{"title": "FCC authorization for SpaceX", "url": "https://fcc.gov/order", "text":
                 "FCC authorized SpaceX for a constellation of one million satellites; first operational satellite due by 2033."}]
    raw = {"claims": [{"c": "FCC did not authorize SpaceX for one million satellites", "v": "galat", "refs": ["E1"],
                       "fix": "The FCC authorization requires the first satellite by 2033."}]}
    res = truth.clean(raw, "sources", evidence=evidence, question="<news>FCC story</news>")
    assert res["galat"] == 1 and res["claims"][0]["refs"] == ["https://fcc.gov/order"]
    assert res["claims"][0]["fix"] == ""  # a concrete alternative needs its own supporting reference


def test_bounded_arithmetic_preserves_only_locally_checked_equations():
    good = truth.clean({"claims": [{"c": "2 + 2 = 4", "v": "ok"}]}, "model")
    bad = truth.clean({"claims": [{"c": "2 + 2 = 5", "v": "galat", "fix": "4"}]}, "model")
    assert good["ok"] == 1 and "bounded local arithmetic" in good["claims"][0]["why"]
    assert bad["galat"] == 0 and bad["shak"] == 1 and bad["claims"][0]["fix"] == ""


def test_auto_check_is_skipped_when_groq_quota_is_nearly_gone_but_always_still_runs(std, fact):
    health._usage["req"]["groq:openai/gpt-oss-120b"] = int(config.GROQ_RPD * 0.9)   # 10% left
    run(chat_adapter.handle(body(truth={"level": "balanced", "check": "auto"})))
    assert fact == []
    out = run(chat_adapter.handle(body(truth={"level": "balanced", "check": "always"})))
    assert len(fact) == 1 and out[0]["truth"]["checked"] == 3
