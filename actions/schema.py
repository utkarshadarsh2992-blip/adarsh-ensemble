"""Action registry: what may run, which arguments are legal, and how risky each one is."""
from __future__ import annotations
import time

SAFE, CONFIRM, DESTRUCTIVE = "safe", "confirm", "destructive"

# app key -> words a person may say
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
PANELS = {"wifi": ("wifi", "wi-fi"), "bluetooth": ("bluetooth",), "brightness": ("brightness", "roshni"),
          "dnd": ("dnd", "do not disturb", "silent mode", "silent")}

MAX_STEPS = 3
MAX_TEXT = 600


class Bad(Exception):
    """Invalid action or argument: the step is dropped, never executed."""


def _future(at, now, max_days=400):
    if not isinstance(at, (int, float)):
        raise Bad("time missing")
    if at < now - 60_000:
        raise Bad("time is in the past")
    if at > now + max_days * 86_400_000:
        raise Bad("time is too far away")
    return int(at)


def check(action: str, args: dict, now: int | None = None) -> dict:
    """Validated copy of args. Raises Bad when the step must not run."""
    now = int(time.time() * 1000) if now is None else now
    a = dict(args or {})
    if action in ("reminder.add", "alarm.add"):
        a["at"] = _future(a.get("at"), now)
        a["text"] = str(a.get("text") or "")[:MAX_TEXT].strip() or ("Alarm" if action == "alarm.add" else "Reminder")
        if action == "alarm.add":
            a["text"] = a["text"][:120]
    elif action == "timer.start":
        try:
            s = int(a.get("seconds"))
        except (TypeError, ValueError):
            raise Bad("timer length missing")
        if not 1 <= s <= 86_400:
            raise Bad("timer must be 1 second to 24 hours")
        a["seconds"] = s
        a["text"] = str(a.get("text") or "Timer")[:120]
    elif action == "note.add":
        a["text"] = str(a.get("text") or "")[:MAX_TEXT].strip()
        if len(a["text"]) < 2:
            raise Bad("note is empty")
    elif action == "note.clear":
        pass
    elif action == "app.open":
        app = str(a.get("app") or "").lower()
        if app not in APPS:
            raise Bad("unknown app")
        a["app"] = app
    elif action == "web.search":
        q = str(a.get("query") or "").strip()[:200]
        if len(q) < 2:
            raise Bad("search is empty")
        a["query"] = q
    elif action == "phone.status":
        pass
    elif action == "calendar.add":
        a["at"] = _future(a.get("at"), now)
        a["title"] = str(a.get("title") or "Event")[:120]
        try:
            a["minutes"] = min(1440, max(5, int(a.get("minutes") or 60)))
        except (TypeError, ValueError):
            a["minutes"] = 60
    elif action == "voice.open":
        pass
    elif action == "message.draft":
        a["text"] = str(a.get("text") or "")[:MAX_TEXT]
        a["to"] = str(a.get("to") or "")[:40]
        if not a["text"] and not a["to"]:
            raise Bad("message is empty")
    elif action == "call.dial":
        a["to"] = str(a.get("to") or "").strip()[:20]
        if not a["to"]:
            raise Bad("number missing")
    elif action == "panel.open":
        p = str(a.get("panel") or "").lower()
        if p not in PANELS:
            raise Bad("unknown panel")
        a["panel"] = p
    elif action in ("dnd.set", "torch.set"):
        a["on"] = bool(a.get("on"))
    else:
        raise Bad(f"unknown action {action}")
    return a


RISK = {
    "reminder.add": SAFE, "alarm.add": SAFE, "timer.start": SAFE, "note.add": SAFE, "app.open": SAFE,
    "web.search": SAFE, "phone.status": SAFE, "calendar.add": SAFE, "voice.open": SAFE,
    "message.draft": CONFIRM, "call.dial": CONFIRM, "panel.open": CONFIRM, "dnd.set": CONFIRM, "torch.set": SAFE,
    "note.clear": DESTRUCTIVE,
}


def risk(action: str) -> str:
    return RISK.get(action, DESTRUCTIVE)
