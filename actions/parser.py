"""Deterministic Hindi/Hinglish/English action parser. No model, network, or arbitrary tool calls."""
from __future__ import annotations

import re
import time
from . import schema
from . import timeparse as tp

FILLER = r"(?:please|plz|kar do|kardo|kar de|karo|kr do|krdo|kr de|lagao|lagado|lag do|set karo|set kar do|banao|bana do|bana de|likh do|likh lo|save karo|save kar do|shuru karo|start karo|start|do|de|dena|chalu karo|bhejo|bhej do|जोड़ दो|जोड़ो|जोड़|कर दो|करो|बनाओ|बना दो|सेट करो)"
TRIM = re.compile(rf"\s*{FILLER}\s*$", re.I)


def _clean(s: str) -> str:
    s = (s or "").strip().strip(".!?।,;: ")
    s = TRIM.sub("", s).strip()
    s = re.sub(r"\s+(?:ka|ki|ke|ke liye|liye)$", "", s, flags=re.I).strip()
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip()


def _clauses(text: str) -> list[str]:
    parts = re.split(r"\s+(?:aur|and|phir|then|uske baad|iske baad)\s+|;\s*|,\s*(?=\w+\s+(?:bhi\s+)?(?:kholo|lagao|banao|karo|open|add|set))", text, flags=re.I)
    return [p for p in (x.strip() for x in parts) if p]


def _app(t: str) -> str | None:
    for key, words in schema.APPS.items():
        for word in words:
            if re.search(rf"(?<!\w){re.escape(word)}(?!\w)", t, re.I):
                return key
    return None


def _step(action: str, **args) -> dict:
    return {"action": action, "args": args}


def _blocked(message: str) -> dict:
    return _step("__blocked", message=message)


def _clarify(message: str) -> dict:
    return _step("__clarification", message=message)


def _has_time_intent(t: str) -> bool:
    # A bare day word can be part of a task title ("kal exam hai"); require
    # a clock, relative unit, or explicit scheduling preposition to flag a
    # malformed time expression.
    return bool(re.search(r"\b(?:at|baje|bje|am|pm|morning|subah|shaam|sham|raat|in|after|baad|minute|minutes|min|hour|hours|ghanta|ghante|सेकंड|मिनट|घंटा)\b", t, re.I))


def _ref(text: str, keywords: str) -> str:
    body = re.sub(keywords, " ", text, flags=re.I)
    body = re.sub(r"\b(?:ko|ka|ki|ke|for|mein|me|par|pe|please|please)\b", " ", body, flags=re.I)
    return _clean(body)


def _task_title(t: str) -> str:
    body = re.sub(r"\b(?:task|tasks|to-?do|todo|kaam|टास्क|काम)\b", " ", t, flags=re.I)
    body = re.sub(r"\b(?:add|create|new|naya|nayi|edit|update|change|banao|bana|set|title|naam|name)\b", " ", body, flags=re.I)
    body = re.sub(r"\b(?:karo|kar|kr|do|de|dena|please|ki|that|ek|a)\b", " ", body, flags=re.I)
    body = re.sub(r"(?:जोड़ दो|जोड़ो|जोड़|बनाओ|बना दो|सेट करो|कर दो|करो|बना|सेट|का|की|के)\s*$", " ", body, flags=re.I)
    body = tp.strip_time(body)
    body = re.sub(r"(?:का|की|के)\s*$", " ", body, flags=re.I)
    return _clean(body)


def _task_reference(t: str) -> str:
    """Extract a natural task subject, but do not guess from an empty command."""
    body = tp.strip_time(t)
    body = re.sub(r"\b(?:task|tasks|to-?do|todo|kaam|टास्क|काम)\b", " ", body, flags=re.I)
    body = re.sub(r"\b(?:complete|completed|done|finish|finished|edit|update|change|badal|karo|kar|kr|do|de|dena|please|wala|wali|waale|ko|ka|ki|ke|that)\b", " ", body, flags=re.I)
    body = re.sub(r"(?:कर दो|करो|पूरा|बदल दो|अपडेट करो|वाला|वाली|वाले|को|का|की|के)", " ", body, flags=re.I)
    return _clean(body)


def _project_prefix(t: str) -> str:
    """Return the subject before ``project/work`` in natural project phrasing."""
    m = re.match(r"\s*(.+?)\s+\b(?:project|work)\b", t, re.I)
    if not m:
        return ""
    query = _clean(m.group(1))
    if query.lower() in {"work", "project", "log", "record", "update", "edit", "change"}:
        return ""
    return query


def _parse_ref_and_value(t: str, kind: str) -> tuple[str, str]:
    body = re.sub(rf"\b(?:{kind}|tasks?|to-?do|todo|kaam|edit|update|change|karo|kar|do|please)\b", " ", t, flags=re.I)
    m = re.search(r"\b(?:to|as|title|naam|name)\b\s+(.+)$", body, re.I)
    if m:
        value = _clean(m.group(1))
        ref = _clean(body[:m.start()])
    else:
        bits = _clean(body).split()
        ref, value = (_clean(" ".join(bits[:1])), _clean(" ".join(bits[1:]))) if len(bits) > 1 else (_clean(body), "")
    return ref, value


def _field(text: str, names: str, stop: str = r"$") -> str:
    m = re.search(rf"\b(?:{names})\b\s+(.+?)(?=\s+\b(?:{stop})\b|$)", text, re.I)
    return _clean(m.group(1)) if m else ""


def _parse_settings(t: str) -> dict | None:
    aliases = {
        "voice name": "voiceName", "voiceName": "voiceName",
        "voice engine": "voiceEngine", "engine": "voiceEngine", "voiceEngine": "voiceEngine",
        "voice replies": "voiceReplies", "voiceReplies": "voiceReplies", "speak": "speak",
        "haptics": "haptics", "name": "name", "theme": "theme", "font": "font",
        "voice rate": "rate", "voice speed": "rate", "rate": "rate", "lang": "lang", "language": "lang",
    }
    for alias, key in sorted(aliases.items(), key=lambda item: -len(item[0])):
        m = re.search(rf"\b{re.escape(alias)}\b\s*(?:ko|is|=|:)?\s*(?:set|change|update|karo|kar do)?\s+(.+)$", t, re.I)
        if m:
            value = _clean(m.group(1))
            if value:
                return _step("settings.update", key=key, value=value)
    return None


_ON = r"(?:on|chalu|enable|enabled|start|dikhao|dikha do|show|lagao|activate)"
_OFF = r"(?:off|band|bnd|disable|disabled|stop|chhupao|chupao|hide|hatao|hata do|hata|mat dikhao|deactivate)"
_DO = r"(?:karo|kar do|kr do|krdo|kardo|kar|kr|do|de do|please|ji|na)"
_MODE_WORDS = {"standard": "standard", "normal": "standard", "verified": "v", "v": "v", "physics": "physics",
               "math": "math", "maths": "math", "business": "business", "coding": "coding", "code": "coding"}
_SWITCHES = (   # (pattern naming the feature, settings key); first match wins, so specific names come first
    (r"update\s*(?:wala|ka|ki)?\s*notifications?|update\s*alerts?|auto\s*update\s*notifications?", "updateNotify"),
    (r"(?:built-?in\s*)?web\s*search|internet\s*search|online\s*search", "webSearch"),
    (r"(?:startup|start-up|opening|boot|intro)\s*animation|animation", "bootAnim"),
    (r"model\s*calls?(?:\s*(?:panel|toggle|list))?", "calls"),
    (r"(?:reply|jawab|answer)?\s*notifications?", "notif"),
    (r"haptics?|vibration|vibrate", "haptics"),
    (r"voice\s*replies|bol\s*ke\s*jawab", "voiceReplies"),
)
def _is_question(t: str) -> bool:
    low = re.sub(r"\s+", " ", (t or "").lower()).strip()
    return bool(re.search(r"\b(?:kya|kaise|kyu|kyun|why|what|how|kaun|kaunsa|which|explain|samjhao|batao|baare)\b", low)) and not re.search(rf"\b{_DO}\s*$", low)
def _parse_app_setting(t: str) -> dict | None:
    """Plain commands for the app's own switches and choices ("web search off karo", "physics mode on karo",
    "council deep karo"). Questions about a setting ("physics mode kya hai") are not commands."""
    low = re.sub(r"\s+", " ", (t or "").lower()).strip()
    if _is_question(low): return None
    for pat, key in _SWITCHES:
        m = re.search(rf"\b(?:{pat})\b", low)
        if not m: continue
        rest = low[m.end():] + " " + low[:m.start()]
        on = re.search(rf"\b{_ON}\b", rest); off = re.search(rf"\b{_OFF}\b", rest)
        if on and not off: return _step("settings.update", key=key, value="on")
        if off and not on: return _step("settings.update", key=key, value="off")
        return None
    words = "|".join(sorted(_MODE_WORDS, key=len, reverse=True))
    verb = rf"(?:{_ON}|{_DO}|switch|select|set|change|badlo|mein jao|me jao|pe jao|par jao|chalao|use)"
    m = re.search(rf"\b({words})\s+mode\b.*\b{verb}\b", low) or re.search(rf"\bmode\b\s*(?:ko)?\s*({words})\b.*\b{verb}\b", low)
    if m and not (m.group(1) == "v" and "v mode" not in low):
        return _step("settings.update", key="mode", value=_MODE_WORDS[m.group(1)])
    m = re.search(r"\b(?:answer\s+)?source\b\s*(?:ko)?\s*(auto|manual|hybrid)\b|\b(auto|manual|hybrid)\s+source\b", low)
    if m: return _step("settings.update", key="source", value=m.group(1) or m.group(2))
    m = re.search(r"\b(?:reply|answer|jawab)\s*(?:ki|ka)?\s*(?:language|lang|bhasha)\b\s*(?:ko)?\s*(auto|hinglish|english|hindi)\b", low)
    if m: return _step("settings.update", key="replyLang", value=m.group(1))
    m = re.search(r"\bdepth\b\s*(?:ko)?\s*(simple|normal|detailed|detail)\b|\b(simple|normal|detailed)\s+depth\b", low)
    if m: return _step("settings.update", key="depth", value=m.group(1) or m.group(2))
    m = re.search(r"\bcouncil\b\s*(?:ko)?\s*(fast|deep|quick)\b|\b(fast|deep)\s+council\b", low)
    if m: return _step("settings.update", key="think", value=m.group(1) or m.group(2))
    return None
def one(text: str, now: int) -> dict | None:
    """One clause -> one raw step. Validation and safety decisions happen in schema/plan."""
    raw = (text or "").strip()
    source = re.sub(r"[!?।]+", " ", raw)
    t = source.lower()
    padded = " " + t + " "

    # Mutating the assistant's own implementation is never an executable action.
    if re.search(r"\b(?:apna|apne|mera|my|own|self)\s+(?:source\s+)?code\b", padded, re.I) and re.search(r"\b(?:change|edit|modify|update|rewrite|fix|delete|remove|badal|mitao|बदल|हटा)\b", padded, re.I):
        return _blocked("I cannot change my own code or implementation from a command.")

    # Explicitly prohibited operations are recognized before generic commands.
    if re.search(r"\b(?:pin|passcode|password|security|lock)\b", padded) and re.search(r"\b(?:set|change|reset|remove|disable|enable|badal|banao|on|off|band|chalu|hatao)\b", padded):
        return _blocked("PIN/security changes are blocked; use the phone's security settings directly.")
    # API keys are never read or changed by the assistant (Settings > API keys only).
    if re.search(r"\b(?:api\s*keys?|apikey|api)\b", padded) and re.search(r"\b(?:set|change|update|save|add|delete|remove|reset|badal|badlo|daal|dalo|hata|mita|dikhao|show|batao)\b", padded):
        return _blocked("API keys AI nahi chhoota; Settings > API keys mein khud badliye.")
    if re.search(r"\b(?:clear|delete|remove|hata|mita|saaf|erase)\b", padded) and re.search(r"\b(?:chat|chats|conversation|history)\b", padded):
        return _blocked("chat delete sirf aap khud kar sakte hain; AI chats delete nahi karta.")
    app_setting = _parse_app_setting(source)
    if app_setting: return app_setting
    if re.search(r"\b(?:clear|delete|remove|hata|mita|saaf|erase)\b", padded):
        if re.search(r"\b(?:note|notes)\b", padded): return _step("note.clear")
        if re.search(r"\b(?:task|tasks|todo|to-do)\b", padded): return _step("task.delete", query=_ref(t, r"\b(?:delete|remove|hata|mita|clear|task|tasks|todo|to-?do)\b"))
        if re.search(r"\b(?:reminder|reminders)\b", padded): return _step("reminder.delete", query=_ref(t, r"\b(?:delete|remove|hata|mita|clear|reminder|reminders)\b"))
        if re.search(r"\b(?:alarm|alarms)\b", padded): return _step("alarm.delete", query=_ref(t, r"\b(?:delete|remove|hata|mita|clear|alarm|alarms)\b"))
        if re.search(r"\b(?:work|project)\b", padded): return _step("work.delete", query=_ref(t, r"\b(?:delete|remove|hata|mita|clear|work|project)\b"))
        if re.search(r"\b(?:memory|memories)\b", padded): return _step("memory.clear")
        return _blocked("Delete/clear commands are blocked for safety.")

    # Device status and voice conversation. Bare RAM/storage/charge questions
    # may refer to remote hardware; route them locally only with a clear device
    # target. Battery questions remain a familiar shorthand for this device.
    status_term = re.search(r"\b(?:battery|charge|charging|storage|ram)\b", padded)
    battery_intent = re.search(r"\bbattery\b", padded)
    local_device = re.search(r"\b(?:phone|mobile|device)\b", padded)
    remote_hardware = re.search(r"\b(?:cloud|gpu|laptop|server|provider|providers|workstation|remote)\b", padded)
    if status_term and (battery_intent or local_device) \
            and not remote_hardware and not re.search(r"\b(?:search|google|open|kholo)\b", padded):
        return _step("phone.status")
    if re.search(r"\b(?:phone|device)\s+status\b", padded) \
            and not remote_hardware and not re.search(r"\b(?:search|google|open|kholo)\b", padded):
        return _step("phone.status")
    if re.search(r"\b(?:voice mode|voice conversation|voice chat|baat karni hai|baat karte hain|bol ke baat)\b", padded):
        return _step("voice.open")

    # DND and panels are recognized but centrally denied, never confirmation-enabled.
    if re.search(r"\b(?:dnd|do not disturb|silent mode)\b", padded) and re.search(r"\b(?:on|off|set|badal|change|chalu|band)\b", padded):
        return _step("dnd.set", on=bool(re.search(r"\b(?:on|chalu)\b", padded)))
    for panel, words in schema.PANELS.items():
        if panel != "dnd" and any(re.search(rf"(?<!\w){re.escape(w)}(?!\w)", t) for w in words) and re.search(r"\b(?:band|bnd|off|on|chalu|kholo|khol do|open|settings?)\b", padded):
            return _step("panel.open", panel=panel)

    # Torch remains a simple safe legacy action.
    if re.search(r"\b(?:torch|flashlight|flash light)\b", padded):
        return _step("torch.set", on=not bool(re.search(r"\b(?:off|band|bnd|buza|bujha)\b", padded)))

    # Timers, before productivity time expressions.
    if re.search(r"\b(?:timer|countdown)\b", padded):
        secs = tp.duration(t)
        if secs:
            return _step("timer.start", seconds=secs, text=_clean(re.sub(r"\b(?:timer|countdown|ka|ki|ke|lagao|set|karo)\b", " ", source, flags=re.I)))
        return _clarify("Timer duration missing. Say for example: '5 minute ka timer lagao'.")

    # Tasks: task.add is deliberately distinct from reminders and notes.
    task_word = bool(re.search(r"\b(?:task|tasks|todo|to-?do|kaam|टास्क|काम)\b", padded))
    if task_word and re.search(r"\b(?:list|show|read|dikhao|dekhao|dikhana|saare|all)\b", padded):
        return _step("task.list")
    if task_word and re.search(r"\b(?:done|complete|completed|finish|finished|poora|pura|ho gaya|mark)\b", padded):
        query = _ref(source, r"\b(?:task|tasks|todo|to-?do|kaam|done|complete|completed|finish|finished|poora|pura|ho gaya|mark|as)\b")
        if not query: return _clarify("Kaunsa task complete karna hai? Task ka naam batao.")
        return _step("task.done", query=query, done=not bool(re.search(r"\b(?:undo|not|uncomplete|pending|baaki)\b", padded)))
    task_add_intent = bool(re.search(r"\b(?:add|create|new|naya|nayi|banao|bana|set)\b", padded)) or bool(re.search(r"(?:जोड़|बनाओ|बना दो|सेट)", t))
    task_at = tp.when(t, now)
    natural_task_edit = task_word and task_at and not task_add_intent \
        and not bool(re.search(r"\b(?:done|complete|completed|finish|finished|poora|pura|ho gaya|mark)\b", padded)) \
        and not bool(re.search(r"\b(?:reminder|remind|yaad dila|yaad dilao|yaad dilana|yaad karna|notification|notify|alert)\b", padded))
    if task_word and (re.search(r"\b(?:edit|update|change|badal)\b", padded) or natural_task_edit):
        query, title = _parse_ref_and_value(source, "task")
        at = task_at
        if natural_task_edit and not re.search(r"\b(?:edit|update|change|badal)\b", padded):
            query = _task_reference(source)
            title = ""
        args = {"query": query}
        cleaned_title = _clean(tp.strip_time(title)) if title else ""
        if cleaned_title: args["title"] = cleaned_title
        if at: args["at"] = at[0]
        if not args.get("title") and not at: return _clarify("Task edit ke liye task ka naam aur naya title/time batao.")
        if not query: return _clarify("Kaunsa task update karna hai? Task ka naam batao.")
        return _step("task.edit", **args)
    if task_word and task_add_intent:
        at = task_at
        if _has_time_intent(t) and not at:
            return _clarify("Task ka time samajh nahi aaya. 'kal 7 baje' ya '10 minute baad' bolo.")
        title = _task_title(source)
        if not title: return _clarify("Task ke liye title batao, jaise 'task add karo padhai'.")
        args = {"title": title}
        if at: args["at"], args["human"] = at
        return _step("task.add", **args)

    # Work/project tracking with structured fields.
    work_word = bool(re.search(r"\b(?:work|project|project work)\b", padded))
    if work_word and re.search(r"\b(?:list|show|read|dikhao|dekhao|overview|saare|all)\b", padded):
        return _step("work.list")
    if work_word and re.search(r"\b(?:log|update progress|progress log|record|journal)\b", padded):
        query_match = re.search(r"\b(?:work|project)\s+(?:log|update|record|journal)?\s*(.+?)(?=\s+\b(?:text|note|update|date|minutes|mins|progress|outcome)\b|$)", source, re.I)
        query = _clean(query_match.group(1)) if query_match else ""
        natural_query = _project_prefix(source)
        if natural_query:
            query = natural_query
        if query.lower() in {"log", "update", "record", "journal"}: query = ""
        text_match = re.search(r"\b(?:text|note)\s+(.+?)(?=\s+\b(?:date|minutes|mins|progress|outcome)\b|$)", source, re.I)
        text_value = _clean(text_match.group(1)) if text_match else ""
        record_tail = re.search(r"\b(?:record|log)\s+(?:karo|kar do|kardo|kr do)?\s*(.+)$", source, re.I)
        if not text_value and record_tail:
            text_value = _clean(record_tail.group(1))
        if not text_value: text_value = _field(source, r"(?:log|update)", r"(?:date|minutes|mins|progress|outcome)")
        if not text_value: text_value = _clean(re.sub(r"\b(?:work|project|log|update|progress|record|journal)\b", " ", source, flags=re.I))
        # Natural duration belongs to the structured minutes field, not the log text.
        text_value = _clean(re.sub(r"\b(?:aaj|today|kal|tomorrow)\b", " ", text_value, flags=re.I))
        text_value = _clean(re.sub(r"\b\d+(?:\.\d+)?\s*(?:second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|ghanta|ghante|सेकंड|मिनट|घंटा|घंटे)\b\s*(?:ka|ki|ke)?", " ", text_value, flags=re.I))
        args = {"query": query, "text": text_value}
        date = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", t)
        if date: args["date"] = date.group(1)
        m = re.search(r"\b(?:minutes?|mins?)\s*(?:=|:|is)?\s*(\d+)\b", t)
        if m: args["minutes"] = int(m.group(1))
        elif tp.duration(t): args["minutes"] = int(tp.duration(t) // 60)
        m = re.search(r"\bprogress\s*(?:=|:|is)?\s*(\d{1,3})\s*%?", t)
        if m: args["progress"] = int(m.group(1))
        outcome = _field(source, r"outcome|result", r"(?:date|minutes|mins|progress)")
        if outcome: args["outcome"] = outcome
        if not query or not text_value: return _clarify("Work log ke liye project aur update text batao.")
        return _step("work.log", **args)
    natural_progress_edit = work_word and re.search(r"\bprogress\s+\d{1,3}\s*(?:%|percent|प्रतिशत)?\b", padded, re.I)
    if work_word and (re.search(r"\b(?:edit|update|change|badal)\b", padded) or natural_progress_edit):
        query_match = re.search(r"\b(?:work|project)\s+(?:edit|update|change|badal)?\s*(.+?)(?=\s+\b(?:title|name|category|type|goal|objective|progress|outcome|result)\b|$)", source, re.I)
        query = _clean(query_match.group(1)) if query_match else ""
        natural_query = _project_prefix(source)
        if natural_query:
            query = natural_query
        if query.lower() in {"edit", "update", "change", "badal"}: query = ""
        args = {"query": query}
        for key, aliases in (("category", "category|type"), ("goal", "goal|objective"), ("outcome", "outcome|result")):
            value = _field(source, aliases, r"category|type|goal|objective|progress|outcome|result")
            if value: args[key] = value
        m = re.search(r"\bprogress\s*(?:=|:|is)?\s*(\d{1,3})\s*%?", t)
        if m: args["progress"] = int(m.group(1))
        title = _field(source, r"title|name", r"category|type|goal|objective|progress|outcome|result")
        if title: args["title"] = title
        if not query or len(args) == 1: return _clarify("Work edit ke liye project aur badalne wala field batao.")
        return _step("work.edit", **args)
    if work_word and re.search(r"\b(?:add|create|new|naya|nayi|banao|bana)\b", padded):
        body = re.sub(r"\b(?:work|project|project work|add|create|new|naya|nayi|banao|bana|karo|kar|do|please)\b", " ", source, flags=re.I)
        category = _field(source, r"category|type", r"goal|objective")
        goal = _field(source, r"goal|objective", r"category|type")
        title = _clean(body)
        title = re.sub(r"\b(?:category|type|goal|objective)\b.*$", " ", title, flags=re.I)
        if not title: return _clarify("Work/project ka title batao.")
        args = {"title": title}
        if category: args["category"] = category
        if goal: args["goal"] = goal
        return _step("work.add", **args)

    # Notes remain explicit; they are never the fallback for a task.
    if re.search(r"\b(?:note|notes)\b", padded) and re.search(r"\b(?:list|show|read|dikhao|dekhao|saare|all)\b", padded):
        return _step("note.list")
    if re.search(r"\b(?:note|notes)\b", padded) and re.search(r"\b(?:edit|update|change|badal)\b", padded):
        query, value = _parse_ref_and_value(source, "note")
        natural = re.match(r"\s*(?:ka|ki|ke)\s+(?:text|content)\s+(?:edit|update|change|badal)\s+(?:karo|kar do|kardo|kr do)?\s*(.+)$", value, re.I)
        if natural:
            value = _clean(natural.group(1))
        value = re.sub(r"^(?:karke|kar ke|to|as)\s+", "", value, flags=re.I)
        if not query or not value: return _clarify("Note edit ke liye note ka naam aur naya text batao.")
        return _step("note.edit", query=query, text=value)
    natural_note = re.search(r"\b(?:note|notes)\s+(.+?)\s+ko\s+(.+?)\s+(?:kar do|kardo|karo)\s*$", source, re.I)
    if natural_note:
        query, value = _clean(natural_note.group(1)), _clean(natural_note.group(2))
        if query and value:
            return _step("note.edit", query=query, text=value)
    # A direct "yaad rakho / remember" request is the user's explicit daytime memory approval: save it now.
    # Keep this before the Note handler so it cannot silently become a note.
    if re.search(r"\b(?:memory|yaad|remember)\b", padded) and re.search(r"\b(?:add|save|remember|yaad rakh(?:o|na)|banao|create)\b", padded):
        body = re.sub(r"\b(?:memory|add|save|remember|yaad rakh(?:o|na)|banao|create|karo|kar|do|ki|that|ye baat|is baat ko|this)\b", " ", source, flags=re.I)
        body = _clean(body)
        if not body: return _clarify("Memory mein kya save karna hai?")
        return _step("memory.add", text=body)
    if re.search(r"\b(?:note|notes|likh lo|likh do|save karo|save kar)\b", padded):
        body = re.sub(r"\b(?:note|notes|banao|bana do|bana|likh lo|likh do|save karo|save kar|mein|me|bhi|ek|new|naya|nayi|karo|kar do|ki|that)\b", " ", source, flags=re.I)
        body = _clean(body)
        if not body: return _clarify("Note ka text batao.")
        return _step("note.add", text=body)

    # Memory and safe settings are local UI-owned operations.
    if re.search(r"\b(?:memory|yaad)\b", padded) and re.search(r"\b(?:list|show|read|dikhao|dekhao|saari|all)\b", padded):
        return _step("memory.list")
    if re.search(r"\b(?:memory|yaad)\b", padded) and re.search(r"\b(?:edit|update|change|badal)\b", padded):
        query, value = _parse_ref_and_value(source, "memory")
        if not query or not value: return _clarify("Memory edit ke liye memory ka reference aur naya text batao.")
        return _step("memory.edit", query=query, text=value)
    if re.search(r"\b(?:settings?|preference|preferences)\b", padded):
        if re.search(r"\b(?:open|kholo|launch)\b", padded):
            return _step("app.open", app="settings")
        if re.search(r"\b(?:pin|password|security|access|permission|dnd|do not disturb|panel|api|keys?)\b", padded):
            return _blocked("PIN/password, API keys, AI access, DND and panels stay manual in Settings.")
        setting = _parse_settings(source)
        if setting: return setting
        return _clarify("Kaunsi setting, Sir? Jaise theme, font, voice, mode, web search, animation, notification, depth ya council.")
    # Questions ("what is the speed of light", "mera name kya hai") are for the model, not setting commands.
    setting = _parse_settings(source) if re.search(r"\b(?:theme|font|rate|speed|lang|language|voice|engine|speak|haptics|name)\b", padded) and not _is_question(t) else None
    if setting: return setting

    # Reminders are now tasks with a scheduled time (v1.0.71).
    if re.search(r"\b(?:scheduled reminders?|reminders?)\b", padded) and re.search(r"\b(?:list|show|read|dikhao|dekhao|saare|all)\b", padded):
        return _step("task.list")
    if re.search(r"\b(?:reminder|remind|yaad dila|yaad dilao|yaad dilana)\b", padded) and re.search(r"\b(?:edit|update|change|badal)\b", padded):
        query, value = _parse_ref_and_value(source, "reminder")
        at = tp.when(t, now); args = {"query": query}
        cleaned_title = _clean(tp.strip_time(value)) if value else ""
        if cleaned_title: args["title"] = cleaned_title
        if at: args["at"] = at[0]
        if not query or ("title" not in args and "at" not in args): return _clarify("Reminder/task edit ke liye naam aur naya title/time batao.")
        return _step("task.edit", **args)
    if re.search(r"\b(?:scheduled alarms?|alarms?)\b", padded) and re.search(r"\b(?:list|show|read|dikhao|dekhao|saare|all)\b", padded):
        return _step("alarm.list")
    if re.search(r"\balarm\b", padded) and re.search(r"\b(?:edit|update|change|badal)\b", padded):
        query, value = _parse_ref_and_value(source, "alarm")
        at = tp.when(t, now); args = {"query": query}
        cleaned_value = _clean(tp.strip_time(value)) if value else ""
        if cleaned_value: args["text"] = cleaned_value
        if at: args["at"] = at[0]
        if not query or ("text" not in args and "at" not in args): return _clarify("Alarm edit ke liye alarm aur naya text/time batao.")
        return _step("alarm.edit", **args)
    if re.search(r"\balarm\b", padded):
        at = tp.when(t, now)
        if not at: return _clarify("Alarm ka future time batao, jaise 'kal subah 7 baje'.")
        label = _clean(tp.strip_time(re.sub(r"\b(?:alarm|lagao|set|karo|laga|do)\b", " ", source, flags=re.I))) or "Alarm"
        return _step("alarm.add", at=at[0], text=label[:120], human=at[1])
    notification_reminder = bool(re.search(r"\b(?:notification|notify|alert)\b", padded)) and bool(re.search(r"\b(?:bhej|bhejo|dena|do|kar)\b", padded))
    # reminder words → task.add with time (v1.0.71)
    if re.search(r"\b(?:reminder|remind|yaad dila|yaad dilao|yaad dilana|yaad karna)\b", padded) or notification_reminder:
        at = tp.when(t, now)
        if at is None: at = (now + 600_000, tp.clock(now + 600_000) + " (default 10 min)")
        body = re.sub(r"\b(?:reminder|remind|yaad dila|yaad dilao|yaad dilana|yaad karna|task|tasks|todo|to-?do|kaam|notification|notify|alert|bhej dena|bhej do|bhejna|bhejo|mujhe|me|to)\b", " ", source, flags=re.I)
        body = _clean(tp.strip_time(body))
        body = _clean(re.sub(r"^(?:\s*(?:set|lagao|laga|banao|bana|add|karo|kar|do|ke liye|liye|ka|ki|ek|naya|nayi|new)\b)+", " ", body, flags=re.I))
        if len(body) < 3 or body.lower() in {"task", "kaam", "reminder", "note", "yaad"}: body = "yaad dilana"
        return _step("task.add", title=body, at=at[0], human=at[1])

    # Calendar, communication, apps, and search legacy commands.
    if re.search(r"\b(?:calendar|meeting|appointment|event)\b", padded) and re.search(r"\b(?:add|banao|create|schedule|lagao|set)\b", padded):
        at = tp.when(t, now)
        if not at: return _clarify("Calendar event ka future time batao.")
        title = _clean(tp.strip_time(re.sub(r"\b(?:calendar|meeting|appointment|event|add|banao|create|schedule|lagao|set|karo|mein|me)\b", " ", source, flags=re.I)))
        return _step("calendar.add", at=at[0], title=title or ("Meeting" if "meeting" in t else "Event"), minutes=60, human=at[1])
    m = re.search(r"\b(?:message|msg|text)\s+(?:karo|kar do|bhej do|bhejo|draft)\b", padded) or re.search(r"\b(?:whatsapp|sms)\b.*\b(?:bhej|bhejo|message|msg|text)\b", padded)
    if m:
        to = re.search(r"([a-z\u0900-\u097F][\w\u0900-\u097F]{0,20})\s+ko\s+(?:message|msg|text|whatsapp)", source, re.I)
        body = re.search(r"\b(?:ki|that|:)\s+(.+)$", source, re.I)
        return _step("message.draft", to=(to.group(1).strip() if to else ""), text=(body.group(1).strip() if body else ""), channel="whatsapp" if "whatsapp" in t else "sms")
    if re.search(r"\b(?:call karo|phone karo|dial karo|call lagao)\b", padded):
        num = re.search(r"(\+?\d[\d ]{6,14})", t)
        who = re.search(r"\b(?:to|ko)\s+([a-z\u0900-\u097F][\w\u0900-\u097F ]{1,24})", t)
        return _step("call.dial", to=(num.group(1).strip() if num else (who.group(1).strip() if who else "")))
    if re.search(r"\b(?:open|kholo|launch)\b", padded):
        app = _app(t)
        if app: return _step("app.open", app=app)
    # Only an explicit browser mention opens Google. "ispar search karo" is a normal question: it must go to the
    # model (with its own web search), not to a browser tab.
    if re.search(r"\b(?:google|browser|chrome)\b", padded):
        m = re.search(r"\b(?:google|search|dhundo|dhunde)\b(?:\s+(?:par|pe|mein|me|for))?\s*(.*)$", t)
        if m:
            q = _clean(re.sub(r"\b(?:google|par|pe|mein|me|search|dhundo|dhunde|karo|kar|do|for)\b", " ", m.group(1), flags=re.I))
            if len(q) >= 2: return _step("web.search", query=q)
    return None


def parse(text: str, now: int | None = None) -> list[dict]:
    """Command text -> at most three raw steps; empty means ordinary conversation."""
    now = int(time.time() * 1000) if now is None else now
    src = (text or "").strip()
    if not src or len(src) > 400: return []
    parts = _clauses(src)
    steps: list[dict] = []
    for part in parts[:schema.MAX_STEPS]:
        step = one(part, now)
        if not step:
            steps = []
            break
        steps.append(step)
    if not steps:
        whole = one(src, now)
        if not whole: return []
        steps = [whole]
    # "isi baat ka note bhi bana do" refers to the prior step.
    for i, step in enumerate(steps):
        if step["action"] == "note.add" and i and re.match(r"^(isi|us|iske|uske|same|isko|yeh|ye|this)\b|^$", step["args"].get("text", "")):
            prev = steps[i - 1]["args"]
            step["args"]["text"] = prev.get("text") or prev.get("query") or prev.get("title") or "Note"
    return steps
