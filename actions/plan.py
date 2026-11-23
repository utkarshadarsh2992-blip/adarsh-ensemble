"""Turn parsed steps into a reply the app can execute, with risk levels and a short Jarvis-style line."""
from __future__ import annotations
import time
import uuid
from . import parser, schema

PENDING = {
    "reminder.add": "reminder laga raha hoon",
    "alarm.add": "alarm set kar raha hoon",
    "timer.start": "timer laga raha hoon",
    "note.add": "note save kar raha hoon",
    "note.clear": "saare notes hata raha hoon",
    "app.open": "app khol raha hoon",
    "web.search": "search kar raha hoon",
    "phone.status": "phone status check kar raha hoon",
    "calendar.add": "calendar mein event add kar raha hoon",
    "voice.open": "voice mode khol raha hoon",
    "message.draft": "message draft kar raha hoon",
    "call.dial": "call lagane wala hoon",
    "panel.open": "settings khol raha hoon",
    "dnd.set": "DND badal raha hoon",
    "torch.set": "torch badal raha hoon",
}


def _detail(action: str, a: dict) -> str:
    if action in ("reminder.add", "alarm.add"):
        return a.get("human") or ""
    if action == "timer.start":
        s = a["seconds"]
        return f"{s // 60} min" if s >= 60 else f"{s} sec"
    if action == "app.open":
        return a["app"]
    if action == "web.search":
        return a["query"]
    if action == "calendar.add":
        return (a.get("title") or "") + (" · " + a["human"] if a.get("human") else "")
    if action == "note.add":
        return a["text"][:60]
    return ""


def plan(text: str, mode: str = "standard", now: int | None = None) -> dict | None:
    """None when this is not an in-app command (then the normal brain answers)."""
    if str(mode).lower() != "standard":
        return None            # Jarvis actions live in Standard mode only
    now = int(time.time() * 1000) if now is None else now
    raw = parser.parse(text, now)
    if not raw:
        return None
    steps, dropped = [], []
    for i, s in enumerate(raw):
        try:
            args = schema.check(s["action"], s.get("args") or {}, now)
        except schema.Bad as e:
            dropped.append({"action": s["action"], "why": str(e)})
            continue
        human = (s.get("args") or {}).get("human")
        if human:
            args["human"] = human
        steps.append({
            "id": f"s{i + 1}",
            "action": s["action"],
            "args": args,
            "risk": schema.risk(s["action"]),
            "pending": PENDING.get(s["action"], "kaam kar raha hoon"),
            "detail": _detail(s["action"], args),
        })
    if not steps:
        return None
    needs = any(s["risk"] != schema.SAFE for s in steps)
    if len(steps) == 1:
        line = f"Ji Sir, {steps[0]['pending']}" + (f" — {steps[0]['detail']}" if steps[0]["detail"] else "") + "."
    else:
        line = f"Ji Sir, {len(steps)} kaam kar raha hoon."
    return {
        "type": "actions",
        "id": uuid.uuid4().hex[:12],
        "text": line,
        "steps": steps,
        "needsConfirm": needs,
        "dropped": dropped,
        "mode": "standard",
    }


def handle(text: str, mode: str = "standard", now: int | None = None) -> dict | None:
    return plan(text, mode, now)
