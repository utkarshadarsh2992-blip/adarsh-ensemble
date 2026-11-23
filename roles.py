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

import config
import health
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
    """The UI mode wins; 'standard' (or nothing) lets the task type pick a sharper mode hint."""
    m = UI_MODES.get((ui_mode or "").strip().lower(), "standard")
    return m if m != "standard" else TASK_MODE.get(task, "standard")


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


def _title(stage: str) -> str:
    kind, _, rest = stage.partition(":")
    if kind == "panel":
        return prompts.ROLE_INFO.get(rest, (rest,))[0]
    return {"architect": "Architect", "skeptic": "Skeptic", "refine": "Refiner", "judge": "Judge",
            "review": {"method": "Methodology reviewer", "evidence": "Evidence reviewer"}.get(rest, "Reviewer"),
            "debate": f"Debater {rest}", "falsifier": f"Falsifier {rest}"}.get(kind, stage)


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
    used = {int(n) for n in re.findall(r"\[S(\d+)", answer)}
    return [s for s in sources if s["n"] in used]


def strip_bad_cites(answer: str, sources: list[dict]) -> str:
    """[S7] when only 3 sources exist is an invented citation: remove it."""
    ok = {s["n"] for s in sources}
    return re.sub(r"\s?\[S(\d+)\]", lambda m: m.group(0) if int(m.group(1)) in ok else "", answer)


# ------------------------------------------------------------------ entry point

async def run_roles(client, question, task, user_drafts, guard_report, lang, lang_full, deep, run_code, errors, *,
                    mode="standard"):
    """Returns (answer, extras, panel_drafts, letter_to_name)."""
    mode = resolve_mode(mode, task)
    fmt = "coding" if mode == "coding" else "standard"
    style = f"roles:{fmt}"
    warnings: list[str] = []
    notes: list[dict] = []
    roles_dbg: dict = {"mode": mode, "format": fmt}

    # [A] Architect
    plan = await _call(
        client, "architect", config.ARCHITECT,
        _m(RP.system_for("architect", mode, writer_hint=lang, extra=RP.ENGINE_EXTRA["architect"]), f"Question:\n{question}"),
        errors, temperature=0.2, emit_start="Architect: jawab ka dhancha bana raha hai",
    )
    roles_dbg["plan"] = plan

    # [R] Research
    sources: list[dict] = []
    queries = research.queries_from_plan(plan, question) if config.RESEARCH_ENABLED else []
    if queries:
        config.emit("Research: web par dhoondh raha hu (" + " | ".join(queries) + ")")
        t0 = time.perf_counter()
        sources = await research.gather(client, queries)
        config.emit(f"Research: {len(sources)} source mile ({time.perf_counter() - t0:.0f}s)" if sources
                    else "Research: koi kaam ka source nahi mila, sirf models ki jaankari se chalenge")
    roles_dbg["queries"], roles_dbg["sources"] = queries, sources
    has_src = bool(sources)
    src_text = research.format_sources(sources) if has_src else ""
    ctx = _context_blocks(question, plan, src_text)
    plan_note = "" if plan else "\n(No plan: the Architect failed. Work from the question.)"

    # [B] Drafters
    drafters = [("theorist", config.THEORIST), ("empiricist", config.EMPIRICIST)]
    if deep:
        spec = config.SPECIALISTS.get(mode, config.SPECIALISTS["standard"])
        drafters.append((spec.role, spec))
    config.emit(f"{len(drafters)} roles draft likh rahe hain: " + ", ".join(prompts.ROLE_INFO.get(r, (r,))[0] for r, _ in drafters))
    outs = await asyncio.gather(*[
        _call(client, f"panel:{role}", spec,
              _m(_drafter_system(role, spec.role, mode, lang_full, has_src), ctx + plan_note),
              errors, max_tokens=config.PANEL_MAX_TOKENS, temperature=0.5)
        for role, spec in drafters
    ])
    panel_drafts = {role: text for (role, _), text in zip(drafters, outs) if text}

    all_drafts = dict(user_drafts)
    for label, text in panel_drafts.items():
        all_drafts[label if label not in all_drafts else f"{label} (2)"] = text
    items = list(all_drafts.items())
    random.shuffle(items)
    anon = {string.ascii_uppercase[i]: text for i, (_, text) in enumerate(items)}
    letter_to_name = {string.ascii_uppercase[i]: name for i, (name, _) in enumerate(items)}
    flagged = {l for l, n in letter_to_name.items() if (guard_report or {}).get(n, {}).get("flagged")}

    claim_map, skeptic, pattern, reports, debate, proofs = None, None, None, {}, [], []
    if anon:
        # [C] claims map + Skeptic + Pattern Finder, in parallel
        config.emit("Claims map, Skeptic" + (" aur Pattern Finder" if deep else "") + " chal rahe hain")
        drafts_tag = _drafts_block(anon)
        jobs = [
            verified.strip_to_claims(client, question, anon, flagged),
            _call(client, "skeptic", config.SKEPTIC,
                  _m(RP.system_for("skeptic", mode, writer_hint=lang, sources=has_src), f"Question:\n{question}\n\n{drafts_tag}"),
                  errors, temperature=0.3),
        ]
        if deep:
            pf = config.PANEL[-1]
            jobs.append(_call(client, "panel:pattern_finder", pf,
                              _m(RP.system_for("pattern_finder", mode, writer_hint=lang_full, sources=has_src),
                                 f"{ctx}\n\n{drafts_tag}"),
                              errors, max_tokens=config.PANEL_MAX_TOKENS, temperature=0.4))
        res = await asyncio.gather(*jobs)
        claim_map, skeptic = res[0], res[1]
        pattern = res[2] if deep else None
        if pattern:
            panel_drafts["pattern_finder"] = pattern  # council + provenance; not a claims-map draft (it came after)
        if claim_map:
            full_text, compact_text = verified.format_map(claim_map), verified.format_map(claim_map, compact=True)
        else:
            errors["tone_stripper"] = "failed, used raw drafts"
            full_text, compact_text = verified.format_raw(anon), verified.format_raw(anon, limit=1200)

        # [D] Falsifiers (only factual claims; skeptic's doubts as leads)
        leads = "\n\n" + RP.tag("reports", "## Skeptic doubts (leads, not facts)\n" + skeptic) if skeptic else ""
        fal_specs = config.DEBATERS if deep else config.DEBATERS[:2]
        config.emit(f"{len(fal_specs)} falsifiers claims todne ki koshish kar rahe hain")
        fal_outs = await asyncio.gather(*[
            _call(client, f"falsifier:{i}", spec,
                  _m(RP.system_for("falsifier", mode, writer_hint=lang, sources=has_src),
                     f"Question:\n{question}\n\n{RP.tag('claims', compact_text)}{leads}"
                     + (f"\n\n{RP.tag('sources', src_text)}" if has_src else "")),
                  errors, max_tokens=config.FALSIFIER_MAX_TOKENS, temperature=0.3)
            for i, spec in enumerate(fal_specs, 1)
        ])
        reports = {f"Falsifier {i}": t for i, t in enumerate(fal_outs, 1) if t}
        fals_text = "\n\n".join(f"#### {k}\n{v}" for k, v in reports.items()) or "No falsification report available."

        # [E] Debater (only where there is a real clash) + code proofs, in parallel
        async def run_debate():
            rounds = 2 if deep else 1
            position = f"Question:\n{question}\n\n{RP.tag('claims', compact_text)}\n\n{RP.tag('reports', _cut(fals_text, 2500))}"
            out = []
            for r in range(1, rounds + 1):
                extra = RP.ENGINE_EXTRA["debater_round2"] if r == 2 else ""
                user = position if r == 1 else position + "\n\n" + RP.tag("reports", "## Round 1\n" + out[-1])
                t = await _call(client, f"debate:{r}", config.DEBATER,
                                _m(RP.system_for("debater", mode, writer_hint=lang, extra=extra), user),
                                errors, temperature=0.4, emit_start=f"Debater round {r}: sabse mazboot ulta paksh")
                if not t:
                    break
                out.append(t)
                if not debate_unresolved(t):
                    break
            return out

        async def run_proofs():
            if run_code and task in config.VERIFY_TASKS | {"science"} and config.CODE_EXEC_SUPPORTED:
                config.emit("Python se claims check ho rahe hain")
                return await verified.verify_with_code(client, question, task, compact_text, fals_text, errors)
            return []

        do_debate = config.DEBATE_ENABLED and needs_debate(claim_map, reports)
        debate, proofs = await asyncio.gather(run_debate() if do_debate else asyncio.sleep(0, result=[]), run_proofs())
        roles_dbg["debate_skipped"] = None if do_debate else "drafts me factual takraav nahi tha, koi claim nahi toota"
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
    judge_rules = [RP.JUDGE_FORMAT[fmt]]
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
    answer = await _call(client, "judge", config.SYNTHESIZER, judge_msgs, errors,
                         max_tokens=config.FINAL_MAX_TOKENS, temperature=0.2, emit_start="Judge: ek final jawab likh raha hai")
    judge_raw = answer
    repair_log: list[dict] = []
    audit_texts: dict = {}
    repairs = 0
    audit = {"enabled": config.REVIEW_ENABLED, "ran": False, "issues": [], "applied": [], "unsure": [], "label": "Reviewers"}
    reviews: dict = {}
    refiner_dbg: dict = {}
    if answer is None:
        answer = max(anon.values(), key=len) if anon else "Abhi koi model jawab nahi de paya. Thodi der baad dobara try karo."
        warnings.append("Judge fail hua: sabse lamba draft dikhaya gaya (bina jaanch ke).")
    else:
        answer, lint, repairs = await verified.enforce_format(client, judge_msgs, answer, proofs, style, errors, repair_log)

        # [G] Reviewers
        if config.REVIEW_ENABLED and not verified.missing_sections(answer, style):
            want_method = deep or mode in ("math", "physics", "coding")
            want_evidence = deep or not want_method
            config.emit("Reviewers: tareeka aur saboot jaanch rahe hain")
            material = "\n\n".join(p for p in [RP.tag("sources", src_text) if has_src else "",
                                               RP.tag("claims", compact_text)] if p)
            jobs = []
            if want_method:
                jobs.append(_call(client, "review:method", config.METHOD_REVIEWER,
                                  _m(RP.system_for("method_reviewer", mode, writer_hint=lang),
                                     f"Question:\n{question}\n\n{RP.tag('draft', answer)}"
                                     + (f"\n\n{RP.tag('reports', 'Code proofs: ' + json.dumps(verified_summary(proofs)))}" if proofs else "")),
                                  errors, temperature=0.1))
            if want_evidence:
                jobs.append(_call(client, "review:evidence", config.EVIDENCE_REVIEWER,
                                  _m(RP.system_for("evidence_reviewer", mode, writer_hint=lang, sources=has_src),
                                     f"Question:\n{question}\n\n{RP.tag('draft', answer)}\n\nMaterial the answer was built from:\n{material}"),
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
            if actionable:
                crit = "\n".join(f"{n}. [{i['by']}] \"{i['quote']}\" | problem: {i['problem']} | fix: {i['fix']}"
                                 for n, i in enumerate(actionable, 1))
                crit_block = RP.tag("critiques", crit)
                ref_msgs = _m(
                    RP.system_for("refiner", mode, writer_hint=lang_full, sources=has_src),
                    f"Question:\n{question}\n\n{RP.tag('draft', answer)}\n\n{crit_block}\n\n"
                    "Keep the CONFIDENCE line (lower it if a critique shows a real error). A changed step loses "
                    "[PROVEN by code] and becomes [REASONED].",
                )
                raw = await _call(client, "refine", config.REFINER, ref_msgs, errors,
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
    confidence = parse_confidence(answer)
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


def verified_summary(proofs: list[dict]) -> dict:
    summary = {"total": len(proofs)}
    for s in ("PASS", "FAIL", "ERROR", "TIMEOUT", "REJECTED", "UNCLEAR", "UNSUPPORTED"):
        n = sum(1 for p in proofs if p["status"] == s)
        if n:
            summary[s.lower()] = n
    return summary
