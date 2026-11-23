"""Turn local parsed steps into an executable UI plan without model or network access."""
from __future__ import annotations

import time
import uuid
from . import parser, schema

PENDING = {
    "task.add": "task save kar raha hoon", "task.edit": "task update kar raha hoon", "task.done": "task completion update kar raha hoon",
    "task.list": "tasks dikha raha hoon", "note.add": "note save kar raha hoon", "note.edit": "note update kar raha hoon", "note.list": "notes dikha raha hoon",
    "reminder.add": "reminder laga raha hoon", "reminder.edit": "reminder update kar raha hoon", "reminder.list": "reminders dikha raha hoon",
    "alarm.add": "alarm set kar raha hoon", "alarm.edit": "alarm update kar raha hoon", "alarm.list": "alarms dikha raha hoon",
    "work.add": "work project bana raha hoon", "work.edit": "work project update kar raha hoon", "work.log": "work log save kar raha hoon", "work.list": "work projects dikha raha hoon",
    "memory.add": "memory save kar raha hoon", "memory.edit": "memory update kar raha hoon", "memory.list": "memories dikha raha hoon",
    "settings.update": "safe setting update kar raha hoon", "reminder.delete": "reminder delete kar raha hoon", "alarm.delete": "alarm delete kar raha hoon",
    "task.delete": "task delete kar raha hoon", "work.delete": "work delete kar raha hoon", "memory.clear": "memory clear kar raha hoon",
    "note.clear": "notes clear kar raha hoon", "timer.start": "timer laga raha hoon", "app.open": "app khol raha hoon", "web.search": "search kar raha hoon",
    "phone.status": "phone status check kar raha hoon", "calendar.add": "calendar mein event add kar raha hoon", "voice.open": "voice mode khol raha hoon",
    "message.draft": "message draft kar raha hoon", "call.dial": "call lagane wala hoon", "panel.open": "settings panel khol raha hoon", "dnd.set": "DND badal raha hoon", "torch.set": "torch badal raha hoon",
}


def _detail(action: str, a: dict) -> str:
    if action in ("reminder.add", "alarm.add", "reminder.edit", "alarm.edit"):
        return a.get("human") or a.get("text") or a.get("query") or ""
    if action == "timer.start":
        seconds = a["seconds"]
        return f"{seconds // 60} min" if seconds >= 60 else f"{seconds} sec"
    if action == "app.open": return a["app"]
    if action == "web.search": return a["query"]
    if action == "calendar.add": return (a.get("title") or "") + (" · " + (a.get("human") or "") if a.get("human") else "")
    if action in ("task.add", "work.add"): return a.get("title", "")[:60]
    if action in ("note.add", "memory.add", "work.log"): return a.get("text", "")[:60]
    if action in ("task.edit", "task.done", "note.edit", "reminder.edit", "alarm.edit", "work.edit", "memory.edit"): return a.get("query") or a.get("id") or ""
    if action == "settings.update": return f"{a.get('key')}={a.get('value')}"
    return ""


def _notice(kind: str, message: str, mode: str) -> dict:
    return {
        "type": kind,
        "id": uuid.uuid4().hex[:12],
        "text": "Ji Sir, " + message,
        "steps": [],
        "needsConfirm": False,
        "dropped": [],
        "mode": mode,
        "origin": "local-rule",
    }


def plan(text: str, mode: str = "standard", now: int | None = None) -> dict | None:
    """Return None for ordinary conversation, otherwise a local action/notice plan."""
    if str(mode).lower() != "standard": return None
    now = int(time.time() * 1000) if now is None else now
    raw = parser.parse(text, now)
    if not raw: return None
    for item in raw:
        action = item.get("action")
        args = item.get("args") or {}
        if action == "__blocked": return _notice("blocked", args.get("message", "Yeh action blocked hai."), "standard")
        if action == "__clarification": return _notice("clarification", args.get("message", "Thoda aur detail batao."), "standard")

    steps, dropped = [], []
    for i, item in enumerate(raw):
        action, raw_args = item["action"], item.get("args") or {}
        try:
            args = schema.check(action, raw_args, now)
        except schema.Denied as exc:
            return _notice("blocked", str(exc), "standard")
        except schema.Bad as exc:
            dropped.append({"action": action, "why": str(exc)})
            continue
        # ``human`` is parser display metadata, not an execution argument.
        if raw_args.get("human"):
            args["human"] = raw_args["human"]
        steps.append({
            "id": f"s{i + 1}", "action": action, "args": args,
            "risk": schema.risk(action, args), "pending": PENDING.get(action, "kaam kar raha hoon"),
            "detail": _detail(action, args),
        })
    if not steps:
        why = dropped[0]["why"] if dropped else "command samajh nahi aaya"
        return _notice("clarification", f"Action complete nahi hua: {why}.", "standard")
    needs = any(step["risk"] == schema.CONFIRM for step in steps)
    if len(steps) == 1:
        line = f"Ji Sir, {steps[0]['pending']}" + (f" — {steps[0]['detail']}" if steps[0]["detail"] else "") + "."
    else:
        line = f"Ji Sir, {len(steps)} kaam kar raha hoon."
    return {
        "type": "actions", "id": uuid.uuid4().hex[:12], "text": line, "steps": steps,
        "needsConfirm": needs, "dropped": dropped, "mode": "standard", "origin": "local-rule",
    }


def handle(text: str, mode: str = "standard", now: int | None = None) -> dict | None:
    return plan(text, mode, now)
