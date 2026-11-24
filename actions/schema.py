"""Strict local action contracts, validation, and central safety policy."""
from __future__ import annotations

import datetime as _dt
import math
import time
from typing import Any

SAFE, CONFIRM, DENY, DESTRUCTIVE = "safe", "confirm", "deny", "destructive"

APPS = {
    "whatsapp": ("whatsapp", "whats app", "wa"),
    "youtube": ("youtube", "you tube"),
    "instagram": ("instagram", "insta", "ig"),
    "telegram": ("telegram",),
    "gmail": ("gmail", "email app", "mail"),
    "maps": ("maps", "google maps", "map"),
    "camera": ("camera",),
    "settings": ("settings", "setting"),
    "chrome": ("chrome", "browser"),
    "spotify": ("spotify", "music"),
    "phone": ("phone app", "dialer"),
    "messages": ("messages", "sms"),
    "calculator": ("calculator", "calc"),
    "clock": ("clock",),
    "photos": ("photos", "gallery"),
    "calendar": ("calendar app",),
    "drive": ("drive",),
    "facebook": ("facebook",),
    "twitter": ("twitter", "x app"),
    "netflix": ("netflix",),
    "paytm": ("paytm",),
    "phonepe": ("phonepe", "phone pe"),
    "gpay": ("gpay", "google pay"),
    "playstore": ("play store", "playstore"),
}
PANELS = {
    "wifi": ("wifi", "wi-fi"),
    "bluetooth": ("bluetooth",),
    "brightness": ("brightness", "roshni"),
    "dnd": ("dnd", "do not disturb", "silent mode", "silent"),
}
MAX_STEPS = 3
MAX_TEXT = 600
MAX_TITLE = 120


class Bad(Exception):
    """Invalid action or argument; it is never executed."""


class Denied(Bad):
    """An action explicitly prohibited by the local policy."""


# These are centrally denied even when a caller supplies confirmation.
DENIED_ACTIONS = frozenset({"note.clear", "task.delete", "reminder.delete", "alarm.delete", "work.delete",
                            "memory.clear", "pin.set", "security.change", "dnd.set", "panel.open"})

# ``human`` is parser-only display metadata retained for legacy time details.
_ALLOWED = {
    "task.add": {"title", "at", "human"},
    "task.edit": {"query", "id", "title", "at"},
    "task.done": {"query", "id", "done"},
    "task.list": set(),
    "note.add": {"text"},
    "note.edit": {"query", "id", "text"},
    "note.list": set(),
    "note.clear": set(),
    "reminder.add": {"at", "text", "human"},
    "reminder.edit": {"query", "id", "at", "text"},
    "reminder.list": set(),
    "reminder.delete": {"query", "id"},
    "alarm.add": {"at", "text", "human"},
    "alarm.edit": {"query", "id", "at", "text"},
    "alarm.list": set(),
    "alarm.delete": {"query", "id"},
    "work.add": {"title", "category", "goal"},
    "work.edit": {"query", "id", "title", "category", "goal", "progress", "outcome"},
    "work.log": {"query", "id", "text", "date", "minutes", "progress", "outcome"},
    "work.list": set(),
    "work.delete": {"query", "id"},
    "memory.add": {"text"},
    "memory.edit": {"query", "id", "text"},
    "memory.list": set(),
    "memory.clear": set(),
    "settings.update": {"key", "value"},
    "timer.start": {"seconds", "text"},
    "app.open": {"app"},
    "web.search": {"query"},
    "phone.status": set(),
    "calendar.add": {"at", "title", "minutes", "human"},
    "voice.open": set(),
    "message.draft": {"to", "text", "channel"},
    "call.dial": {"to"},
    "torch.set": {"on"},
    "dnd.set": {"on"},
    "panel.open": {"panel"},
    "pin.set": set(),
    "security.change": set(),
}

_SAFE_NEW = {"task.add", "task.edit", "task.done", "task.list", "note.add", "note.edit", "note.list",
             "reminder.add", "reminder.edit", "reminder.list", "alarm.add", "alarm.edit", "alarm.list",
             "work.add", "work.edit", "work.log", "work.list", "memory.add", "memory.edit", "memory.list",
             "settings.update"}
RISK = {action: SAFE for action in _SAFE_NEW}
RISK.update({
    "reminder.delete": DENY, "alarm.delete": DENY, "task.delete": DENY, "work.delete": DENY,
    "note.clear": DENY, "memory.clear": DENY, "pin.set": DENY, "security.change": DENY,
    "dnd.set": DENY, "panel.open": DENY,
    "reminder.add": SAFE, "alarm.add": SAFE, "timer.start": SAFE, "note.add": SAFE,
    "app.open": SAFE, "web.search": SAFE, "phone.status": SAFE, "calendar.add": SAFE,
    "voice.open": SAFE, "torch.set": SAFE, "message.draft": CONFIRM, "call.dial": CONFIRM,
})
# Everything the user can change by command. Never here (and never will be): API keys, deleting chats,
# PIN/password/lock and the AI-access permissions themselves; those stay manual in Settings.
_BOOL_SETTINGS = {"speak", "voiceReplies", "haptics", "webSearch", "bootAnim", "notif", "updateNotify", "calls"}
_ENUM_SETTINGS = {
    "voiceEngine": {"auto", "natural", "device"}, "theme": {"system", "light", "dark"},
    "font": {"serif", "sans"}, "lang": {"hi-IN", "en-IN", "en-US"},
    "mode": {"standard", "v", "physics", "math", "business", "coding"},
    "source": {"auto", "manual", "hybrid"},
    "replyLang": {"auto", "hinglish", "english", "hindi"},
    "depth": {"simple", "normal", "detailed"},
    "think": {"fast", "deep"},
}
_ENUM_ALIASES = {
    "voiceEngine": {"system": "device", "phone": "device", "automatic": "auto"},
    "theme": {"auto": "system"}, "font": {"sans-serif": "sans", "sans serif": "sans"},
    "lang": {"hindi": "hi-IN", "hinglish": "hi-IN", "english": "en-IN", "hi-in": "hi-IN", "en-in": "en-IN", "en-us": "en-US"},
    "mode": {"verified": "v", "maths": "math", "code": "coding", "normal": "standard"},
    "source": {"automatic": "auto"},
    "replyLang": {"automatic": "auto"},
    "depth": {"detail": "detailed", "short": "simple", "easy": "simple"},
    "think": {"quick": "fast"},
}
_BLOCKED_SETTINGS = {"lockOnHide", "lockAfter", "pin", "password", "aiAccess", "apiKeys", "keys"}
_ALLOWED_SETTINGS = {"name", "rate", "voiceName"} | _BOOL_SETTINGS | set(_ENUM_SETTINGS)


def _future(at: Any, now: int, max_days: int = 400) -> int:
    if isinstance(at, bool) or not isinstance(at, (int, float)):
        raise Bad("time missing")
    if at < now - 60_000:
        raise Bad("time is in the past")
    if at > now + max_days * 86_400_000:
        raise Bad("time is too far away")
    return int(at)


def _optional_future(a: dict, now: int) -> None:
    if "at" in a and a["at"] is not None:
        a["at"] = _future(a["at"], now)
    elif "at" in a:
        a.pop("at")


def _str(a: dict, key: str, limit: int, *, required: bool = False) -> str:
    value = a.get(key, "")
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise Bad(f"{key} must be text")
    value = value.strip()[:limit]
    if required and not value:
        raise Bad(f"{key} is empty")
    return value


def _ref(a: dict) -> None:
    has_query = bool(a.get("query"))
    has_id = a.get("id") not in (None, "")
    if has_query == has_id:
        raise Bad("query or id is required")
    if has_query:
        a["query"] = _str(a, "query", MAX_TITLE, required=True)
    else:
        if isinstance(a["id"], bool) or not isinstance(a["id"], (str, int)):
            raise Bad("id must be text or number")
        a["id"] = str(a["id"]).strip()
        if not a["id"]:
            raise Bad("id is empty")


def _bounded_int(value: Any, key: str, low: int, high: int) -> int:
    if isinstance(value, bool):
        raise Bad(f"{key} must be a number")
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise Bad(f"{key} must be a number")
    if not low <= result <= high:
        raise Bad(f"{key} must be {low}..{high}")
    return result


def _validate_date(value: Any) -> str:
    if not isinstance(value, str):
        raise Bad("date must be ISO YYYY-MM-DD")
    try:
        _dt.date.fromisoformat(value)
    except ValueError:
        raise Bad("date must be ISO YYYY-MM-DD")
    return value


def check(action: str, args: dict, now: int | None = None) -> dict:
    """Return a validated copy, rejecting unknown keys and all denied operations."""
    now = int(time.time() * 1000) if now is None else now
    if not isinstance(args, dict):
        raise Bad("arguments must be an object")
    if action in DENIED_ACTIONS:
        raise Denied("this action is blocked by safety policy")
    if action not in _ALLOWED:
        raise Bad(f"unknown action {action}")
    unknown = set(args) - _ALLOWED[action]
    if unknown:
        raise Bad("unknown argument(s): " + ", ".join(sorted(unknown)))
    a = dict(args)

    if action == "task.add":
        a["title"] = _str(a, "title", MAX_TITLE, required=True)
        _optional_future(a, now)
    elif action == "task.edit":
        _ref(a)
        if "title" in a: a["title"] = _str(a, "title", MAX_TITLE, required=True)
        _optional_future(a, now)
        if "title" not in a and "at" not in a: raise Bad("title or time change is required")
    elif action == "task.done":
        _ref(a)
        if not isinstance(a.get("done"), bool): raise Bad("done must be true or false")
    elif action == "task.list":
        pass
    elif action == "note.add":
        a["text"] = _str(a, "text", MAX_TEXT, required=True)
        if len(a["text"]) < 2: raise Bad("note is empty")
    elif action == "note.edit":
        _ref(a); a["text"] = _str(a, "text", MAX_TEXT, required=True)
    elif action == "note.list":
        pass
    elif action in ("reminder.add", "alarm.add"):
        a["at"] = _future(a.get("at"), now)
        limit = MAX_TITLE if action == "alarm.add" else MAX_TEXT
        default = "Alarm" if action == "alarm.add" else "Reminder"
        a["text"] = _str(a, "text", limit) or default
    elif action in ("reminder.edit", "alarm.edit"):
        _ref(a); _optional_future(a, now)
        if "text" in a: a["text"] = _str(a, "text", MAX_TITLE if action == "alarm.edit" else MAX_TEXT, required=True)
        if "at" not in a and "text" not in a: raise Bad("time or text change is required")
    elif action in ("reminder.list", "alarm.list"):
        pass
    elif action in ("reminder.delete", "alarm.delete"):
        _ref(a)
    elif action == "work.add":
        a["title"] = _str(a, "title", MAX_TITLE, required=True)
        for key in ("category", "goal"):
            if key in a: a[key] = _str(a, key, MAX_TEXT)
    elif action == "work.edit":
        _ref(a)
        present = False
        for key in ("title", "category", "goal", "outcome"):
            if key in a: a[key] = _str(a, key, MAX_TEXT if key != "title" else MAX_TITLE, required=(key == "title")); present = True
        if "progress" in a: a["progress"] = _bounded_int(a["progress"], "progress", 0, 100); present = True
        if not present: raise Bad("work field change is required")
    elif action == "work.log":
        _ref(a); a["text"] = _str(a, "text", MAX_TEXT, required=True)
        if "date" in a: a["date"] = _validate_date(a["date"])
        if "minutes" in a: a["minutes"] = _bounded_int(a["minutes"], "minutes", 0, 1440)
        if "progress" in a: a["progress"] = _bounded_int(a["progress"], "progress", 0, 100)
        if "outcome" in a: a["outcome"] = _str(a, "outcome", MAX_TEXT)
    elif action == "work.list":
        pass
    elif action == "work.delete":
        _ref(a)
    elif action == "memory.add":
        a["text"] = _str(a, "text", MAX_TEXT, required=True)
    elif action == "memory.edit":
        _ref(a); a["text"] = _str(a, "text", MAX_TEXT, required=True)
    elif action in ("memory.list", "memory.clear"):
        pass
    elif action == "settings.update":
        a["key"] = _str(a, "key", 30, required=True)
        if a["key"] in _BLOCKED_SETTINGS: raise Denied("API keys, PIN/password and AI access stay manual in Settings")
        if a["key"] not in _ALLOWED_SETTINGS: raise Denied("that setting is not editable by voice")
        if "value" not in a or isinstance(a["value"], (dict, list)):
            raise Bad("setting value is required")
        value = a["value"]
        if isinstance(value, str): value = value.strip()[:MAX_TEXT]
        key = a["key"]
        low = value.lower() if isinstance(value, str) else value
        if key in _BOOL_SETTINGS:
            if isinstance(value, bool): pass
            elif isinstance(low, str) and low in {"on", "true", "yes", "haan", "chalu"}: value = True
            elif isinstance(low, str) and low in {"off", "false", "no", "nahi", "band"}: value = False
            else: raise Bad("setting needs On/Off")
        elif key == "rate":
            if isinstance(value, bool): raise Bad("voice speed needs a number")
            try: value = float(value)
            except (TypeError, ValueError): raise Bad("voice speed needs a number")
            if not math.isfinite(value) or not 0.7 <= value <= 1.4: raise Bad("voice speed must be 0.7 to 1.4")
        elif key in _ENUM_SETTINGS:
            value = _ENUM_ALIASES.get(key, {}).get(low, low)
            if value not in _ENUM_SETTINGS[key]: raise Bad("unsupported setting value")
        elif key == "voiceName":
            voices = {v.lower(): v for v in ("Kore", "Orus", "Charon", "Sulafat", "Achird", "Iapetus", "Aoede", "Puck", "Gacrux", "Sadaltager")}
            if low not in voices: raise Bad("unknown natural voice")
            value = voices[low]
        elif key == "name":
            if not isinstance(value, str) or not value: raise Bad("name needs text")
            value = value[:60]
        a["value"] = value
    elif action == "timer.start":
        a["seconds"] = _bounded_int(a.get("seconds"), "timer", 1, 86_400)
        a["text"] = _str(a, "text", MAX_TITLE) or "Timer"
    elif action == "app.open":
        a["app"] = _str(a, "app", 40).lower()
        if a["app"] not in APPS: raise Bad("unknown app")
        if a["app"] == "settings": raise Denied("opening Settings is blocked by safety policy")
    elif action == "web.search":
        a["query"] = _str(a, "query", 200, required=True)
        if len(a["query"]) < 2: raise Bad("search is empty")
    elif action in ("phone.status", "voice.open"):
        pass
    elif action == "calendar.add":
        a["at"] = _future(a.get("at"), now); a["title"] = _str(a, "title", MAX_TITLE) or "Event"
        a["minutes"] = _bounded_int(a.get("minutes", 60), "minutes", 0, 1440)
    elif action == "message.draft":
        a["text"] = _str(a, "text", MAX_TEXT); a["to"] = _str(a, "to", 40)
        a["channel"] = _str(a, "channel", 20) or "sms"
        if not a["text"] and not a["to"]: raise Bad("message is empty")
    elif action == "call.dial":
        a["to"] = _str(a, "to", 40, required=True)
    elif action == "torch.set":
        a["on"] = bool(a.get("on"))
    elif action == "dnd.set":
        raise Denied("DND changes are blocked by safety policy")
    elif action == "panel.open":
        raise Denied("settings panels are blocked by safety policy")
    return a


def risk(action: str, args: dict | None = None) -> str:
    if action == "app.open" and args and args.get("app") == "settings":
        return DENY
    return RISK.get(action, DESTRUCTIVE)


def is_denied(action: str, args: dict | None = None) -> bool:
    return action in DENIED_ACTIONS or (action == "app.open" and args and args.get("app") == "settings")
