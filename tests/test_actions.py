import time
import pytest
from actions import parser, schema, timeparse as tp
from actions.plan import plan

NOW = int(time.mktime((2026, 11, 23, 18, 0, 0, 0, 0, -1)) * 1000)   # Mon 6 pm local


def one(text):
    p = plan(text, "standard", NOW)
    return p, (p["steps"][0] if p else None)


def test_relative_and_absolute_time():
    at, label = tp.when("10 minute baad", NOW)
    assert at == NOW + 600_000 and "6:10 pm" in label
    assert tp.when("in 2 hours", NOW)[0] == NOW + 7_200_000
    at, label = tp.when("kal subah 7 baje", NOW)
    assert time.localtime(at / 1000).tm_hour == 7 and label.startswith("kal 7:00 am")
    assert time.localtime(tp.when("at 9:30 pm", NOW)[0] / 1000).tm_hour == 21
    assert tp.when("7 baje", NOW)[0] > NOW            # past hour rolls to tomorrow
    assert tp.duration("do ghante") == 7200 and tp.duration("90 sec") == 90
    assert tp.when("kuch bhi nahi", NOW) is None


def test_reminder():
    p, s = one("10 minute baad paani peene ka reminder lagao")
    assert s["action"] == "reminder.add" and s["args"]["text"] == "paani peene"
    assert s["args"]["at"] == NOW + 600_000 and s["risk"] == "safe"
    assert p["type"] == "actions" and p["text"].startswith("Ji Sir")
    p, s = one("remind me in 20 minutes to call mom")
    assert s["args"]["text"] == "call mom"
    p, s = one("reminder lagao")                       # no time: 10 minute default, said out loud
    assert s["args"]["at"] == NOW + 600_000 and "default" in s["detail"]


def test_alarm_timer_note():
    assert one("kal subah 7 baje alarm lagao")[1]["action"] == "alarm.add"
    p, s = one("5 minute ka timer lagao")
    assert s["action"] == "timer.start" and s["args"]["seconds"] == 300
    p, s = one("note banao ki kal exam hai")
    assert s["action"] == "note.add" and s["args"]["text"] == "kal exam hai"


def test_open_search_status_voice():
    assert one("whatsapp kholo")[1]["args"]["app"] == "whatsapp"
    assert one("google par best laptop search karo")[1]["args"]["query"] == "best laptop"
    assert one("battery kitni hai")[1]["action"] == "phone.status"
    assert one("voice mode kholo")[1]["action"] == "voice.open"
    assert one("torch on karo")[1]["args"]["on"] is True


def test_sensitive_actions_need_confirmation():
    for cmd in ("mummy ko message bhejo ki main late hoon", "Rahul ko call karo 9876543210"):
        p, s = one(cmd)
        assert s["risk"] == "confirm" and p["needsConfirm"] is True
    blocked = plan("notes clear karo", "standard", NOW)
    assert blocked["type"] == "blocked" and not blocked["steps"]
    assert plan("wifi band karo", "standard", NOW)["type"] == "blocked"


def test_calendar_title_kept():
    s = one("kal 3 baje meeting add karo calendar mein")[1]
    assert s["action"] == "calendar.add" and s["args"]["title"] == "Meeting"


def test_not_a_command_returns_none():
    for q in ("quantum entanglement kya hai", "write a poem about rain", "explain entropy", ""):
        assert plan(q, "standard", NOW) is None


def test_standard_mode_only():
    assert plan("5 minute ka timer lagao", "research", NOW) is None
    assert plan("5 minute ka timer lagao", "standard", NOW) is not None


def test_multi_step_and_coreference():
    p = plan("reminder lagao aur isi baat ka note bhi bana do", "standard", NOW)
    assert [s["action"] for s in p["steps"]] == ["reminder.add", "note.add"]
    assert p["steps"][1]["args"]["text"] == p["steps"][0]["args"]["text"]
    p = plan("wifi band karo aur bluetooth band karo", "standard", NOW)
    assert p["type"] == "blocked" and not p["steps"]


def test_multi_step_capped_and_unclear_falls_back():
    p = plan("whatsapp kholo aur youtube kholo aur camera kholo aur maps kholo", "standard", NOW)
    assert len(p["steps"]) == schema.MAX_STEPS
    assert plan("note banao ki kal exam hai aur ghar jana hai", "standard", NOW)["steps"][0]["args"]["text"] \
        == "kal exam hai aur ghar jana hai"


def test_validation_drops_bad_steps():
    with pytest.raises(schema.Bad):
        schema.check("reminder.add", {"at": NOW - 86_400_000, "text": "x"}, NOW)
    with pytest.raises(schema.Bad):
        schema.check("timer.start", {"seconds": 0}, NOW)
    with pytest.raises(schema.Bad):
        schema.check("app.open", {"app": "not-an-app"}, NOW)
    with pytest.raises(schema.Bad):
        schema.check("note.add", {"text": " "}, NOW)
    with pytest.raises(schema.Denied):
        schema.check("dnd.set", {}, NOW)
    assert schema.check("timer.start", {"seconds": 60}, NOW)["seconds"] == 60


def test_plan_shape_for_ui():
    p = plan("5 minute ka timer lagao", "standard", NOW)
    assert set(p) >= {"type", "id", "text", "steps", "needsConfirm"}
    s = p["steps"][0]
    assert set(s) == {"id", "action", "args", "risk", "pending", "detail"}
    assert p["id"] and len(p["id"]) == 12


def test_no_model_or_network_needed():
    import importlib
    mod = importlib.import_module("actions.plan")
    assert not hasattr(mod, "httpx") and not hasattr(mod, "config")   # pure local rules
    p = plan("5 minute ka timer lagao", "standard", NOW)
    assert p and p["steps"][0]["action"] == "timer.start"


def test_task_and_notification_wording():
    # All task creation wording, including "task set karo", creates a task.
    p, s = one("task set karo kal 5 baje paani peena")
    assert s["action"] == "task.add" and s["args"]["title"] == "paani peena"
    assert time.localtime(s["args"]["at"] / 1000).tm_hour == 17
    # A timed task add is a task, not a reminder.
    p, s = one("task add karo kal 7 baje padhai")
    assert s["action"] == "task.add" and s["args"]["title"] == "padhai"
    assert time.localtime(s["args"]["at"] / 1000).tm_hour == 7
    # ... and a no-time task is still a task, not a note.
    p, s = one("task add karo ki kal exam hai")
    assert s["action"] == "task.add" and "exam" in s["args"]["title"]
    # "mujhe notification bhej dena" is still a reminder, not a chat question
    p, s = one("mujhe notification bhej dena 10 minute baad paani ke liye")
    assert s["action"] == "reminder.add" and s["args"]["at"] == NOW + 600_000
    # a bare command leaves a usable text instead of the filler word
    p, s = one("kaam yaad dila do 2 ghante baad")
    assert s["action"] == "reminder.add" and s["args"]["text"] == "yaad dilana"


def test_own_code_is_blocked_and_architecture_is_conversation():
    blocked = plan("apna code change karo", "standard", NOW)
    assert blocked["type"] == "blocked" and not blocked["steps"]
    assert plan("architecture kaise kaam karta hai", "standard", NOW) is None
