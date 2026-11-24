"""Roles engine: the 11 role prompts from adarsh-role-prompts.md, run in the suggested order.

  [A] Architect            plan of the answer (+ SEARCH queries for the research step)
  [R] Research             web lookup (Wikipedia; Tavily if a key is set) -> <sources> [S1].. for everyone below
  [B] Drafters (parallel)  Theorist + Empiricist (fast) + one mode specialist (deep)
  [C] (parallel)           Tone-stripper (claims map) + Skeptic (3 weakest points) + Pattern Finder (deep)
  [D] Falsifiers           attack only FACTUAL claims (fast 2, deep 3), Skeptic's doubts included as leads
  [E] (parallel)           Debater (only if drafts clash on a fact or a claim broke; fast 1 round, deep 2)
                           + Python code proofs (math / science / coding, not on Android)
  [F] Judge                ONE final answer, fixed headings per mode, CONFIDENCE line
  [G] Reviewers            Methodology + Evidence (deep both; fast one, picked by mode)
  [H] Refiner              only if a reviewer found a high/medium problem; a rewrite that loses sections is dropped
  + contract linter / format repair from verified.py (no [PROVEN by code] without a PASS proof, headings checked)

Manual mode (pasted answers only) still goes to master.py. Hybrid: your pasted answers join the drafts.
Never raises: every stage that fails is skipped and reported in errors / warnings.
"""
import asyncio
import json
import random
import re
import string
import time

import bigtask
import config
import health
import mode_plans
import prompts
import research
import role_prompts as RP
import verified
from llm import LLMError, chat

UI_MODES = {"v": "verified", "standard": "standard", "physics": "physics", "math": "math",
            "business": "business", "coding": "coding", "verified": "verified"}
TASK_MODE = {"math": "math", "science": "physics", "coding": "coding", "business": "business", "research": "verified"}
DRAFT_TRIM = 1500  # chars per draft shown to the skeptic / pattern finder (Groq: 8K tokens/min)


def resolve_mode(ui_mode: str | None, task: str) -> str:
    """The selected UI mode always wins, including Standard. Task classification never switches it."""
    return UI_MODES.get((ui_mode or "standard").strip().lower(), "standard")


def _m(system: str, user: str) -> list[dict]:
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _cut(text: str, n: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[:n].rstrip() + " …(trimmed)"


async def _call(client, stage, spec, messages, errors, *, max_tokens=None, temperature=0.3, emit_start=None):
    """One role call with its own stage name (for the council record). Returns text or None."""
    health.set_stage(stage)
    if emit_start:
        config.emit(emit_start)
    t0 = time.perf_counter()
    try:
        out = await asyncio.wait_for(
            chat(client, spec, messages, temperature=temperature, max_tokens=max_tokens or config.ROLE_MAX_TOKENS),
            timeout=config.PANEL_TIMEOUT_S,
        )
    except (LLMError, asyncio.TimeoutError) as e:
        errors[stage] = str(e) or "timeout"
        return None
    out = (out or "").strip()
    if not out:
        errors[stage] = "empty answer"
        return None
    call = health.last_call(stage) or {}
    health_used = call.get("used", spec.label)
    config.emit(f"{_title(stage)}: ho gaya ({health_used}, {time.perf_counter() - t0:.0f}s)")
    return out


async def _judge_parts(client, spec, judge_sys, judge_user, groups, topics, errors, *, first=1, total=None):
    """Write a long answer as Part k/N: one Judge call per group of sub-topics, one after another (rate-limit
    friendly, small pause between parts). Each finished part goes to the chat at once (config.emit_part)."""
    total = total or len(groups)
    out: list[str] = []
    for k, group in enumerate(groups, first):
        names = "; ".join(f"{i}. {topics[i - 1]['title']}" for i in group)
        last = k == total
        rule = (f"\n\n[LONG ANSWER IN {total} PARTS] Write ONLY Part {k}/{total}, covering these sub-topics: {names}. "
                f"Start with the line '**Part {k}/{total}**'. Give each sub-topic its own heading '## <number>. <title>'. "
                "Do not write the other sub-topics: they are separate parts. "
                + ("This is the last part: end with the overall sections the format asks for and the CONFIDENCE line."
                   if last else "Not the last part: no closing summary and no CONFIDENCE line here."))
        if k > first:
            await asyncio.sleep(bigtask.PART_GAP_S)
        text = await _call(client, f"judge:part{k}", spec, _m(judge_sys, judge_user + rule), errors,
                           max_tokens=config.FINAL_MAX_TOKENS, temperature=0.2,
                           emit_start=f"Judge: Part {k}/{total} likh raha hai")
        if text is None:
            text = f"**Part {k}/{total}**\n\n*Is part ka jawab nahi aa paya ({names}). Dobara try karke yeh topics maangiye.*"
        elif not text.lstrip().startswith(f"**Part {k}/{total}**"):
            text = f"**Part {k}/{total}**\n\n" + text
        out.append(text)
        config.emit_part({"n": k, "of": total, "text": text})
    return out


def _title(stage: str) -> str:
    kind, _, rest = stage.partition(":")
    if kind == "panel":
        return prompts.ROLE_INFO.get(rest, (rest,))[0]
    return {"architect": "Architect", "skeptic": "Skeptic", "refine": "Refiner", "judge": "Judge",
            "review": {"method": "Methodology reviewer", "evidence": "Evidence reviewer"}.get(rest, "Reviewer"),
            "debate": f"Debater {rest}", "falsifier": f"Falsifier {rest}"}.get(kind, stage) + (
        f" {rest.replace('part', 'Part ')}" if kind == "judge" and rest else "")


def _drafter_system(role: str, spec_role: str, mode: str, hint: str, has_sources: bool) -> str:
    if role in RP.ROLE_PROMPTS:
        return RP.system_for(role, mode, writer_hint=hint, sources=has_sources)
    # mode specialist: one of the older panel styles (prompts.ROLES), wrapped in the same COMMON rules
    title = prompts.ROLE_INFO.get(spec_role, (spec_role,))[0]
    parts = [RP.COMMON, RP.MODE_HINTS[mode]]
    if has_sources:
        parts.append(RP.SOURCES_RULE.format(today=RP.today()))
    parts += [f"ROLE: {title} (specialist). {prompts.ROLES[spec_role]}", hint]
    return "\n\n".join(p.strip() for p in parts if p and p.strip())


def _context_blocks(question: str, plan: str | None, sources_text: str) -> str:
    parts = [f"Question:\n{question}"]
    if plan:
        parts.append(RP.tag("plan", plan))
    if sources_text:
        parts.append(RP.tag("sources", sources_text))
    return "\n\n".join(parts)


def _drafts_block(anon: dict[str, str], limit: int = DRAFT_TRIM) -> str:
    return RP.tag("drafts", "\n\n".join(f"### Draft {k}\n{_cut(v, limit)}" for k, v in anon.items()))


# ------------------------------------------------------------------ parsers

_METHOD_LINE = re.compile(
    r"step\s*([^|\n]*?)\s*\|\s*problem\s*:\s*(.+?)\s*\|\s*fix\s*:\s*(.+?)\s*\|\s*severity\s*:\s*(high|medium|low)", re.I)


def parse_method(text: str | None) -> dict:
    if not text:
        return {"ran": False, "verdict": "", "issues": []}
    m = re.search(r"VERDICT\s*:\s*(PASS|FIX)", text, re.I)
    verdict = m.group(1).upper() if m else ("PASS" if re.match(r"\W*PASS\b", text, re.I) else "FIX")
    issues = []
    for step, problem, fix, sev in _METHOD_LINE.findall(text):
        issues.append({"quote": f"step {step.strip()}".strip(), "problem": problem.strip()[:400], "fix": fix.strip()[:400],
                       "confidence": sev.lower(), "by": "methodology", "kind": "method"})
    if verdict == "PASS":
        issues = []  # a PASS verdict carries no fixes
    return {"ran": True, "verdict": verdict, "issues": issues[: config.AUDIT_MAX_ISSUES]}


def parse_evidence(text: str | None, answer: str) -> dict:
    data = verified._extract_json(text) if text else None
    if not isinstance(data, dict) or not isinstance(data.get("issues"), list):
        return {"ran": False, "issues": []}
    haystack, issues = verified._norm(answer), []
    for it in data["issues"][: config.AUDIT_MAX_ISSUES]:
        if not isinstance(it, dict):
            continue
        quote, problem, fix = (str(it.get(k) or "").strip() for k in ("quote", "problem", "fix"))
        conf = str(it.get("confidence") or "low").strip().lower()
        if not (problem and fix):
            continue
        conf = conf if conf in ("high", "medium", "low") else "low"
        nq = verified._norm(quote)[:80]
        if conf != "low" and (not nq or nq not in haystack):
            conf = "low"  # the quote is not in the answer: maybe invented, so never acted on
        issues.append({"quote": quote[:300], "problem": problem[:400], "fix": fix[:400], "confidence": conf,
                       "by": "evidence", "kind": str(it.get("kind") or "unsupported")[:20]})
    return {"ran": True, "issues": issues}


def parse_refiner(text: str | None) -> tuple[str | None, list[str], list[str]]:
    """REVISED / CHANGES / SKIPPED blocks -> (revised text, changes, skipped)."""
    if not text:
        return None, [], []
    m = re.search(r"(?is)^\W*REVISED\s*:?\s*\n(.*?)(?=^\W*CHANGES\s*:|^\W*SKIPPED\s*:|\Z)", text, re.M)
    revised = m.group(1).strip() if m else None

    def items(name):
        b = re.search(rf"(?is)^\W*{name}\s*:\s*\n?(.*?)(?=^\W*(?:CHANGES|SKIPPED)\s*:|\Z)", text, re.M)
        if not b:
            return []
        return [ln.strip(" -*\t") for ln in b.group(1).splitlines() if ln.strip(" -*\t") and ln.strip(" -*\t").lower() != "none"]

    return revised, items("CHANGES"), items("SKIPPED")


def parse_confidence(answer: str) -> str:
    m = re.search(r"CONFIDENCE\s*:\s*\**\s*(high|medium|low)", answer, re.I)
    return m.group(1).lower() if m else ""


def needs_debate(claim_map: dict | None, reports: dict[str, str]) -> bool:
    factual = [c for c in (claim_map or {}).get("conflicts", []) if c.get("kind", "factual") == "factual"]
    broke = any(re.search(r"RESULT\s*:\s*\**\s*(BROKEN|WEAKENED)", t, re.I) for t in reports.values())
    return bool(factual) or broke


def debate_unresolved(text: str) -> bool:
    return bool(re.search(r"\b(partly|falls)\b", text or "", re.I))


def cited_sources(answer: str, sources: list[dict]) -> list[dict]:
    used = {int(n) for n in verified.SOURCE_CITATION_RE.findall(answer)}
    return [s for s in sources if s["n"] in used]


def strip_bad_cites(answer: str, sources: list[dict]) -> str:
    """[S7] when only 3 sources exist is an invented citation: remove it."""
    ok = {s["n"] for s in sources}
    return verified.SOURCE_CITATION_RE.sub(
        lambda m: m.group(0) if int(m.group(1)) in ok else "", answer
    ).rstrip()


# ------------------------------------------------------------------ entry point

async def run_roles(client, question, task, user_drafts, guard_report, lang, lang_full, deep, run_code, errors, *,
                    mode="standard", web_research=True, topics=None):
    """Returns (answer, extras, panel_drafts, letter_to_name).
    topics = sub-topic map of a big message (bigtask.decompose): the Judge answers every sub-topic under its own
    heading; 4+ sub-topics are written as Part 1/N, 2/N ... (one Judge call each, sent to the chat as they finish)."""
    mode = resolve_mode(mode, task)
    fmt = "coding" if mode == "coding" else "standard"
    style = f"roles:{fmt}"
    warnings: list[str] = []
    notes: list[dict] = []
    # every mode has its OWN model combination + behaviour (mode_plans.py)
    mp = mode_plans.get(mode)
    pol = mp.policy
    chk = pol.checks
    asked_deep = deep
    if pol.depth == "deep" and not deep:
        deep = True
    combo = mode_plans.describe(mode)
    roles_dbg: dict = {"mode": mode, "format": fmt, "combo": combo}
    config.emit(f"Mode {mp.title}: apna model combo (judge {mp.spec('judge').label}, "
                f"drafters {mp.spec('theorist').label} + {mp.spec('empiricist').label})"
                + (" · deep zaroori" if deep and not asked_deep else ""))
    # [Q] Quota: when today's free quota is running out, save calls on our own instead of hitting 429s
    review_on, debate_on = config.REVIEW_ENABLED, config.DEBATE_ENABLED
    quota = {"level": "ok", "left": 1.0, "asked": "deep" if deep else "fast", "saved": []}
    if config.QUOTA_AUTO:
        quota["level"], quota["left"] = health.pressure(quota_chains(mode))
        if quota["level"] != "ok" and deep:
            deep = False
            quota["saved"].append("deep -> fast (specialist, Pattern Finder, 3rd falsifier, 2nd debate round, 2nd reviewer band)")
        if quota["level"] == "low":
            if debate_on:
                debate_on = False
                quota["saved"].append("Debater band")
            if review_on:
                review_on = False
                quota["saved"].append("Reviewers + Refiner band")
        if quota["saved"]:
            pct = int(round(quota["left"] * 100))
            msg = f"Quota kam hai (~{pct}% bacha): " + ", ".join(quota["saved"]) + ". Judge ke liye quota bachaya gaya."
            config.emit(msg)
            warnings.append(msg)
    roles_dbg["quota"] = quota
    saver = quota["level"] != "ok"  # quota is short: the "always" extras of a mode are dropped, the judge is kept

    # [A] Architect
    plan = await _call(
        client, "architect", mp.spec("architect"),
        _m(RP.system_for("architect", mode, writer_hint=lang, extra=RP.ENGINE_EXTRA["architect"]), f"Question:\n{question}"),
        errors, temperature=0.2, emit_start="Architect: jawab ka dhancha bana raha hai",
    )
    roles_dbg["plan"] = plan

    # [R] Research
    sources: list[dict] = []
    queries = []
    if not web_research:
        warnings.append("Private app/chat context used: web searches disabled for this answer.")
    if web_research and config.RESEARCH_ENABLED and pol.research != "off":
        queries = research.queries_from_plan(plan, question)
        if not queries and pol.research == "must":  # Architect said SEARCH: none, but this mode always checks the web
            queries = research.queries_from_plan(None, question)
    if queries:
        config.emit("Research: web par dhoondh raha hu (" + " | ".join(queries) + ")")
        t0 = time.perf_counter()
        sources = await research.gather(client, queries, max_sources=pol.max_sources)
        config.emit(f"Research: {len(sources)} source mile ({time.perf_counter() - t0:.0f}s)" if sources
                    else "Research: koi kaam ka source nahi mila, sirf models ki jaankari se chalenge")
    roles_dbg["queries"], roles_dbg["sources"] = queries, sources
    has_src = bool(sources)
    src_text = research.format_sources(sources) if has_src else ""
    ctx = _context_blocks(question, plan, src_text)
    plan_note = "" if plan else "\n(No plan: the Architect failed. Work from the question.)"

    # [B] Drafters
    drafters = [("theorist", mp.spec("theorist")), ("empiricist", mp.spec("empiricist"))]
    if deep or (pol.specialist == "always" and not saver):
        spec = mp.spec("specialist")
        drafters.append((spec.role, spec))
    config.emit(f"{len(drafters)} roles draft likh rahe hain: " + ", ".join(prompts.ROLE_INFO.get(r, (r,))[0] for r, _ in drafters))
    outs = await asyncio.gather(*[
        _call(client, f"panel:{role}", spec,
              _m(_drafter_system(role, spec.role, mode, lang_full, has_src), ctx + plan_note),
              errors, max_tokens=config.PANEL_MAX_TOKENS, temperature=pol.draft_temp)
        for role, spec in drafters
    ])
    panel_drafts = {role: text for (role, _), text in zip(drafters, outs, strict=False) if text}

    all_drafts = dict(user_drafts)
    for label, text in panel_drafts.items():
        all_drafts[label if label not in all_drafts else f"{label} (2)"] = text
    items = list(all_drafts.items())
    random.shuffle(items)
    anon = {string.ascii_uppercase[i]: text for i, (_, text) in enumerate(items)}
    letter_to_name = {string.ascii_uppercase[i]: name for i, (name, _) in enumerate(items)}
    flagged = {l for l, n in letter_to_name.items() if (guard_report or {}).get(n, {}).get("flagged")}

    claim_map, skeptic, pattern, reports, debate, proofs = None, None, None, {}, [], []
    use_pattern = deep or (pol.pattern == "always" and not saver)
    if anon:
        # [C] claims map + Skeptic + Pattern Finder, in parallel
        config.emit("Claims map, Skeptic" + (" aur Pattern Finder" if use_pattern else "") + " chal rahe hain")
        drafts_tag = _drafts_block(anon)
        jobs = [
            verified.strip_to_claims(client, question, anon, flagged),
            _call(client, "skeptic", mp.spec("skeptic"),
                  _m(RP.system_for("skeptic", mode, writer_hint=lang, sources=has_src, extra=chk.get("skeptic", "")),
                     f"Question:\n{question}\n\n{drafts_tag}"),
                  errors, temperature=0.3),
        ]
        if use_pattern:
            pf = mp.spec("pattern")
            jobs.append(_call(client, "panel:pattern_finder", pf,
                              _m(RP.system_for("pattern_finder", mode, writer_hint=lang_full, sources=has_src),
                                 f"{ctx}\n\n{drafts_tag}"),
                              errors, max_tokens=config.PANEL_MAX_TOKENS, temperature=0.4))
        res = await asyncio.gather(*jobs)
        claim_map, skeptic = res[0], res[1]
        pattern = res[2] if use_pattern else None
        if pattern:
            panel_drafts["pattern_finder"] = pattern  # council + provenance; not a claims-map draft (it came after)
        if claim_map:
            full_text, compact_text = verified.format_map(claim_map), verified.format_map(claim_map, compact=True)
        else:
            errors["tone_stripper"] = "failed, used raw drafts"
            full_text, compact_text = verified.format_raw(anon), verified.format_raw(anon, limit=1200)

        # [D] Falsifiers (only factual claims; skeptic's doubts as leads)
        leads = "\n\n" + RP.tag("reports", "## Skeptic doubts (leads, not facts)\n" + skeptic) if skeptic else ""
        n_fal = pol.falsifiers[1 if deep else 0]
        fal_specs = mp.falsifiers[: min(n_fal, 2) if saver else n_fal]
        config.emit(f"{len(fal_specs)} falsifiers claims todne ki koshish kar rahe hain")
        fal_outs = await asyncio.gather(*[
            _call(client, f"falsifier:{i}", spec,
                  _m(RP.system_for("falsifier", mode, writer_hint=lang, sources=has_src, extra=chk.get("falsifier", "")),
                     f"Question:\n{question}\n\n{RP.tag('claims', compact_text)}{leads}"
                     + (f"\n\n{RP.tag('sources', src_text)}" if has_src else "")),
                  errors, max_tokens=config.FALSIFIER_MAX_TOKENS, temperature=0.3)
            for i, spec in enumerate(fal_specs, 1)
        ])
        reports = {f"Falsifier {i}": t for i, t in enumerate(fal_outs, 1) if t}
        fals_text = "\n\n".join(f"#### {k}\n{v}" for k, v in reports.items()) or "No falsification report available."

        # [E] Debater (only where there is a real clash) + code proofs, in parallel
        async def run_debate():
            rounds = pol.debate_rounds[1 if deep else 0]
            position = f"Question:\n{question}\n\n{RP.tag('claims', compact_text)}\n\n{RP.tag('reports', _cut(fals_text, 2500))}"
            out = []
            for r in range(1, rounds + 1):
                extra = RP.ENGINE_EXTRA["debater_round2"] if r == 2 else ""
                user = position if r == 1 else position + "\n\n" + RP.tag("reports", "## Round 1\n" + out[-1])
                t = await _call(client, f"debate:{r}", mp.spec("debater"),
                                _m(RP.system_for("debater", mode, writer_hint=lang, extra=extra), user),
                                errors, temperature=0.4, emit_start=f"Debater round {r}: sabse mazboot ulta paksh")
                if not t:
                    break
                out.append(t)
                if not debate_unresolved(t):
                    break
            return out

        async def run_proofs():
            by_task = task in config.VERIFY_TASKS | {"science"}
            want = pol.code_proofs == "always" or (pol.code_proofs == "task" and by_task)
            if run_code and want and config.CODE_EXEC_SUPPORTED:
                config.emit("Python se claims check ho rahe hain")
                return await verified.verify_with_code(client, question, task, compact_text, fals_text, errors,
                                                       spec=mp.spec("verifier"))
            return []

        do_debate = debate_on and pol.debate != "off" and (pol.debate == "always" and not saver or needs_debate(claim_map, reports))
        debate, proofs = await asyncio.gather(run_debate() if do_debate else asyncio.sleep(0, result=[]), run_proofs())
        roles_dbg["debate_skipped"] = (None if do_debate else "quota bachane ke liye band" if not debate_on and config.DEBATE_ENABLED
                                       else "band hai (DEBATE=0)" if not debate_on
                                       else f"{mp.title} mode me debate band hai" if pol.debate == "off"
                                       else "drafts me factual takraav nahi tha, koi claim nahi toota")
    else:
        full_text = compact_text = "(no drafts: every drafter failed)"
        fals_text = "No falsification report available."
        warnings.append("Koi draft nahi mila (sab drafters fail). Judge ne seedhe sawaal se jawab likha, isliye kam jaancha gaya hai.")

    roles_dbg.update({"skeptic": skeptic, "pattern": pattern, "debate": debate})

    # [F] Judge
    report_parts = []
    if skeptic:
        report_parts.append("## Skeptic\n" + skeptic)
    if pattern:
        report_parts.append("## Pattern Finder\n" + _cut(pattern, 2000))
    report_parts.append("## Falsifiers\n" + fals_text)
    for i, d in enumerate(debate, 1):
        report_parts.append(f"## Debater round {i}\n" + d)
    proofs_text = verified.format_proofs(proofs) if proofs else ""
    judge_rules = [RP.JUDGE_FORMAT[fmt]] + ([chk["judge"]] if chk.get("judge") else [])
    if proofs:
        judge_rules.insert(0, RP.ENGINE_EXTRA["judge_proofs"])
    if has_src:
        judge_rules.insert(0, RP.ENGINE_EXTRA["judge_sources"])
    judge_sys = RP.system_for("judge", mode, writer_hint=lang_full, sources=has_src, extra="\n".join(judge_rules))
    judge_user = "\n\n".join(p for p in [
        ctx,
        RP.tag("claims", full_text),
        RP.tag("reports", "\n\n".join(report_parts)),
        RP.tag("reports", "## Executable proofs (Python sandbox)\n" + proofs_text) if proofs_text else "",
    ] if p)
    judge_msgs = _m(judge_sys, judge_user)
    groups = bigtask.plan_parts(topics)
    parts: list[str] = []
    if groups:  # big answer: one Judge call per part, each part delivered as soon as it is written
        parts = await _judge_parts(client, mp.spec("judge"), judge_sys, judge_user, groups, topics, errors)
        failed = [p for p in parts if p.split("\n\n", 1)[-1].startswith("*Is part ka jawab nahi")]
        answer = "\n\n".join(parts) if len(failed) < len(parts) else None
        if failed and answer:
            warnings.append(f"{len(failed)} part(s) ka jawab nahi aa paya; unke topics dobara maangiye.")
    else:
        answer = await _call(client, "judge", mp.spec("judge"), judge_msgs, errors,
                             max_tokens=config.FINAL_MAX_TOKENS, temperature=0.2, emit_start="Judge: ek final jawab likh raha hai")
    judge_raw = answer
    repair_log: list[dict] = []
    audit_texts: dict = {}
    repairs = 0
    audit = {"enabled": review_on, "ran": False, "issues": [], "applied": [], "unsure": [], "label": "Reviewers"}
    reviews: dict = {}
    refiner_dbg: dict = {}
    if answer is None:
        answer = max(anon.values(), key=len) if anon else "Abhi koi model jawab nahi de paya. Thodi der baad dobara try karo."
        warnings.append("Judge fail hua: sabse lamba draft dikhaya gaya (bina jaanch ke).")
        parts = []
    elif parts:
        parts = [verified.lint_answer(p, proofs, style)[0] for p in parts]  # tag honesty per part
        answer = "\n\n".join(parts)
        _, lint = verified.lint_answer(answer, proofs, style)  # section check on the whole answer
    else:
        answer, lint, repairs = await verified.enforce_format(client, judge_msgs, answer, proofs, style, errors, repair_log)
        if topics:  # coverage check: a sub-topic the Judge skipped (or lost to the token limit) gets its own part
            missing = bigtask.missing_topics(answer, list(range(1, len(topics) + 1)))
            if missing:
                config.emit_part({"n": 1, "of": 2, "text": "**Part 1/2**\n\n" + answer})
                extra = await _judge_parts(client, mp.spec("judge"), judge_sys, judge_user, [missing], topics, errors,
                                           first=2, total=2)
                if extra and extra[0] and not extra[0].startswith("**Part 2/2**\n\n*Is part"):
                    parts = ["**Part 1/2**\n\n" + answer, verified.lint_answer(extra[0], proofs, style)[0]]
                    answer = "\n\n".join(parts)

    if answer is not None and (parts or judge_raw is not None):
        # [G] Reviewers (a parted answer: reviewed once as a whole, problems shown as notes; no rewrite of parts)
        if review_on and (parts or not verified.missing_sections(answer, style)):
            wanted = pol.reviewers_deep if deep else pol.reviewers_fast
            want_method, want_evidence = "method" in wanted, "evidence" in wanted
            config.emit("Reviewers: tareeka aur saboot jaanch rahe hain")
            review_text = _cut(answer, 14000) if parts else answer  # a very long parted answer: first 14k chars
            material = "\n\n".join(p for p in [RP.tag("sources", src_text) if has_src else "",
                                               RP.tag("claims", compact_text)] if p)
            jobs = []
            if want_method:
                jobs.append(_call(client, "review:method", mp.spec("method"),
                                  _m(RP.system_for("method_reviewer", mode, writer_hint=lang, extra=chk.get("method", "")),
                                     f"Question:\n{question}\n\n{RP.tag('draft', review_text)}"
                                     + (f"\n\n{RP.tag('reports', 'Code proofs: ' + json.dumps(verified_summary(proofs)))}" if proofs else "")),
                                  errors, temperature=0.1))
            if want_evidence:
                jobs.append(_call(client, "review:evidence", mp.spec("evidence"),
                                  _m(RP.system_for("evidence_reviewer", mode, writer_hint=lang, sources=has_src,
                                                   extra=chk.get("evidence", "")),
                                     f"Question:\n{question}\n\n{RP.tag('draft', review_text)}\n\nMaterial the answer was built from:\n{material}"),
                                  errors, temperature=0.1))
            outs = await asyncio.gather(*jobs)
            it = iter(outs)
            method_raw = next(it) if want_method else None
            evid_raw = next(it) if want_evidence else None
            method = parse_method(method_raw) if want_method else {"ran": False, "issues": []}
            evid = parse_evidence(evid_raw, answer) if want_evidence else {"ran": False, "issues": []}
            reviews = {"method": method, "evidence": evid}
            issues = method["issues"] + evid["issues"]
            audit["ran"] = method["ran"] or evid["ran"]
            audit["issues"] = issues
            if want_evidence and evid_raw and not evid["ran"]:
                errors["review:evidence"] = "unreadable output"
            actionable = [i for i in issues if i["confidence"] in ("high", "medium")]
            config.emit(f"Reviewers: {len(actionable)} sudhaar layak, {len(issues) - len(actionable)} halki shak" if issues
                        else "Reviewers: koi galti nahi mili")

            # [H] Refiner
            if actionable and not parts:  # parts already reached the chat: problems become notes, no rewrite
                crit = "\n".join(f"{n}. [{i['by']}] \"{i['quote']}\" | problem: {i['problem']} | fix: {i['fix']}"
                                 for n, i in enumerate(actionable, 1))
                crit_block = RP.tag("critiques", crit)
                ref_msgs = _m(
                    RP.system_for("refiner", mode, writer_hint=lang_full, sources=has_src),
                    f"Question:\n{question}\n\n{RP.tag('draft', answer)}\n\n{crit_block}\n\n"
                    "Keep the CONFIDENCE line (lower it if a critique shows a real error). A changed step loses "
                    "[PROVEN by code] and becomes [REASONED].",
                )
                raw = await _call(client, "refine", mp.spec("refiner"), ref_msgs, errors,
                                  max_tokens=config.FINAL_MAX_TOKENS, temperature=0.1, emit_start="Refiner: galtiyan sudhar raha hai")
                revised, changes, skipped = parse_refiner(raw)
                refiner_dbg = {"changes": changes, "skipped": skipped, "raw_ok": bool(revised)}
                if revised:
                    audit_texts["before"] = answer
                    # no repair here: re-asking the judge would bring back the old text and hide that the fix was lost
                    r_answer, r_lint = verified.lint_answer(revised, proofs, style)
                    if not verified.missing_sections(r_answer, style):
                        answer, lint = r_answer, r_lint
                        audit["applied"] = actionable
                        audit_texts["after"] = answer
                    else:
                        audit_texts["discarded"] = r_answer
                elif raw:
                    errors["refine"] = "no REVISED block in the output"
            applied = {id(i) for i in audit["applied"]}
            audit["unsure"] = [i for i in issues if id(i) not in applied]
        warnings += lint

    if has_src:
        answer = strip_bad_cites(answer, sources)
        parts = [strip_bad_cites(p, sources) for p in parts]
    confidence = parse_confidence(answer)
    if pol.low_conf_warn and confidence == "low":
        warnings.append(f"{mp.title} mode: is jawab ki CONFIDENCE low hai. Isko pakka fact mat maano; sources khud check karo.")
    roles_dbg.update({"reviews": reviews, "refiner": refiner_dbg, "confidence": confidence})

    if skeptic:
        notes.append({"title": "Skeptic ke shak", "text": verified._trim(skeptic, 900)})
    for i, d in enumerate(debate, 1):
        m = re.search(r"(?is)AFTER THIS ROUND\s*:\s*(.+)$", d)
        notes.append({"title": f"Debate round {i}", "text": verified._trim((m.group(1) if m else d).strip(), 600)})

    summary = verified_summary(proofs)
    extras = {
        "proofs_summary": summary,
        "falsifier_notes": verified.falsifier_notes(reports),
        "role_notes": notes,
        "repairs": repairs,
        "audit": audit,
        "warnings": warnings,
        "style": style,
        "mode": mode,
        "confidence": confidence,
        "sources": sources,
        "quota": quota,
        "combo": combo,
        "parts": parts,
        "topics": [t["title"] for t in topics or []],
        "debug": {
            "claims_map": claim_map,
            "falsification": reports,
            "proofs": proofs,
            "judge_raw": judge_raw,
            "repair_log": repair_log,
            "audit_texts": audit_texts,
            "roles": roles_dbg,
        },
    }
    return answer, extras, panel_drafts, letter_to_name


def quota_chains(mode: str = "standard") -> list:
    """The role chains one question in this mode leans on (first model of each = where the load goes)."""
    mp = mode_plans.get(mode)
    n = mp.policy.falsifiers[0]
    roles_used = ["architect", "theorist", "empiricist", "skeptic", "debater", "judge", "method", "evidence", "refiner"]
    if mp.policy.specialist == "always":
        roles_used.append("specialist")
    if mp.policy.pattern == "always":
        roles_used.append("pattern")
    return [mp.spec(r) for r in roles_used] + list(mp.falsifiers[:n])


def verified_summary(proofs: list[dict]) -> dict:
    summary = {"total": len(proofs)}
    for s in ("PASS", "FAIL", "ERROR", "TIMEOUT", "REJECTED", "UNCLEAR", "UNSUPPORTED"):
        n = sum(1 for p in proofs if p["status"] == s)
        if n:
            summary[s.lower()] = n
    return summary
