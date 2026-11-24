"""The ensemble pipeline.

Where the drafts come from (`source`):
  auto    -> our 6-model panel writes the drafts
  manual  -> YOU paste answers from other AIs (ChatGPT, Gemini, Claude, ...)
  hybrid  -> your pasted answers + our panel's drafts together

Then:
  [0] input guard on pasted answers (prompt-injection detector) + task classification
  [1] diverse generation: 6 models x 6 thinking styles, in parallel
  [2] drafts anonymised + shuffled (no brand bias, no position bias)
  [3] engine "verified": tone-stripper -> Popper falsifiers -> Python proofs -> 3-part judge
      engine "simple"  : plain debate -> synthesizer
Every model call goes through llm.chat(), which fails over along the role's fallback chain.
"""
import asyncio
import random
import re
import string
import time

import httpx

import config
import council
import guard
import master
import health
import prompts
import roles
import verified
from llm import LLMError, chat, make_client


def _language_hint(question: str, reply_lang: str = "auto") -> str:
    # An explicit choice wins. Otherwise Devanagari or common Hinglish markers -> answer in the user's style.
    if reply_lang in prompts.LANG_HINTS:
        return prompts.LANG_HINTS[reply_lang]
    if re.search(r"[ऀ-ॿ]", question):
        return "Reply in Hindi (Devanagari), keeping technical terms in English."
    hinglish = r"\b(kya|kaise|kyun|kyu|hai|nahi|mujhe|chahiye|karna|batao|samjhao|ka|ki|ke)\b"
    if len(re.findall(hinglish, question.lower())) >= 2:
        return "Reply in Hinglish (Hindi written in Roman script), keeping technical terms in English."
    return "Reply in the same language as the question."


def _unique(label: str, taken) -> str:
    out, n = label, 2
    while out in taken:
        out = f"{label} ({n})"
        n += 1
    return out


async def classify(client: httpx.AsyncClient, question: str) -> str:
    health.set_stage("classify")
    try:
        out = await chat(
            client,
            config.CLASSIFIER,
            [
                {"role": "system", "content": prompts.CLASSIFIER_SYSTEM},
                {"role": "user", "content": question[:1500]},
            ],
            temperature=0.0,
            max_tokens=300,  # reasoning models spend some of this on thinking
            timeout=40,
            retries=0,
        )
    except LLMError:
        return "general"
    low = re.sub(r"[\s\-]+", "_", out.lower())
    found = [(low.find(t), t) for t in prompts.TASK_TYPES if t in low]
    return min(found)[1] if found else "general"


async def _ask_member(client, spec, question, task, lang) -> tuple[str, str | None, str | None]:
    # drafts are keyed by ROLE (unique per panel slot); health trace shows which model served it
    stage = f"panel:{spec.role}"
    health.set_stage(stage)
    title = prompts.ROLE_INFO.get(spec.role, (spec.role,))[0]
    config.emit(f"{title}: sawaal mila, soch raha hai")
    t0 = time.perf_counter()
    try:
        text = await asyncio.wait_for(
            chat(
                client,
                spec,
                prompts.panel_messages(question, spec.role, task, lang),
                temperature=0.5,
                max_tokens=config.PANEL_MAX_TOKENS,
            ),
            timeout=config.PANEL_TIMEOUT_S,
        )
        call = health.last_call(stage) or {}
        config.emit(f"{title}: draft mila ({call.get('used', spec.label)}, {len(text.split())} shabd, {time.perf_counter() - t0:.0f}s)")
        return spec.role, text, None
    except (LLMError, asyncio.TimeoutError) as e:
        config.emit(f"{title}: draft nahi mila ({'time khatam' if isinstance(e, asyncio.TimeoutError) else 'sab models fail'})")
        return spec.role, None, str(e) or "timeout"


async def _debater_turn(client, spec, question, drafts, others, lang):
    health.set_stage(f"debate:{spec.label}")
    try:
        text = await asyncio.wait_for(
            chat(
                client,
                spec,
                prompts.debate_messages(question, drafts, others, lang),
                temperature=0.3,
                max_tokens=config.FALSIFIER_MAX_TOKENS,
            ),
            timeout=config.PANEL_TIMEOUT_S,
        )
        return text, None
    except (LLMError, asyncio.TimeoutError) as e:
        return None, str(e) or "timeout"


async def _debate(client, question, drafts, rounds, lang, deep):
    """Multi-round debate (simple engine). Returns (transcript, errors).
    transcript = [ {"Debater 1": text, ...}, ... ] one dict per round."""
    debaters = config.DEBATERS if deep else config.DEBATERS[:2]
    names = [f"Debater {i + 1}" for i in range(len(debaters))]
    transcript: list[dict[str, str]] = []
    errors: dict[str, str] = {}
    prev: dict[str, str] | None = None

    for r in range(rounds):
        results = await asyncio.gather(
            *[
                _debater_turn(
                    client, d, question, drafts,
                    None if prev is None else {k: v for k, v in prev.items() if k != names[i]},
                    lang,
                )
                for i, d in enumerate(debaters)
            ]
        )
        positions = {names[i]: t for i, (t, e) in enumerate(results) if t}
        for i, (t, e) in enumerate(results):
            if e:
                errors[f"{names[i]}@round{r + 1}"] = e
        if not positions:
            break
        transcript.append(positions)
        prev = positions
    return transcript, errors


def _format_debate(transcript: list[dict[str, str]]) -> str | None:
    if not transcript:
        return None
    parts = []
    for i, positions in enumerate(transcript, 1):
        body = "\n\n".join(f"#### {k}\n{v}" for k, v in positions.items())
        parts.append(f"### Debate round {i}\n{body}")
    return "\n\n".join(parts)


async def _noop() -> dict:
    return {}


async def _general() -> str:
    return "general"


async def run(
    question: str,
    *,
    deep: bool = True,
    debug: bool = False,
    answers: list[dict] | None = None,
    source: str = "auto",
    debate_rounds: int = 1,
    engine: str = "verified",
    run_code: bool = True,
    use_guard: bool = True,
    reply_lang: str = "auto",  # auto | hinglish | english | hindi
    depth: str = "normal",  # simple | normal | detailed
    style: str = "auto",  # auto | solve | explain
    record: bool = False,  # keep every prompt/output and return out["council"] (see council.py)
    mode: str = "standard",  # UI chat mode (standard | v | physics | math | business | coding): roles engine only
    web_research: bool = True,  # no web queries from permitted private app/chat context
    topics: list[dict] | None = None,  # sub-topic map of a big message (bigtask.py); roles engine answers each
) -> dict:
    t0 = time.perf_counter()
    trace = health.start_trace(record)
    rec = {"question": question, "deep": deep, "source": source, "depth": depth, "reply_lang": reply_lang,
           "ui_mode": mode} if record else None
    lang = _language_hint(question, reply_lang)  # language only (falsifiers, debaters)
    lang_full = (lang + " " + prompts.DEPTH_HINTS.get(depth, "")).strip()  # + depth (drafters, judge, synthesizer)
    if config.LEARNER_PROFILE:  # + who the reader is (how to teach him); never goes to falsifiers / auditor
        lang_full = f"{lang_full}\n{prompts.LEARNER_PROFILE}"
    rounds = max(0, min(debate_rounds, config.MAX_DEBATE_ROUNDS))
    errors: dict[str, str] = {}
    warnings: list[str] = []

    # Drafts provided by the user (from other AIs)
    user_drafts: dict[str, str] = {}
    if source in ("manual", "hybrid"):
        for i, a in enumerate(answers or []):
            label = _unique((a.get("source") or "").strip() or f"Answer {i + 1}", user_drafts)
            user_drafts[label] = a["text"].strip()

    async with make_client() as client:  # TCP keep-alive: see llm.make_client
        config.emit("Sawaal samajh raha hu")
        # [0] guard pasted answers + classify the question, concurrently
        master_mode = source == "manual" and config.MASTER_ENABLED and bool(user_drafts) and engine in ("verified", "roles")
        guard_report, task = await asyncio.gather(
            guard.scan(client, user_drafts) if (use_guard and user_drafts) else _noop(),
            _general() if master_mode else classify(client, question),  # master mode needs no task type
        )
        for name, g in guard_report.items():
            if g["flagged"]:
                warnings.append(
                    f"Pasted answer '{name}' was flagged by the injection detector "
                    f"(score {g['max_score']:.2f}). It was still used, but treated strictly as data."
                )
            elif g["chunks"] and g["unavailable"] == g["chunks"]:
                warnings.append(
                    f"Pasted answer '{name}' was NOT scanned: no injection detector was reachable "
                    "(Groq guard and the fallback LLM both failed)."
                )
            elif g["chunks"] and g["unparsed"] + g["unavailable"] == g["chunks"]:
                warnings.append(
                    f"Injection detector gave no readable score for '{name}' (output format differs?)."
                )
            elif "llm-fallback" in g["via"]:
                warnings.append(
                    f"'{name}' was scanned by the weaker LLM fallback detector (Groq guard unavailable). "
                    f"Reason: {g.get('why') or 'unknown'}"
                )

        if master_mode:
            # Manual: one master answer from the pasted answers only. No panel, no falsifiers, no code.
            items = list(user_drafts.items())
            random.shuffle(items)
            anon = {string.ascii_uppercase[i]: text for i, (_, text) in enumerate(items)}
            letter_to_name = {string.ascii_uppercase[i]: name for i, (name, _) in enumerate(items)}
            flagged = {l for l, n in letter_to_name.items() if guard_report.get(n, {}).get("flagged")}
            answer, extras = await master.run_master(client, question, anon, letter_to_name, lang, lang_full, errors, flagged)
            warnings += extras.get("warnings", [])
            return _pack(
                answer, "general", user_drafts, {}, errors, [], t0, debug, 0, trace=trace, warnings=warnings,
                guard_report=guard_report, letter_to_name=letter_to_name, engine="master", extras=extras,
                style="master", rec=rec,
            )

        if engine == "roles":
            # the 11-role flow writes its own drafts (Architect -> Theorist/Empiricist/... -> Judge -> Reviewers)
            answer, extras, panel_drafts, letter_to_name = await roles.run_roles(
                client, question, task, user_drafts, guard_report, lang, lang_full, deep, run_code, errors, mode=mode, web_research=web_research,
                topics=topics,
            )
            warnings += extras.get("warnings", [])
            return _pack(
                answer, task, user_drafts, panel_drafts, errors, [], t0, debug, 0,
                trace=trace, warnings=warnings, guard_report=guard_report, letter_to_name=letter_to_name,
                engine="roles", extras=extras, style=extras["style"], rec=rec,
            )

        if style not in ("solve", "explain"):
            style = prompts.answer_style(question, task) if (config.EXPLAIN_STYLE and engine == "verified") else "solve"

        # [1] drafts written by our own panel
        panel_drafts: dict[str, str] = {}
        if source in ("auto", "hybrid"):
            panel = config.PANEL if deep else config.PANEL[:3]
            config.emit(f"{len(panel)} models se draft likhwa raha hu")
            results = await asyncio.gather(
                *[_ask_member(client, s, question, task, lang_full) for s in panel]
            )
            panel_drafts = {label: text for label, text, err in results if text}
            errors.update({label: err for label, text, err in results if err})

        all_drafts = dict(user_drafts)
        for label, text in panel_drafts.items():
            all_drafts[_unique(label, all_drafts)] = text

        panel_failed = source == "auto" and len(panel_drafts) < config.MIN_PANEL_SUCCESS
        if panel_failed or not all_drafts:
            health.set_stage("single")
            try:
                answer = await chat(
                    client,
                    config.SYNTHESIZER,
                    prompts.panel_messages(question, "step_solver", task, lang_full),
                    max_tokens=config.FINAL_MAX_TOKENS,
                )
            except LLMError as e:
                raise RuntimeError(f"Not enough models responded. Errors: {errors} | {e}")
            return _pack(
                answer, task, {}, {}, errors, [], t0, debug, 0, trace=trace, warnings=warnings,
                guard_report=guard_report, fallback=True, style=style, rec=rec,
            )

        # [2] anonymise (A, B, C...) and shuffle: judges see no brand names and no fixed order
        items = list(all_drafts.items())
        random.shuffle(items)
        letters = string.ascii_uppercase
        anon = {letters[i]: text for i, (_, text) in enumerate(items)}
        letter_to_name = {letters[i]: name for i, (name, _) in enumerate(items)}
        flagged = {l for l, n in letter_to_name.items() if guard_report.get(n, {}).get("flagged")}

        # [3] engine
        if engine == "verified":
            answer, extras = await verified.run_verified(
                client, question, task, anon, lang, deep, run_code, errors, flagged,
                style=style, judge_hint=lang_full,
            )
            warnings += extras.get("warnings", [])
            return _pack(
                answer, task, user_drafts, panel_drafts, errors, [], t0, debug, 0,
                trace=trace, warnings=warnings, guard_report=guard_report,
                letter_to_name=letter_to_name, engine="verified", extras=extras, style=style, rec=rec,
            )

        # engine == "simple": plain debate + synthesis
        transcript: list[dict[str, str]] = []
        if rounds > 0:
            transcript, debate_errors = await _debate(client, question, anon, rounds, lang, deep)
            errors.update(debate_errors)
        debate_text = _format_debate(transcript)

        synth_args = (question, anon, debate_text, lang_full)
        health.set_stage("synth")
        try:
            answer = await chat(
                client, config.SYNTHESIZER, prompts.synth_messages(*synth_args),
                temperature=0.3, max_tokens=config.FINAL_MAX_TOKENS,
            )
        except LLMError as e:
            errors["synthesizer"] = str(e)
            answer = max(all_drafts.values(), key=len)
            warnings.append("Final synthesis failed: returned the longest draft (unverified).")

    return _pack(
        answer, task, user_drafts, panel_drafts, errors, transcript, t0, debug, len(transcript),
        trace=trace, warnings=warnings, guard_report=guard_report, letter_to_name=letter_to_name, style=style, rec=rec,
    )


MAX_CALLS = 60


def _compact_calls(trace: list) -> list[dict]:
    """Small, UI-friendly view of the model trace: one row per role call, with what failed on the way."""
    out = []
    for e in (trace or [])[:MAX_CALLS]:
        if e.get("stage") == "guard":
            continue
        row = {"stage": e.get("stage") or "", "model": e.get("used") or e.get("asked") or "",
               "ok": bool(e.get("ok")), "secs": e.get("secs")}
        if e.get("asked") and e.get("asked") != e.get("used"):
            row["asked"] = e["asked"]
        fails = [f"{k}: {v}" for k, v in (e.get("skips") or {}).items()]
        if fails:
            row["fails"] = fails[-4:]
        out.append(row)
    return out


def _pack(
    answer, task, user_drafts, panel_drafts, errors, transcript, t0, debug, rounds_run, *,
    trace, warnings, guard_report, fallback=False, letter_to_name=None, engine="simple", extras=None,
    style="solve", rec=None,
) -> dict:
    out = {
        "answer": answer,
        "engine": engine,
        "task_type": task,
        "style": style,
        "user_answers_used": len(user_drafts),
        "panel_answers_used": len(panel_drafts),
        "debate_rounds_run": rounds_run,
        "latency_s": round(time.perf_counter() - t0, 2),
        "models_used": health.summarize(trace),  # which model actually answered, and how often
        "calls": _compact_calls(trace),  # stage -> model, fail reasons (the UI's "model calls" panel)
    }
    if extras:
        out["proofs_summary"] = extras["proofs_summary"]
        if extras.get("falsifier_notes"):
            out["falsifier_notes"] = extras["falsifier_notes"]
        out["repairs"] = extras.get("repairs", 0)
        out["audit"] = extras.get("audit")
        if extras.get("master"):
            out["master"] = extras["master"]
        for k in ("sources", "confidence", "mode", "role_notes", "quota", "combo", "parts", "topics"):
            if extras.get(k):
                out[k] = extras[k]
    if rec is not None:
        out["council"] = council.build(
            question=rec["question"], trace=trace, user_drafts=user_drafts, panel_drafts=panel_drafts,
            letter_to_name=letter_to_name, extras=extras, guard_report=guard_report, errors=errors,
            warnings=warnings, final=answer,
            setup={"task": task, "style": style, "engine": engine, "source": rec["source"],
                   "mode": "deep" if rec["deep"] else "fast", "depth": rec["depth"], "reply_lang": rec["reply_lang"],
                   "latency_s": out["latency_s"], "user_answers": len(user_drafts), "panel_answers": len(panel_drafts),
                   "ui_mode": rec.get("ui_mode"), "role_mode": (extras or {}).get("mode"),
                   "confidence": (extras or {}).get("confidence"),
                   "fallback": bool(fallback)},
        )
    if guard_report:
        out["guard"] = guard_report
    if warnings:
        out["warnings"] = warnings
    if fallback:
        out["note"] = "Panel failed; answered by a single model."
    if debug:
        out["debug"] = {
            "user_drafts": user_drafts,
            "panel_drafts": panel_drafts,
            "draft_letters": letter_to_name or {},
            "debate": transcript,
            "errors": errors,
            "model_trace": trace,  # asked -> used (shows every fail-over)
            "usage": health.snapshot(),
        }
        if extras:
            out["debug"].update(extras["debug"])
    return out
