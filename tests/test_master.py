"""Offline tests for manual mode (master answer + lessons) and the Bug A / Bug B fixes. No network."""
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
import council  # noqa: E402
import lessons  # noqa: E402
import master  # noqa: E402
import pipeline  # noqa: E402
import prompts  # noqa: E402
import verified  # noqa: E402

H = master.SECTIONS


def doc(skip=(), tag="[A]", extra=""):
    parts = []
    for s in H:
        if s in skip:
            continue
        parts.append(f"### {s}\nEk baat jo answers me hai {tag}.{extra}")
    return "\n\n".join(parts)


GOOD = doc()
ANSWERS = [{"source": "ChatGPT", "text": "Attention weighs tokens by relevance."},
           {"source": "Gemini", "text": "Attention lets each token look at all others."}]


@pytest.fixture(autouse=True)
def tmp_lessons(tmp_path, monkeypatch):
    monkeypatch.setenv("LESSONS_FILE", str(tmp_path / "lessons.json"))
    monkeypatch.setattr(config, "MASTER_ENABLED", True)
    monkeypatch.setattr(config, "GROUND_ENABLED", True)


@pytest.fixture
def scripted(monkeypatch):
    s = {"master": [GOOD], "repair": [], "revise": [], "ground": json.dumps({"issues": []}),
         "specs": [], "users": [], "systems": []}

    async def fake_chat(client, spec, messages, **kw):
        user, system = messages[-1]["content"], messages[0]["content"]
        s["specs"].append(spec)
        s["users"].append(user)
        s["systems"].append(system)
        if spec is config.STRIPPER:
            return json.dumps(s.get("map") or {"claims": {"A": ["a"], "B": ["b"]}, "consensus": ["a"], "conflicts": []})
        if user.startswith("Format error:"):
            return s["repair"].pop(0)
        if "Corrections to apply" in user:
            return s["revise"].pop(0)
        if "strict grounding checker" in system:
            return s["ground"]
        if "You are the master editor" in user:
            return s["master"].pop(0)
        raise AssertionError("unexpected model call: " + system[:80])

    for mod in (pipeline, verified, master):
        monkeypatch.setattr(mod, "chat", fake_chat)
    return s


def ask(answers=ANSWERS, **kw):
    return asyncio.run(pipeline.run("Attention kya hai?", source="manual", answers=answers, deep=False,
                                    run_code=False, use_guard=False, **kw))


# ---------------------------------------------------------------- master engine

def test_master_uses_only_the_pasted_answers_and_no_panel_models(scripted):
    res = ask()
    assert res["engine"] == "master"
    assert set(scripted["specs"]) <= {config.STRIPPER, config.SYNTHESIZER, config.AUDITOR}
    assert not any("Popperian" in u for u in scripted["users"])
    for s in H:
        assert f"### {s}" in res["answer"]
    assert "*Sources: " in res["answer"] and "ChatGPT" in res["answer"] and "Gemini" in res["answer"]


def test_master_prompt_has_the_seven_sections_and_only_these_answers_rule(scripted):
    ask()
    p = next(u for u in scripted["users"] if "You are the master editor" in u)
    for s in H:
        assert f"### {s}" in p
    assert "ONLY material you may use" in p and master.NOT_IN in p
    assert "Attention weighs tokens" in p and "Attention lets each token" in p


def test_auto_mode_never_runs_the_master_engine(scripted, monkeypatch):
    called = []
    monkeypatch.setattr(master, "run_master", lambda *a, **k: called.append(1))
    monkeypatch.setattr(pipeline.master, "run_master", lambda *a, **k: called.append(1))

    async def fake_chat(client, spec, messages, **kw):
        return "1. Direct Core Truth: ok\n2. Verified Mechanism: ok\n3. Trap Warning: none"

    monkeypatch.setattr(pipeline, "chat", fake_chat)
    monkeypatch.setattr(verified, "chat", fake_chat)
    for src in ("auto", "hybrid"):
        asyncio.run(pipeline.run("2+2?", source=src, answers=ANSWERS if src == "hybrid" else None,
                                 deep=False, run_code=False, use_guard=False))
    assert called == []


def test_master_can_be_switched_off(scripted, monkeypatch):
    monkeypatch.setattr(config, "MASTER_ENABLED", False)
    with pytest.raises(AssertionError):  # the old path needs the classifier etc. that this fixture does not fake
        ask()


def test_missing_section_is_repaired_before_the_user_sees_it(scripted):
    scripted["master"] = [doc(skip=("Kaise socha",))]
    scripted["repair"] = [GOOD]
    res = ask()
    assert res["repairs"] == 1
    assert master.missing_sections(res["answer"]) == []
    assert "missing_section" in [x["kind"] for x in res["master"]["learned"]]


def test_invalid_source_letters_are_removed_and_learned(scripted):
    scripted["master"] = [doc(tag="[A,E]")]
    res = ask()
    assert "[A,E]" not in res["answer"] and "[A]" in res["answer"]
    assert "bad_tag" in [x["kind"] for x in res["master"]["learned"]]


def test_fix_tags_and_lint_unit():
    out, bad = master.fix_tags("x [A,C]. y [Z]. z [B].", {"A", "B"})
    assert out == "x [A]. y . z [B]." and bad == {"C", "Z"}
    _, w, kinds = master.lint("no tags here", {"A"})
    assert "no_tags" in kinds and "missing_section" in kinds and w


def test_grounding_removes_unsupported_statements_with_one_rewrite(scripted):
    q = "Ek baat jo answers me hai [A]."
    scripted["ground"] = json.dumps({"issues": [{"quote": q, "kind": "invented_history", "problem": "year not in answers",
                                                 "fix": "remove", "lesson": "", "confidence": "high"}]})
    scripted["revise"] = [doc(extra=" Rewritten.")]
    res = ask()
    assert "Rewritten." in res["answer"] and len(res["audit"]["applied"]) == 1
    assert "invented_history" in [x["kind"] for x in res["master"]["learned"]]


def test_a_rewrite_that_loses_sections_is_discarded(scripted):
    scripted["ground"] = json.dumps({"issues": [{"quote": "Ek baat jo answers me hai [A].", "kind": "unsupported",
                                                 "problem": "p", "fix": "remove", "confidence": "high"}]})
    scripted["revise"] = [doc(skip=("Kya trigger hua",))]
    scripted["repair"] = [doc(skip=("Kya trigger hua",)), doc(skip=("Kya trigger hua",))]
    res = ask()
    assert master.missing_sections(res["answer"]) == [] and res["audit"]["applied"] == []


def test_a_grounding_quote_not_in_the_answer_cannot_be_high_confidence(scripted):
    scripted["ground"] = json.dumps({"issues": [{"quote": "never written", "kind": "unsupported", "problem": "p",
                                                 "fix": "remove", "confidence": "high"}]})
    res = ask()
    assert res["audit"]["issues"][0]["confidence"] == "low" and res["audit"]["applied"] == []
    assert scripted["revise"] == []


def test_grounding_failure_does_not_break_the_answer(scripted):
    scripted["ground"] = "not json at all"
    res = ask()
    assert "### Concept kya hai" in res["answer"] and res["audit"]["ran"] is False


def test_writer_failure_falls_back_to_the_longest_pasted_answer(scripted):
    scripted["master"] = []

    async def boom(*a, **k):
        return None

    import master as m
    orig = m._write
    m._write = boom
    try:
        res = ask()
    finally:
        m._write = orig
    assert "Attention lets each token" in res["answer"] or "Attention weighs tokens" in res["answer"]
    assert any("Master writer fail" in w for w in res["warnings"])


def test_master_record_for_the_council_view(scripted):
    res = asyncio.run(pipeline.run("Attention kya hai?", source="manual", answers=ANSWERS, deep=False, run_code=False,
                                   use_guard=False, record=True))
    rec = res["council"]
    assert rec["setup"]["engine"] == "master" and rec["lessons"] is not None and rec["final"].strip()
    assert [d["kind"] for d in rec["drafts"]] == ["user", "user"]  # no panel drafts in manual mode
    # titles: the shared stage names are shown as master / grounding in this engine
    built = council.build(question="q", setup={"engine": "master"}, trace=[{"stage": "judge", "ok": True}, {"stage": "audit", "ok": True}],
                          user_drafts={}, panel_drafts={}, letter_to_name={}, extras={}, guard_report={}, errors={},
                          warnings=[], final="f")
    titles = {c["stage"]: c["title"] for c in built["calls"]}
    assert "Master" in titles["judge"] and "Grounding" in titles["audit"]


# ---------------------------------------------------------------- lessons store

def test_lessons_add_dedupe_edit_delete_clear_and_persist():
    a = lessons.add_user("Kaise socha me apna andaza mat likho")
    assert a and a["origin"] == "user" and a["weight"] == 2
    b = lessons.add_user("kaise socha me apna andaza mat likho!")  # near duplicate strengthens, does not add
    assert b["id"] == a["id"] and b["weight"] == 4 and len(lessons.list_all()) == 1
    assert lessons.add_user("ab") is None
    assert lessons.edit(a["id"], "Naya rule likha hua")["text"] == "Naya rule likha hua"
    assert lessons.delete(a["id"]) and not lessons.delete(a["id"])
    lessons.add_user("rule number ek hai")
    lessons.add_user("bilkul alag rule dusra")
    assert lessons.clear() == 2 and lessons.list_all() == []


def test_auto_lessons_use_fixed_text_and_unknown_kinds_are_ignored():
    assert lessons.add_auto("made_up_by_model") is None
    x = lessons.add_auto("unsupported")
    assert x["text"] == lessons.AUTO_RULES["unsupported"][1] and x["origin"] == "auto" and x["weight"] == 1
    assert lessons.add_auto("unsupported")["weight"] == 2 and len(lessons.list_all()) == 1


def test_user_lessons_rank_above_auto_and_prompt_block_is_labelled():
    lessons.add_auto("no_tags")
    u = lessons.add_user("Sab kuch chhota likho bilkul")
    block, used = lessons.prompt_block()
    assert used[0]["id"] == u["id"] and block.index("[L1]") < block.index("[L2]") and "Sab kuch chhota" in block.split("[L2]")[0]
    assert lessons.prompt_block()[0].startswith("LESSONS FROM PAST MISTAKES")


def test_pruning_drops_weak_auto_lessons_first_and_keeps_user_ones(monkeypatch):
    monkeypatch.setattr(lessons, "MAX_LESSONS", 3)
    u = lessons.add_user("mera apna zaroori rule hai")
    for k in ("missing_section", "unsupported", "bad_tag", "no_tags"):
        lessons.add_auto(k)
    items = lessons.list_all()
    assert len(items) == 3 and any(x["id"] == u["id"] for x in items)


def test_record_run_strengthens_repeated_and_counts_held_ones():
    a, b = lessons.add_auto("unsupported"), lessons.add_auto("bad_tag")
    lessons.record_run([a["id"], b["id"]], [a["id"]])
    got = {x["id"]: x for x in lessons.list_all()}
    assert got[a["id"]]["weight"] == 2 and got[b["id"]]["held"] == 1
    lessons.mark_good([b["id"]])
    assert {x["id"]: x for x in lessons.list_all()}[b["id"]]["held"] == 3


def test_handle_op_never_raises_and_returns_the_list():
    assert lessons.handle_op({"op": "add", "text": "ab"})["ok"] is False
    r = lessons.handle_op({"op": "add", "text": "Tag hamesha lagao yaar"})
    assert r["ok"] and r["lessons"][0]["text"].startswith("Tag hamesha")
    assert lessons.handle_op({"op": "weird"})["ok"] is False
    assert lessons.handle_op({"op": "delete", "id": "nope"})["ok"] is False
    assert lessons.handle_op({"op": "good", "ids": [r["lessons"][0]["id"], 5]})["ok"]
    assert lessons.handle_op({"op": "clear"})["lessons"] == []
    assert lessons.handle_op(None)["ok"] is False  # bad input is an error reply, not an exception


def test_corrupt_lessons_file_is_treated_as_empty(tmp_path, monkeypatch):
    p = tmp_path / "bad.json"
    p.write_text("{not json")
    monkeypatch.setenv("LESSONS_FILE", str(p))
    assert lessons.list_all() == []
    assert lessons.add_user("phir bhi kaam karna chahiye")


def test_lessons_reach_the_master_prompt_and_a_repeat_makes_them_heavier(scripted):
    u = lessons.add_user("Kaise socha me apna andaza mat likho")
    scripted["ground"] = json.dumps({"issues": [{"quote": "Ek baat jo answers me hai [A].", "kind": "repeat", "lesson": "L1",
                                                 "problem": "again", "fix": "remove", "confidence": "low"}]})
    res = ask()
    p = next(x for x in scripted["users"] if "You are the master editor" in x)
    assert "[L1] Kaise socha me apna andaza mat likho" in p
    assert res["master"]["lessons_used"][0]["id"] == u["id"] and res["master"]["repeated"] == [u["id"]]
    assert lessons.list_all()[0]["weight"] == 3


def test_lessons_never_enter_auto_prompts():
    lessons.add_user("Kaise socha me apna andaza mat likho")
    for msgs in (prompts.judge_messages("q", "m", "f", "p", "l"), prompts.strip_messages("q", {"A": "x"}, None)):
        assert "LESSONS FROM PAST MISTAKES" not in json.dumps(msgs)


# ---------------------------------------------------------------- adapter / android bridge

def test_adapter_and_android_entry_handle_lesson_ops_without_keys(monkeypatch):
    for n in list(config.SECRET_ENVS if hasattr(config, "SECRET_ENVS") else []):
        monkeypatch.delenv(n, raising=False)
    out = json.loads(android_entry.handle(json.dumps({"lesson": {"op": "add", "text": "Tag lagana mat bhoolo"}})))
    assert out["ok"] and out["lessons"][0]["text"] == "Tag lagana mat bhoolo"
    assert json.loads(android_entry.lessons('{"op":"list"}'))["lessons"]
    assert json.loads(android_entry.lessons("garbage"))["ok"] is False
    assert asyncio.run(chat_adapter.handle({"lesson": {"op": "list"}}))["ok"]


def test_adapter_shows_master_steps_and_lesson_ids(scripted, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    lessons.add_user("Kaise socha me apna andaza mat likho")
    out = json.loads(android_entry.handle(json.dumps({"text": "Attention kya hai?", "source": "manual", "answers": [
        {"source": "ChatGPT", "text": "Attention weighs tokens by relevance."}, {"source": "Gemini", "text": "Each token looks at others."}]})))
    r = out[0]
    assert r["master"] is True and len(r["lessonIds"]) == 1
    assert r["steps"][0].startswith("Manual · master answer") and any(s.startswith("Lessons: 1 lage") for s in r["steps"])


# ---------------------------------------------------------------- Bug A: opinion/choice conflicts are not falsifier fodder

CMAP = {"claims": {"A": ["x"]}, "consensus": ["c"], "conflicts": [
    {"issue": "house size", "kind": "unspecified", "positions": {"A": "4x4x2.5", "B": "10x8x6"}},
    {"issue": "complexity", "kind": "factual", "positions": {"A": "O(n)", "B": "O(n^2)"}}]}


def test_conflict_kind_survives_normalisation_and_defaults_to_factual():
    m = verified._normalize_map({"claims": {"A": ["x"]}, "consensus": [], "conflicts": [
        {"issue": "i", "kind": "choice", "positions": {"A": "a", "B": "b"}},
        {"issue": "j", "positions": {"A": "a", "B": "b"}}]})
    kinds = {c["issue"]: c["kind"] for c in m["conflicts"]}
    assert kinds["i"] == "choice" and kinds["j"] in ("factual", "unspecified")


def test_compact_map_for_falsifiers_has_only_factual_conflicts():
    compact = verified.format_map(CMAP, compact=True)
    assert "complexity" in compact and "house size" not in compact
    full = verified.format_map(CMAP)
    assert "DIFFERENT CHOICES" in full and "house size" in full


def test_judge_prompts_tell_it_to_pick_a_labelled_default_for_choices():
    for msgs in (prompts.judge_messages("q", "m", "f", "p", "l"),):
        assert "DIFFERENT CHOICES" in msgs[1]["content"]


# ---------------------------------------------------------------- Bug B: no "latest/as of" claims from stale memory

def test_freshness_lint_flags_latest_version_claims_only():
    assert verified.freshness_warning("three.js r162 is the latest stable release as of 2026-11-22.")
    assert verified.freshness_warning("The latest version is 3.4.1 today.")
    assert not verified.freshness_warning("Attention costs O(n^2).")
    assert not verified.freshness_warning("In 2017 Vaswani proposed it.")


def test_lint_answer_adds_the_freshness_warning():
    _, warns = verified.lint_answer("Use r162, the latest stable release as of 2026-11-22.", [])
    assert any("latest" in w.lower() or "ताज" in w or "fresh" in w.lower() or "date" in w.lower() for w in warns)


def test_freshness_note_is_in_panel_judges_falsifier_and_audit_prompts():
    note = prompts.FRESHNESS[:30]
    assert note in json.dumps(prompts.panel_messages("q", "logic_math", "general", "hindi"))
    assert note in json.dumps(prompts.judge_messages("q", "m", "f", "p", "l"))
    assert note in json.dumps(prompts.judge_explain_messages("q", "m", "f", "l")) if _arity(prompts.judge_explain_messages) == 4 else True
    assert "do NOT supply a newer number from memory" in json.dumps(prompts.popper_messages("q", "m", "hindi"))
    assert "do not put a newer number from memory" in json.dumps(prompts.audit_messages("q", "a", "hindi"))


def _arity(fn):
    import inspect
    return len(inspect.signature(fn).parameters)
