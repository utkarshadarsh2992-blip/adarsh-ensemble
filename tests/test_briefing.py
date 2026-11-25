"""Change 1.3: night briefing (one Groq call over sir's own bounded records) and its hidden plan block."""
import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# same quota file as tests/test_quota.py: health.py binds USAGE_FILE when chat_adapter is first imported
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")
import android_entry  # noqa: E402
import briefing  # noqa: E402
import chat_adapter  # noqa: E402
import learning  # noqa: E402
import pipeline  # noqa: E402

PLAN = {"focus": "Robot arm v2 ka gripper", "plan": [
    {"title": "Inertia revise", "time": "07:00", "minutes": 20, "goal": "MIT", "project": ""},
    {"title": "Gripper ka code", "time": "18:30", "minutes": 60, "goal": "", "project": "Robot arm"},
], "memories": [{"text": "Sir ne Inertia ke first law ko revise kiya", "reason": "Kal revision mein kaam aa sakta hai"}]}

CTX = {
    "date": "2026-11-24", "tomorrow": "2026-11-25", "weekday": "Tuesday", "tomorrowDay": "Wednesday", "now": "21:30",
    "mission": "AI/AGI, rockets, robots. Business sirf funding.",
    "goals": [{"title": "Math, science, CS, business, economics samjho; MIT jao", "deadline": "2028-09-01",
               "daysLeft": 647, "progress": 10, "open": ["Calculus basics"], "why": "MIT"}],
    "projects": [{"name": "Robot arm", "version": 2, "status": "active", "built": "servo chal gaya",
                  "learned": "PWM", "next": "gripper", "idleDays": 4, "concepts": ["Torque"], "goal": "MIT"}],
    "today": {"questions": 6, "concepts": ["Inertia", "Torque"], "words": ["jadatva"], "right": 3, "total": 4,
              "weak": [{"concept": "Torque", "q": "Lever lamba ho to?"}], "done": ["Physics padhi"],
              "open": [{"title": "Notes", "due": "kal"}], "work": [{"title": "Robot arm", "minutes": 50}]},
    "fixed": [{"title": "School", "time": "08:00"}],
}


def plan_text(text="**Aaj ka hisaab**\nAaj 6 sawaal.", plan=PLAN):
    return f"{text}\n\n{briefing.PLAN_OPEN}\n{json.dumps(plan, ensure_ascii=False)}\n{briefing.PLAN_CLOSE}"


def run(coro):
    return asyncio.run(coro)


class Calls(list):
    out: dict


@pytest.fixture
def groq(monkeypatch):
    calls = Calls()
    out = {"text": plan_text()}

    async def fake(messages, **kw):
        calls.append((messages, kw))
        return {"text": out["text"], "used": "gpt-oss-120b", "searches": 0, "wiki": [], "sources": [], "secs": 0.2}

    async def boom(*a, **k):
        raise AssertionError("the council pipeline must never run for the briefing")

    monkeypatch.setattr(briefing.standard_agent, "answer", fake)
    monkeypatch.setattr(pipeline, "run", boom)
    calls.out = out
    return calls


# ------------------------------------------------------------------ request side

def test_clean_context_bounds_and_drops_bad_items():
    raw = dict(CTX)
    raw["goals"] = [{"title": "x" * 500, "deadline": "2028-13-99x", "daysLeft": "9"}, "bad", {"title": ""}] * 10
    raw["projects"] = [{"name": "P", "status": "weird", "version": 0, "idleDays": -5}] * 20
    raw["today"] = {"weak": [{"concept": "A"}] * 20, "right": 9, "total": 4, "concepts": ["c"] * 50, "questions": True}
    raw["fixed"] = [{"title": "Gym", "time": "25:99"}, {"title": "Run", "time": "7:05"}]
    ctx = briefing.clean_context(raw)
    assert len(ctx["goals"]) == 3  # only the first 8 entries are read, bad ones dropped
    g = ctx["goals"][0]
    assert len(g["title"]) == 120 and g["deadline"] == "" and g["daysLeft"] is None
    assert len(ctx["projects"]) == briefing.MAX_PROJECTS
    p = ctx["projects"][0]
    assert p["status"] == "active" and p["version"] == 1 and p["idleDays"] == 0
    t = ctx["today"]
    assert len(t["weak"]) == 6 and len(t["concepts"]) == 12 and t["questions"] == 0
    assert t["right"] == 4 and t["total"] == 4  # right can never be more than total
    assert ctx["fixed"] == [{"title": "Gym", "time": ""}, {"title": "Run", "time": "07:05"}]


def test_clean_context_survives_garbage():
    for raw in (None, "x", 5, [], {"today": "x", "goals": "y", "projects": 3}):
        ctx = briefing.clean_context(raw)
        assert ctx["goals"] == [] and ctx["projects"] == [] and ctx["today"]["total"] == 0


def test_context_text_has_the_facts_and_days_left():
    text = briefing.context_text(briefing.clean_context(CTX))
    assert text.startswith("[BRIEFING DATA")
    assert "647 din baaki" in text and "progress 10%" in text
    assert "Robot arm · v2 · active" in text and "4 din se update nahi" in text and "next upgrade: gripper" in text
    assert "3/4 right" in text and 'Torque ("Lever lamba ho to?")' in text
    assert "TOMORROW ALREADY FIXED: 08:00 School." in text
    empty = briefing.context_text(briefing.clean_context({}))
    assert "(koi goal nahi)" in empty and "(koi project nahi)" in empty and "none answered today" in empty


def test_past_deadline_and_missing_deadline_are_said_plainly():
    ctx = briefing.clean_context({"goals": [{"title": "A", "deadline": "2026-01-01", "daysLeft": -5}, {"title": "B"}]})
    text = briefing.context_text(ctx)
    assert "deadline 5 din pehle nikal gayi" in text and "B · deadline set nahi" in text


# ------------------------------------------------------------------ plan block

def test_split_plan_removes_block_and_cleans_items():
    text, plan = briefing.split_plan(plan_text())
    assert briefing.PLAN_OPEN not in text and text.endswith("Aaj 6 sawaal.")
    assert plan["focus"] == "Robot arm v2 ka gripper"
    assert [p["title"] for p in plan["items"]] == ["Inertia revise", "Gripper ka code"]
    assert plan["items"][1] == {"title": "Gripper ka code", "time": "18:30", "minutes": 60, "goal": "", "project": "Robot arm"}
    assert plan["memories"] == [{"text": "Sir ne Inertia ke first law ko revise kiya", "reason": "Kal revision mein kaam aa sakta hai"}]


def test_memory_suggestions_are_optional_unique_and_capped():
    raw = {"memories": [
        {"text": "Torque padhi", "reason": "Project note"},
        {"text": " TORQUE   PADHI! ", "reason": "Duplicate"},
        {"text": "M" * 400, "reason": "R" * 300},
        {"text": "Fourth item"},
        "not an object",
    ]}
    cleaned = briefing.clean_plan(raw)["memories"]
    assert len(cleaned) == briefing.MAX_MEMORY_SUGGESTIONS
    assert cleaned[0]["text"] == "Torque padhi"
    assert len(cleaned[1]["text"]) == 180 and len(cleaned[1]["reason"]) == 120
    assert cleaned[2] == {"text": "Fourth item", "reason": ""}


def test_plan_is_capped_and_bad_times_become_empty():
    many = {"plan": [{"title": f"T{i}", "time": "99:00", "minutes": 9999} for i in range(20)] + [{"title": ""}, "x"]}
    _, plan = briefing.split_plan(plan_text(plan=many))
    assert len(plan["items"]) == briefing.MAX_PLAN
    assert plan["items"][0]["time"] == "" and plan["items"][0]["minutes"] == 600


def test_unclosed_or_broken_plan_block_never_leaks():
    text, plan = briefing.split_plan("Briefing.\n" + briefing.PLAN_OPEN + '\n{"plan": [ broken')
    assert text == "Briefing." and plan == {"focus": "", "items": [], "memories": []}
    text, plan = briefing.split_plan("Sirf text")
    assert text == "Sirf text" and plan["items"] == []


def test_followup_note_marks_private_records():
    note = briefing.followup_note({"followup": True, "goals": CTX["goals"], "projects": CTX["projects"]})
    assert "[Permitted relevant app records;" in note and "Robot arm" in note and len(note) <= 2500
    assert briefing.followup_note({"followup": True}) == ""
    assert briefing.followup_note("x") == ""


# ------------------------------------------------------------------ reply

def test_reply_is_one_groq_call_without_tools(groq):
    out = run(chat_adapter.handle({"text": "Raat ki briefing", "mode": "standard", "briefing": CTX}))
    assert len(groq) == 1
    messages, kw = groq[0]
    assert kw["tools"] is False and kw["web"] is False and kw["max_tokens"] == 3200
    system, user = messages[0]["content"], messages[1]["content"]
    assert "**Kal ka plan**" in system and briefing.PLAN_OPEN in system and "Yaad rakho" in system
    assert "REVISION CHECK" in system  # wrong answers today + checks on
    assert user.startswith("[BRIEFING DATA") and "Sir's note" not in user
    rep = out[0]
    assert rep["type"] == "text" and rep["uiMode"] == "standard" and briefing.PLAN_OPEN not in rep["text"]
    assert rep["briefing"]["date"] == "2026-11-24" and rep["briefing"]["for"] == "2026-11-25"
    assert rep["briefing"]["focus"] and len(rep["briefing"]["plan"]) == 2
    assert rep["briefing"]["memorySuggestions"][0]["text"].startswith("Sir ne Inertia")
    assert "web/Wikipedia off" in rep["steps"][0]


def test_reply_without_weak_concepts_or_with_checks_off_has_no_revision(groq):
    ctx = json.loads(json.dumps(CTX))
    ctx["today"]["weak"] = []
    run(chat_adapter.handle({"text": "x", "briefing": ctx}))
    assert "REVISION CHECK" not in groq[-1][0][0]["content"]
    run(chat_adapter.handle({"text": "x", "briefing": CTX, "learn": {"checks": False}}))
    assert "REVISION CHECK" not in groq[-1][0][0]["content"]


def test_reply_keeps_revision_checks_and_known_words(groq):
    block = {"concept": "Torque", "heavy": False, "questions": [
        {"kind": "fill", "q": "Torque = force x ?", "answer": "distance", "why": "lever arm"}], "words": []}
    body = "**Aaj ka hisaab**\nok\n" + learning.CHECK_OPEN + "\n" + json.dumps(block) + "\n" + learning.CHECK_CLOSE
    groq.out["text"] = plan_text(text=body)
    out = run(chat_adapter.handle({"text": "x", "briefing": CTX, "learn": {"known": ["jadatva"]}}))
    rep = out[0]
    assert learning.CHECK_OPEN not in rep["text"] and briefing.PLAN_OPEN not in rep["text"]
    assert rep["learn"]["concept"] == "Torque" and rep["learn"]["checks"]
    assert "jadatva" in groq[-1][0][0]["content"]


def test_sirs_own_note_goes_with_the_data(groq):
    run(chat_adapter.handle({"text": "kal exam hai, plan halka rakho", "briefing": CTX}))
    assert "Sir's note for tonight: kal exam hai, plan halka rakho" in groq[-1][0][1]["content"]


def test_briefing_never_hits_the_action_parser(groq, monkeypatch):
    def boom(body):
        raise AssertionError("action parser must not see the briefing")
    monkeypatch.setattr(chat_adapter, "local_response", boom)
    out = run(chat_adapter.handle({"text": "kal 7 baje yaad dilana", "briefing": CTX}))
    assert out[0]["briefing"]["plan"]


def test_groq_failure_is_a_clear_text_reply(monkeypatch):
    async def fail(messages, **kw):
        raise briefing.standard_agent.StandardError("Groq ki sab keys busy hain.")
    monkeypatch.setattr(briefing.standard_agent, "answer", fail)
    out = run(briefing.reply({"briefing": CTX}))
    assert out[0]["text"] == "Groq ki sab keys busy hain." and "briefing" not in out[0]


def test_followup_goes_to_standard_with_records_and_research_off(monkeypatch):
    seen = {}

    async def fake_quick(text, extra, *a, **kw):
        seen["extra"], seen["research"] = extra, kw.get("research")
        return {"type": "text", "text": "ok"}

    async def boom(body):
        raise AssertionError("a follow-up is a normal Standard message, not a new briefing")
    monkeypatch.setattr(chat_adapter, "_quick_reply", fake_quick)
    monkeypatch.setattr(briefing, "reply", boom)
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", True)
    body = {"text": "robot arm ka gripper kaise banaun?", "mode": "standard",
            "briefing": {"followup": True, "goals": CTX["goals"], "projects": CTX["projects"]}}
    out = run(chat_adapter.handle(body))
    assert out[0]["text"] == "ok"
    assert "Robot arm" in seen["extra"] and seen["research"] is False


def test_android_entry_skips_action_parser_and_needs_groq(monkeypatch):
    import config

    def boom(body):
        raise AssertionError("action parser must not see the briefing")
    monkeypatch.setattr(chat_adapter, "local_response", boom)
    for s in range(1, config.KEY_SLOTS + 1):
        monkeypatch.delenv(config.slot_env("GROQ_API_KEY", s), raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "test-not-a-real-key")
    assert not config.PROVIDERS["groq"].api_key
    out = json.loads(android_entry.handle(json.dumps({"text": "x", "briefing": CTX})))
    assert "Groq" in out["text"]
