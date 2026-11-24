"""Item 6 (v1.0.67+): the assistant may change every app setting on command, except API keys, deleting chats and
PIN/password/lock (and its own AI-access permissions). Questions about a setting are never treated as commands."""
import os
from pathlib import Path
os.environ.setdefault("USAGE_FILE", str(Path(__file__).with_name(".usage-test.json")))
import pytest
from actions import schema
from actions.plan import plan

NOW = 1_800_000_000_000
ROOT = Path(__file__).resolve().parents[1]

def steps(text, mode="standard"):
    r = plan(text, mode, NOW)
    assert r and r["type"] == "actions", (text, r)
    return [(s["action"], s["args"]["key"], s["args"]["value"]) for s in r["steps"]]

@pytest.mark.parametrize("text,key,value", [
    ("web search off karo", "webSearch", False),
    ("built-in web search on kar do", "webSearch", True),
    ("startup animation band kar do", "bootAnim", False),
    ("animation hata do", "bootAnim", False),
    ("update notification on karo", "updateNotify", True),
    ("notification band karo", "notif", False),
    ("model calls dikhao", "calls", True),
    ("haptics band karo", "haptics", False),
    ("physics mode on karo", "mode", "physics"),
    ("verified mode mein jao", "mode", "v"),
    ("mode coding karo", "mode", "coding"),
    ("standard mode pe jao", "mode", "standard"),
    ("source manual karo", "source", "manual"),
    ("council deep karo", "think", "deep"),
    ("depth detailed karo", "depth", "detailed"),
    ("reply language english karo", "replyLang", "english"),
    ("settings theme dark", "theme", "dark"),
])
def test_app_settings_change_on_command(text, key, value):
    assert steps(text) == [("settings.update", key, value)]

def test_two_settings_in_one_command():
    assert steps("web search off karo aur theme dark karo") == [
        ("settings.update", "webSearch", False), ("settings.update", "theme", "dark")]

@pytest.mark.parametrize("text", [
    "api key change karo", "api keys dikhao", "groq api key delete karo",
    "chat delete karo", "sare chats delete karo", "is conversation ko clear karo",
    "pin change karo", "password badal do", "lock on hide off karo", "settings access on karo",
])
def test_api_keys_chat_delete_and_password_are_never_actions(text):
    r = plan(text, "standard", NOW)
    assert r and r["type"] == "blocked" and not r["steps"], (text, r)

@pytest.mark.parametrize("text", [
    "physics mode kya hai", "animation kaise banta hai", "what is the speed of light",
    "mujhe physics mode ke baare mein batao",
])
def test_questions_about_settings_go_to_the_model(text):
    r = plan(text, "standard", NOW)
    assert not (r and r["type"] in ("actions", "clarification")), (text, r)

def test_schema_allow_list_and_blocks():
    for key in ("apiKeys", "keys", "pin", "password", "lockOnHide", "aiAccess"):
        with pytest.raises(schema.Denied):
            schema.check("settings.update", {"key": key, "value": "off"}, NOW)
    with pytest.raises(schema.Bad):
        schema.check("settings.update", {"key": "mode", "value": "research"}, NOW)
    with pytest.raises(schema.Bad):
        schema.check("settings.update", {"key": "webSearch", "value": "maybe"}, NOW)
    assert schema.check("settings.update", {"key": "mode", "value": "maths"}, NOW)["value"] == "math"

def test_settings_commands_work_from_every_mode_but_other_actions_stay_standard_only():
    import chat_adapter
    r = chat_adapter.local_response({"text": "standard mode pe jao", "mode": "physics", "source": "auto"})
    assert isinstance(r, list) and r[0]["type"] == "actions"
    r = chat_adapter.local_response({"text": "task add karo kal 5 baje doodh", "mode": "physics", "source": "auto"})
    assert isinstance(r, dict) and "Standard mode" in r["text"]

def test_ui_executor_mirrors_the_allow_list_and_blocks():
    js = (ROOT / "ui/src/js/04-productivity.js").read_text()
    for key in ("webSearch", "bootAnim", "notif", "updateNotify", "calls", "mode", "source", "replyLang", "depth", "think"):
        assert f"'{key}'" in js
    for never in ("'lockOnHide'", "'aiAccess'", "saveKey", "deleteKey"):
        assert never not in js.split("const SETTINGS")[1].split(";")[0]
