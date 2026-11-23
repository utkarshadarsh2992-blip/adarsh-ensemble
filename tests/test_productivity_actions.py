import time

import pytest

from actions import schema
from actions.plan import plan

NOW = int(time.mktime((2026, 11, 23, 18, 0, 0, 0, 0, -1)) * 1000)


def step(command):
    result = plan(command, "standard", NOW)
    assert result and result["type"] == "actions", result
    assert len(result["steps"]) == 1
    return result["steps"][0]


def test_task_add_is_distinct_with_and_without_time():
    timed = step("task add karo kal 7 baje padhai")
    assert timed["action"] == "task.add"
    assert timed["args"]["title"] == "padhai"
    assert timed["args"]["at"] > NOW

    untimed = step("task add karo padhai")
    assert untimed["action"] == "task.add"
    assert untimed["args"] == {"title": "padhai"}


def test_task_read_edit_and_completion_commands():
    assert step("tasks list dikhao")["action"] == "task.list"
    edited = step("task edit padhai to revision")
    assert edited["action"] == "task.edit" and edited["args"] == {"query": "padhai", "title": "revision"}
    completed = step("task padhai complete karo")
    assert completed["action"] == "task.done" and completed["args"] == {"query": "padhai", "done": True}


def test_natural_task_time_edit_and_hindi_task_add():
    edited = step("padhai wala task 8 baje kar do")
    assert edited["action"] == "task.edit"
    assert edited["args"]["query"] == "padhai" and edited["args"]["at"] > NOW
    completed = step("padhai task complete kar do")
    assert completed["action"] == "task.done" and completed["args"]["query"] == "padhai"
    hindi = step("कल 7 बजे पढ़ाई का टास्क जोड़ दो")
    assert hindi["action"] == "task.add"
    assert hindi["args"]["title"] == "पढ़ाई" and hindi["args"]["at"] > NOW


def test_notes_reminders_and_alarms_are_separate():
    assert step("note banao ki kal exam hai")["action"] == "note.add"
    assert step("notes list dikhao")["action"] == "note.list"
    assert step("reminders list dikhao")["action"] == "reminder.list"
    assert step("alarms list dikhao")["action"] == "alarm.list"
    edited = step("reminder edit paani kal 8 baje")
    assert edited["action"] == "reminder.edit" and edited["args"]["query"] == "paani"
    assert step("alarm edit wake kal 6 baje")["action"] == "alarm.edit"


def test_work_structured_fields_and_logs():
    added = step("work add Alpha category software goal ship MVP")
    assert added["action"] == "work.add"
    assert added["args"] == {"title": "Alpha", "category": "software", "goal": "ship MVP"}
    edited = step("work edit Alpha progress 40 outcome launched")
    assert edited["action"] == "work.edit"
    assert edited["args"]["query"] == "Alpha" and edited["args"]["progress"] == 40
    logged = step("work log Alpha text coding done date 2026-11-23 minutes 30 progress 40")
    assert logged["action"] == "work.log"
    assert logged["args"] == {"query": "Alpha", "text": "coding done", "date": "2026-11-23", "minutes": 30, "progress": 40}
    assert step("work list dikhao")["action"] == "work.list"


def test_natural_project_log_and_progress_edit():
    logged = step("Research project mein aaj 2 ghante ka work record karo literature padha")
    assert logged["action"] == "work.log"
    assert logged["args"] == {"query": "Research", "text": "literature padha", "minutes": 120}
    edited = step("Research project ki progress 40 percent kar do")
    assert edited["action"] == "work.edit"
    assert edited["args"] == {"query": "Research", "progress": 40}


def test_memory_and_safe_settings():
    assert step("memory add karo mera birthday 1 jan")["args"]["text"] == "mera birthday 1 jan"
    assert step("memory edit birthday to 2 jan")["action"] == "memory.edit"
    assert step("memory list dikhao")["action"] == "memory.list"
    assert step("settings theme dark")["args"] == {"key": "theme", "value": "dark"}
    assert step("settings voice rate 1.2")["args"] == {"key": "rate", "value": 1.2}
    assert step("settings voice engine system")["args"] == {"key": "voiceEngine", "value": "device"}
    assert step("settings speak on")["args"] == {"key": "speak", "value": True}
    assert step("settings voice replies off")["args"] == {"key": "voiceReplies", "value": False}
    assert step("settings language hindi")["args"] == {"key": "lang", "value": "hi-IN"}


def test_denials_are_not_confirmation_actions():
    for command in ("notes clear karo", "wifi band karo", "dnd on karo", "open settings", "security pin set karo"):
        result = plan(command, "standard", NOW)
        assert result["type"] == "blocked" and not result["steps"]
        assert result["needsConfirm"] is False


def test_malformed_recognized_commands_return_clarification():
    result = plan("task add karo kal baje", "standard", NOW)
    assert result["type"] == "clarification" and not result["steps"]
    assert "time" in result["text"].lower()
    result = plan("alarm lagao", "standard", NOW)
    assert result["type"] == "clarification" and "time" in result["text"].lower()


def test_schema_is_strict_and_applies_bounds():
    with pytest.raises(schema.Bad):
        schema.check("task.add", ["not", "an", "object"], NOW)
    with pytest.raises(schema.Bad):
        schema.check("task.add", {"title": "x", "security": True}, NOW)
    with pytest.raises(schema.Bad):
        schema.check("work.log", {"query": "x", "text": "log", "minutes": 1441}, NOW)
    with pytest.raises(schema.Bad):
        schema.check("work.edit", {"query": "x", "progress": 101}, NOW)
    with pytest.raises(schema.Bad):
        schema.check("settings.update", {"key": "mode", "value": "research"}, NOW)
    for key, value in (("rate", "nan"), ("rate", True), ("voiceEngine", "shell"), ("speak", "maybe")):
        with pytest.raises(schema.Bad): schema.check("settings.update", {"key": key, "value": value}, NOW)
    assert len(schema.check("task.add", {"title": "x" * 500}, NOW)["title"]) == 120
    assert len(schema.check("note.add", {"text": "x" * 900}, NOW)["text"]) == 600


def test_message_and_call_remain_mandatory_confirmation():
    for command in ("mummy ko message bhejo ki main late hoon", "Rahul ko call karo 9876543210"):
        result = plan(command, "standard", NOW)
        assert result["type"] == "actions" and result["needsConfirm"] is True
        assert result["steps"][0]["risk"] == schema.CONFIRM


def test_local_rule_origin_and_step_cap():
    result = plan("whatsapp kholo aur youtube kholo aur camera kholo aur maps kholo", "standard", NOW)
    assert result["origin"] == "local-rule"
    assert len(result["steps"]) == schema.MAX_STEPS
