"""Night briefing (change 1.3): today's account, goals with days left, where every project stands, weak concepts
and tomorrow's plan, in ONE Groq call (Standard rules: Groq gpt-oss-120b only). Web search and Wikipedia stay off,
because the briefing is built from sir's own records.

The app (ui/src/js/04-briefing.js) builds a bounded summary in body.briefing only when sir starts the briefing
(tap on the night notification, the Today card or the drawer). The model writes the briefing and appends one hidden
plan block; the app shows the plan as a card and saves the items sir keeps as tasks for tomorrow.
Follow-up messages in the briefing chat send {"followup": true, "goals": [...], "projects": [...]} so the discussion
keeps the project facts without sending the whole day again (followup_note, used by chat_adapter).
"""
from __future__ import annotations

import datetime
import re

import health
import learning
import pipeline
import prompts
import standard_agent

PLAN_OPEN = "<<<ADARSH_PLAN"
PLAN_CLOSE = "ADARSH_PLAN>>>"
MAX_PLAN = 8
MAX_GOALS = 8
MAX_PROJECTS = 8
MAX_MEMORY_SUGGESTIONS = 3
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
_STATUS = ("active", "paused", "done")
# the language hint looks at this line when the reply language is "auto" (sir writes Roman Hinglish)
_HINT_TEXT = "Raat ki briefing do: aaj kya hua, projects kahan hai aur kal ka plan kya hai"

NIGHT_SYSTEM = (
    "You are Adarsh, Utkarsh's personal mentor; call him 'sir'. It is night: give his night briefing and plan "
    "tomorrow with him. Use ONLY the facts in [BRIEFING DATA]. Never invent tasks, progress, scores, dates, "
    "deadlines, projects or news; if something is missing, say so in one short line (for example 'aaj koi check "
    "question nahi hua'). Use the days-left numbers exactly as given. Be honest and specific: zero fluff, no "
    "motivational talk, no flattery, short lines.\n"
    + prompts.ABOUT_SIR + "\n"
    "Write these sections with short bold headings, in this order:\n"
    "**Aaj ka hisaab**: 2-4 lines on what he actually did today, from the data.\n"
    "**Mission aur goals**: one line per goal with days left, progress and whether today moved it; if a goal has "
    "no deadline, ask him to set one.\n"
    "**Projects**: every project, where it stands (version, built, learned, next upgrade) and one concrete next step "
    "in his builder cycle (build, learn, upgrade). Link a concept he learned today to a project only where it truly "
    "fits. If a project has been idle 3 or more days, say it plainly. With no project, suggest one small build that "
    "uses today's concepts and fits the mission.\n"
    "**Kamzor concepts**: only when there were wrong check answers; for each, the core idea again in one or two "
    "simple lines.\n"
    "**Kal ka plan**: 3 to 6 numbered items for tomorrow with times, most important first, each linked to a goal or "
    "project; respect the fixed items and never double-book them; keep the total realistic and add a revision slot "
    "when there are weak concepts.\n"
    "**Aaj raat ka sawaal**: one question to discuss with him now (a project decision or tomorrow's priority)."
)
PLAN_RULES = (
    "After everything else, append exactly one hidden block, nothing after it:\n"
    f'{PLAN_OPEN}\n{{"focus":"one line: tomorrow\'s single most important outcome","plan":[{{"title":"...",'
    '"time":"HH:MM","minutes":45,"goal":"goal title or empty","project":"project name or empty"}],'
    '"memories":[{"text":"durable fact grounded in today’s data","reason":"why it may help later"}]}\n'
    f"{PLAN_CLOSE}\n"
    "plan holds exactly the items of 'Kal ka plan' in the same order; time is 24-hour local time tomorrow, or empty "
    "when no fixed time fits. memories holds zero to three optional, durable memory suggestions grounded ONLY in "
    "BRIEFING DATA (a real learning milestone, project knowledge or explicit preference); each text is <=180 chars "
    "and reason <=120 chars. Do not infer mastery, repeat ABOUT SIR/profile facts, suggest transient tasks/schedules, "
    "sensitive family/private details, or invent anything. Use [] if nothing is worth remembering. These are proposals: "
    "the app will ask sir at night and save only if he taps Yaad rakho. The app reads and hides this block; never "
    "mention the block itself."
)


def revision_rules() -> str:
    """Check questions for the weak concepts, written before the plan block (checked on the phone, 0 tokens)."""
    return (
        "REVISION CHECK: there were wrong answers today, so before the plan block append one block:\n"
        f'{learning.CHECK_OPEN}\n{{"concept":"<the weakest concept>","heavy":true or false,"questions":[...],'
        f'"words":[]}}\n{learning.CHECK_CLOSE}\n'
        + learning._Q_RULES.format(count="Ask 1 or 2 questions, only about the weak concepts listed in the data.")
    )


# ----------------------------------------------------------------------------- request side
def _s(v, n: int) -> str:
    return learning._s(v, n)


def _items(v, n: int) -> list:
    return v[:n] if isinstance(v, list) else []


def _int(v, lo: int, hi: int):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        return None
    return int(max(lo, min(hi, round(v))))


def _date(v) -> str:
    v = _s(v, 12)
    if not _DATE.match(v):
        return ""
    try:
        datetime.date.fromisoformat(v)
    except ValueError:
        return ""
    return v


def _time(v) -> str:
    v = _s(v, 5)
    m = _TIME.match(v)
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else ""


def _strings(v, n: int, size: int) -> list[str]:
    return [x for x in (_s(i, size) for i in _items(v, n)) if x]


def clean_goals(raw) -> list[dict]:
    out = []
    for g in _items(raw, MAX_GOALS):
        if not isinstance(g, dict) or not _s(g.get("title"), 120):
            continue
        out.append({"title": _s(g.get("title"), 120), "deadline": _date(g.get("deadline")),
                    "daysLeft": _int(g.get("daysLeft"), -36500, 36500), "progress": _int(g.get("progress"), 0, 100),
                    "open": _strings(g.get("open"), 5, 100), "why": _s(g.get("why"), 200)})
    return out


def clean_projects(raw) -> list[dict]:
    out = []
    for p in _items(raw, MAX_PROJECTS):
        if not isinstance(p, dict) or not _s(p.get("name"), 80):
            continue
        status = p.get("status") if p.get("status") in _STATUS else "active"
        out.append({"name": _s(p.get("name"), 80), "version": _int(p.get("version"), 1, 99) or 1, "status": status,
                    "built": _s(p.get("built"), 300), "learned": _s(p.get("learned"), 300), "next": _s(p.get("next"), 300),
                    "idleDays": _int(p.get("idleDays"), 0, 3650), "concepts": _strings(p.get("concepts"), 8, 60),
                    "goal": _s(p.get("goal"), 120)})
    return out


def clean_context(raw) -> dict:
    """Strict, bounded copy of body.briefing; anything malformed is dropped."""
    raw = raw if isinstance(raw, dict) else {}
    t = raw.get("today") if isinstance(raw.get("today"), dict) else {}
    weak = [{"concept": _s(w.get("concept"), 80), "q": _s(w.get("q"), 200)}
            for w in _items(t.get("weak"), 6) if isinstance(w, dict) and (_s(w.get("concept"), 80) or _s(w.get("q"), 200))]
    open_tasks = [{"title": _s(x.get("title"), 120), "due": _s(x.get("due"), 40)}
                  for x in _items(t.get("open"), 10) if isinstance(x, dict) and _s(x.get("title"), 120)]
    work = [{"title": _s(x.get("title"), 120), "minutes": _int(x.get("minutes"), 0, 1440) or 0}
            for x in _items(t.get("work"), 6) if isinstance(x, dict) and _s(x.get("title"), 120)]
    fixed = [{"title": _s(x.get("title"), 120), "time": _time(x.get("time"))}
             for x in _items(raw.get("fixed"), 10) if isinstance(x, dict) and _s(x.get("title"), 120)]
    right, total = _int(t.get("right"), 0, 500) or 0, _int(t.get("total"), 0, 500) or 0
    return {
        "date": _date(raw.get("date")), "tomorrow": _date(raw.get("tomorrow")), "weekday": _s(raw.get("weekday"), 20),
        "tomorrowDay": _s(raw.get("tomorrowDay"), 20), "now": _time(raw.get("now")), "mission": _s(raw.get("mission"), 400),
        "goals": clean_goals(raw.get("goals")), "projects": clean_projects(raw.get("projects")),
        "today": {"questions": _int(t.get("questions"), 0, 500) or 0, "concepts": _strings(t.get("concepts"), 12, 80),
                  "words": _strings(t.get("words"), 20, 40), "right": min(right, total), "total": total, "weak": weak,
                  "done": _strings(t.get("done"), 10, 120), "open": open_tasks, "work": work},
        "fixed": fixed, "news": _strings(raw.get("news"), 5, 240),
    }


def _goal_line(i: int, g: dict) -> str:
    parts = [f"{i}. {g['title']}"]
    if g["deadline"]:
        left = g["daysLeft"]
        when = "" if left is None else (f" · {left} din baaki" if left >= 0 else f" · deadline {-left} din pehle nikal gayi")
        parts.append(f"deadline {g['deadline']}{when}")
    else:
        parts.append("deadline set nahi")
    if g["progress"] is not None:
        parts.append(f"progress {g['progress']}%")
    if g["open"]:
        parts.append("baaki milestones: " + "; ".join(g["open"]))
    if g["why"]:
        parts.append("kyun: " + g["why"])
    return " · ".join(parts)


def _project_line(i: int, p: dict) -> str:
    parts = [f"{i}. {p['name']} · v{p['version']} · {p['status']}"]
    if p["idleDays"] is not None:
        parts.append("aaj update hua" if p["idleDays"] == 0 else f"{p['idleDays']} din se update nahi")
    for key, label in (("goal", "goal"), ("built", "built"), ("learned", "learned"), ("next", "next upgrade")):
        if p[key]:
            parts.append(f"{label}: {p[key]}")
    if p["concepts"]:
        parts.append("concepts: " + ", ".join(p["concepts"]))
    return " · ".join(parts)


def context_text(ctx: dict) -> str:
    """Compact plain lines (cheaper than JSON) for the model."""
    t = ctx["today"]
    day = f" ({ctx['weekday']})" if ctx["weekday"] else ""
    tday = f" ({ctx['tomorrowDay']})" if ctx["tomorrowDay"] else ""
    lines = ["[BRIEFING DATA: sir's own app records. Use only this; never invent.]",
             f"Today: {ctx['date'] or 'unknown'}{day}, now {ctx['now'] or 'unknown'}. Tomorrow: {ctx['tomorrow'] or 'unknown'}{tday}."]
    if ctx["mission"]:
        lines.append("Mission: " + ctx["mission"])
    lines.append("GOALS:")
    lines += [_goal_line(i, g) for i, g in enumerate(ctx["goals"], 1)] or ["(koi goal nahi)"]
    lines.append("PROJECTS:")
    lines += [_project_line(i, p) for i, p in enumerate(ctx["projects"], 1)] or ["(koi project nahi)"]
    lines.append("TODAY:")
    lines.append(f"Questions asked: {t['questions']}. Concepts: {', '.join(t['concepts']) or 'none'}.")
    lines.append(f"New words learned: {', '.join(t['words']) or 'none'}.")
    lines.append(f"Check questions: {t['right']}/{t['total']} right." if t["total"] else "Check questions: none answered today.")
    if t["weak"]:
        lines.append("Wrong check answers (weak): " + "; ".join(
            (w["concept"] + (f' ("{w["q"]}")' if w["q"] else "")).strip() for w in t["weak"]))
    lines.append("Tasks done today: " + ("; ".join(t["done"]) or "none") + ".")
    if t["open"]:
        lines.append("Open tasks: " + "; ".join(x["title"] + (f" (due {x['due']})" if x["due"] else "") for x in t["open"]) + ".")
    if t["work"]:
        lines.append("Work logged today: " + "; ".join(f"{x['title']} {x['minutes']} min" for x in t["work"]) + ".")
    lines.append("TOMORROW ALREADY FIXED: " + ("; ".join((x["time"] + " " if x["time"] else "") + x["title"] for x in ctx["fixed"]) or "nothing") + ".")
    if ctx["news"]:
        lines.append("NEWS (from his news feed, already verified there): " + " | ".join(ctx["news"]))
    return "\n".join(lines)


def followup_note(raw) -> str:
    """Goals and projects for follow-up messages in the briefing chat (marks the context as private app records,
    so chat_adapter keeps web search and Wikipedia off for them)."""
    raw = raw if isinstance(raw, dict) else {}
    goals, projects = clean_goals(raw.get("goals")), clean_projects(raw.get("projects"))
    if not goals and not projects:
        return ""
    lines = ["\n\n[Permitted relevant app records; mission board from sir's night briefing, context only]"]
    lines += [_goal_line(i, g) for i, g in enumerate(goals, 1)]
    lines += [_project_line(i, p) for i, p in enumerate(projects, 1)]
    return "\n".join(lines)[:2500]


# ----------------------------------------------------------------------------- reply side
_PLAN_RE = re.compile(re.escape(PLAN_OPEN) + r"\s*(.*?)\s*(?:" + re.escape(PLAN_CLOSE) + r"|$)", re.DOTALL)


def clean_plan(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    items = []
    for p in _items(raw.get("plan"), 20):
        if not isinstance(p, dict) or len(items) >= MAX_PLAN:
            continue
        title = _s(p.get("title"), 120)
        if not title:
            continue
        items.append({"title": title, "time": _time(p.get("time")), "minutes": _int(p.get("minutes"), 0, 600) or 0,
                      "goal": _s(p.get("goal"), 120), "project": _s(p.get("project"), 80)})
    memories = []
    seen = set()
    for item in _items(raw.get("memories"), 20):
        if not isinstance(item, dict) or len(memories) >= MAX_MEMORY_SUGGESTIONS:
            continue
        text = _s(item.get("text"), 180)
        key = re.sub(r"\W+", " ", text.casefold()).strip()
        if not text or not key or key in seen:
            continue
        seen.add(key)
        memories.append({"text": text, "reason": _s(item.get("reason"), 120)})
    return {"focus": _s(raw.get("focus"), 200), "items": items, "memories": memories}


def split_plan(text: str) -> tuple[str, dict]:
    """Briefing text without the hidden plan block, and the cleaned plan ({"focus", "items"})."""
    text = text or ""
    i = text.rfind(PLAN_OPEN)
    if i < 0:
        return text, {"focus": "", "items": [], "memories": []}
    m = _PLAN_RE.match(text, i)
    return text[:i].rstrip(), clean_plan(learning._json_obj(m.group(1) if m else ""))


async def reply(body: dict) -> list[dict]:
    """One Groq call (no tools). A failure comes back as a clear text reply, like Standard."""
    ctx = clean_context(body.get("briefing"))
    learn = learning.options(body)
    rp = body.get("reply") if isinstance(body.get("reply"), dict) else {}
    reply_lang = rp.get("lang") if rp.get("lang") in ("auto", "hinglish", "english", "hindi") else "auto"
    revise = bool(ctx["today"]["weak"]) and learn["checks"]
    system = NIGHT_SYSTEM + ("\n" + revision_rules() if revise else "") + "\n" + PLAN_RULES
    if learn["known"]:
        system += "\n" + learning.known_note(learn["known"])
    system += "\n" + pipeline._language_hint(_HINT_TEXT, reply_lang)
    user = context_text(ctx)
    note = " ".join(str(body.get("text") or "").split())[:300]
    if note and not note.lower().startswith("raat ki briefing"):
        user += "\n\nSir's note for tonight: " + note
    trace = health.start_trace(False)
    health.set_stage("briefing")
    try:
        out = await standard_agent.answer(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            tools=False, web=False, max_tokens=3200, effort="medium", temperature=0.4, budget=100,
        )
    except standard_agent.StandardError as e:
        return [{"type": "text", "text": str(e), "uiMode": "standard", "steps": ["Raat ki briefing · sirf Groq"]}]
    text, plan = split_plan(out["text"])
    text, learned = learning.split_checks(text, learn["known"])
    rep = {
        "type": "text", "text": text or "Briefing khaali aayi. Dobara try karo.", "uiMode": "standard",
        "steps": [f"Raat ki briefing · Groq {out['used']} (sirf Groq · web/Wikipedia off: personal data)",
                  f"{len(ctx['goals'])} goals · {len(ctx['projects'])} projects · {ctx['today']['total']} checks aaj",
                  f"{out['secs']}s"],
        "briefing": {"date": ctx["date"], "for": ctx["tomorrow"], "focus": plan["focus"],
                     "plan": plan["items"], "memorySuggestions": plan["memories"]},
    }
    if learned:
        if not learn["checks"]:
            learned["checks"] = []
        rep["learn"] = learned
    calls = pipeline._compact_calls(trace)
    if calls:
        rep["calls"] = calls
    return [rep]
