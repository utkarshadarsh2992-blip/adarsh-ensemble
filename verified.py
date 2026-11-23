"""Verified engine.

  anonymised drafts
        |
  [2] tone-stripper    -> raw atomic claims + consensus / conflict map
  [3a] Popper falsifiers -> attack conflicts AND consensus (shared blind spots)
  [3b] executable truth  -> LLM writes Python checks, sandbox runs them
  [4] final judge        -> Direct Core Truth / Verified Mechanism / Trap Warning
  [5] contract linter    -> plain Python (no LLM): no "[PROVEN by code]" without a PASS proof; a missing
                            section triggers a re-ask (repair loop) before anything is shown
  [6] audit + revise     -> a different model fact-checks the final answer; high/medium errors are rewritten

Falsifiers and the script-writer get a COMPACT map (consensus + conflicts) so their input
fits the small Groq per-minute token limit; the judge gets the full per-draft claims.
"""
import asyncio
import json
import re

import config
import health
import prompts
import sandbox
from llm import LLMError, chat

_CHECK_RE = re.compile(
    r"###\s*CHECK\s*\d+\s*:\s*(.+?)\n\s*```(?:python|py)?\s*\n(.*?)```",
    re.DOTALL | re.IGNORECASE,
)


# ------------------------------------------------------------------ helpers

def _extract_json(text: str):
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def _str_list(v) -> list[str]:
    return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []


def _normalize_map(data) -> dict | None:
    if not isinstance(data, dict):
        return None
    raw_claims = data.get("claims")
    claims = (
        {str(k): _str_list(v) for k, v in raw_claims.items()} if isinstance(raw_claims, dict) else {}
    )
    conflicts = []
    if isinstance(data.get("conflicts"), list):
        for c in data["conflicts"]:
            if isinstance(c, dict):
                pos = c.get("positions")
                kind = str(c.get("kind", "factual")).strip().lower()
                conflicts.append(
                    {
                        "kind": kind if kind in ("factual", "choice", "unspecified") else "factual",
                        "issue": str(c.get("issue", "")).strip(),
                        "positions": {str(k): str(v) for k, v in pos.items()}
                        if isinstance(pos, dict)
                        else {},
                    }
                )
    out = {"claims": claims, "consensus": _str_list(data.get("consensus")), "conflicts": conflicts}
    return out if (claims or out["consensus"] or conflicts) else None


def format_map(m: dict, compact: bool = False) -> str:
    """Only FACTUAL conflicts are put to the falsifiers. Choices and values the question never gave are listed apart:
    neither side is an error, so nobody should spend tokens deciding who is 'right' (e.g. house size, colour)."""
    factual = [c for c in m["conflicts"] if c.get("kind", "factual") == "factual"]
    other = [c for c in m["conflicts"] if c.get("kind", "factual") != "factual"]
    lines = ["## CONSENSUS (most drafts agree)"]
    lines += [f"- {c}" for c in m["consensus"]] or ["- (none)"]
    lines.append("\n## CONFLICTS (logic collides)")
    if factual:
        for i, c in enumerate(factual, 1):
            lines.append(f"{i}. {c['issue']}")
            lines += [f"   {k}: {v}" for k, v in c["positions"].items()]
    else:
        lines.append("- (none found)")
    if other and not compact:
        lines.append("\n## DIFFERENT CHOICES (not errors: the question did not fix these)")
        for i, c in enumerate(other, 1):
            lines.append(f"{i}. {c['issue']} [{c.get('kind')}]")
            lines += [f"   {k}: {v}" for k, v in c["positions"].items()]
    if not compact:
        lines.append("\n## ATOMIC CLAIMS PER DRAFT")
        for k, claims in m["claims"].items():
            lines.append(f"{k}:")
            lines += [f"  {i}. {c}" for i, c in enumerate(claims, 1)]
    return "\n".join(lines)


def format_raw(anon: dict[str, str], limit: int | None = None) -> str:
    def cut(v: str) -> str:
        return v if not limit or len(v) <= limit else v[:limit] + " ...(trimmed)"

    return "## RAW DRAFTS (tone-stripper failed)\n" + "\n\n".join(
        f"### Draft {k}\n{cut(v)}" for k, v in anon.items()
    )


def format_proofs(results: list[dict]) -> str:
    if not results:
        return "No code checks were run (task not checkable by code, or disabled)."
    parts = []
    for i, r in enumerate(results, 1):
        code = r["code"] if len(r["code"]) <= 1200 else r["code"][:1200] + "\n# ...(trimmed)"
        parts.append(
            f"CHECK {i} [{r['status']}]: {r['claim']}\n"
            f"output:\n{r['output'] or '(no output)'}\n"
            f"script:\n{code}"
        )
    return "\n\n".join(parts)


SOLVE_SECTIONS = ("Direct Core Truth", "Verified Mechanism", "Trap Warning")
EXPLAIN_SECTIONS = ("Short answer", "Explanation", "Common mistake")
# roles engine (roles.py): style "roles:<format>", same lists as role_prompts.FORMAT_SECTIONS
ROLE_SECTIONS = {
    "roles:standard": ("Short answer", "Explanation", "Common mistake", "CONFIDENCE:"),
    "roles:coding": ("Solution", "How it works", "Edge cases and tests", "CONFIDENCE:"),
}


def sections_for(style: str) -> tuple:
    if style in ROLE_SECTIONS:
        return ROLE_SECTIONS[style]
    return EXPLAIN_SECTIONS if style == "explain" else SOLVE_SECTIONS


def missing_sections(answer: str, style: str) -> list[str]:
    low = re.sub(r"\s+", " ", answer.lower())
    return [s for s in sections_for(style) if s.lower() not in low]


_TAG_RE = re.compile(r"\s*\[(?:PROVEN by code|REASONED|UNVERIFIED)\]", re.IGNORECASE)

# "r162 is the latest stable release as of 2026-11-22": the engine has no internet, so this comes from stale memory.
_VER = r"(?:\bv?\d+(?:\.\d+)+\b|\br\d{2,4}\b|\b(?:19|20)\d{2}\b)"
_FRESH = re.compile(
    r"(?is)\b(?:latest|newest|most recent|current(?:ly)?|as of|abhi tak ka)\b[^.\n]{0,70}?" + _VER
    + r"|" + _VER + r"[^.\n]{0,50}?\b(?:is|was|hai)\b[^.\n]{0,20}\b(?:latest|newest|current|stable)\b"
)


def freshness_warning(answer: str) -> list[str]:
    for m in _FRESH.finditer(answer):
        start = answer.rfind("\n", 0, m.start()) + 1
        end = answer.find("\n", m.end())
        if re.search(r"\[S\d+", answer[start : end if end != -1 else None]):
            continue  # backed by a web source fetched for this question (roles engine research step)
        return ["Jawab me 'latest / current / as of' ke saath version ya saal hai, bina kisi web source ke. "
                "Ye model ki purani yaad se ho sakta hai: pehle official site par check karo."]
    return []


def lint_answer(answer: str, proofs: list[dict], style: str = "solve") -> tuple[str, list[str]]:
    """Deterministic contract check (no LLM). Keeps the 'verified' label honest."""
    warnings: list[str] = []
    if style == "explain":
        # Nothing was run as code for an explanation, so proof tags would only suggest certainty that is not there.
        answer = _TAG_RE.sub("", answer)
        missing = missing_sections(answer, style)
        if missing:
            warnings.append("Final answer is missing section(s): " + ", ".join(missing))
        return answer, warnings + freshness_warning(answer)
    passed = sum(1 for p in proofs if p["status"] == "PASS")
    failed = sum(1 for p in proofs if p["status"] == "FAIL")
    if passed == 0 and re.search(r"\[PROVEN by code\]", answer, re.IGNORECASE):
        answer = re.sub(r"\[PROVEN by code\]", "[REASONED]", answer, flags=re.IGNORECASE)
        warnings.append("Judge wrote [PROVEN by code] but no code check passed: downgraded to [REASONED].")
    missing = missing_sections(answer, style)
    if missing:
        warnings.append("Final answer is missing section(s): " + ", ".join(missing))
    if failed:
        warnings.append(f"{failed} code check(s) FAILED: compare debug.proofs with the answer.")
    if proofs and passed == 0 and failed == 0:
        warnings.append("No code check produced PASS or FAIL (errors, timeouts or rejected scripts).")
    return answer, warnings + freshness_warning(answer)


# What the reader sees under "Kahan galat ho sakta hai": the falsifiers' own words, minus the part meant for the
# script-writer (section C, "what Python can test").
_C_BLOCK = re.compile(r"(?ms)^[ \t>*#_]*C[.):][^\n]*\n.*?(?=^[ \t>*#_]*D[.):]|\Z)")


def _trim(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    brk = max(cut.rfind("\n"), cut.rfind(". ") + 1)
    return (cut[:brk] if brk > limit * 0.6 else cut).rstrip() + " …"


def falsifier_notes(reports: dict[str, str], limit: int = 1100) -> list[dict]:
    notes = []
    for i, text in enumerate(reports.values(), 1):
        t = _C_BLOCK.sub("", text).strip() or text.strip()
        if t:
            notes.append({"title": f"Checker {i}", "text": _trim(t, limit)})
    return notes


# ------------------------------------------------------------------ stages

async def strip_to_claims(client, question, anon, flagged=None) -> dict | None:
    health.set_stage("stripper")
    try:
        out = await chat(
            client, config.STRIPPER, prompts.strip_messages(question, anon, flagged),
            temperature=0.0, max_tokens=3000,
        )
    except LLMError:
        return None
    return _normalize_map(_extract_json(out))


async def _popper_turn(client, spec, question, map_text, lang):
    try:
        text = await asyncio.wait_for(
            chat(
                client, spec, prompts.popper_messages(question, map_text, lang),
                temperature=0.3, max_tokens=config.FALSIFIER_MAX_TOKENS,
            ),
            timeout=config.PANEL_TIMEOUT_S,
        )
        return text, None
    except (LLMError, asyncio.TimeoutError) as e:
        return None, str(e) or "timeout"


async def _falsifier_run(client, n, spec, question, map_text, lang):
    stage = f"falsifier:{n}"
    health.set_stage(stage)
    config.emit(f"Falsifier {n}: claims par hamla soch raha hai")
    text, err = await _popper_turn(client, spec, question, map_text, lang)
    used = (health.last_call(stage) or {}).get("used", spec.label)
    config.emit(f"Falsifier {n} ({used}): " + ("report mili" if text else "report nahi mili"))
    return text, err


async def falsify(client, question, map_text, lang, deep):
    debaters = config.DEBATERS if deep else config.DEBATERS[:2]
    results = await asyncio.gather(
        *[_falsifier_run(client, i, d, question, map_text, lang) for i, d in enumerate(debaters, 1)]
    )
    reports, errors = {}, {}
    for i, (text, err) in enumerate(results, 1):
        if text:
            reports[f"Falsifier {i}"] = text
        if err:
            errors[f"falsifier{i}"] = err
    return reports, errors


async def verify_with_code(client, question, task, map_text, fals_text, errors) -> list[dict]:
    health.set_stage("verifier")
    try:
        out = await chat(
            client, config.VERIFIER,
            prompts.verifier_messages(question, map_text, fals_text[:2500], task, config.MAX_CHECKS),
            temperature=0.2, max_tokens=2500,
        )
    except LLMError as e:
        errors["verifier"] = str(e)
        return []
    checks = [(c.strip(), code.strip()) for c, code in _CHECK_RE.findall(out)][: config.MAX_CHECKS]
    if not checks:
        return []
    runs = await asyncio.gather(
        *[
            asyncio.to_thread(
                sandbox.run_python, code, config.SANDBOX_TIMEOUT_S, config.SANDBOX_MEM_MB
            )
            for _, code in checks
        ]
    )
    return [
        {"claim": claim, "code": code, "status": r["status"], "output": r["output"]}
        for (claim, code), r in zip(checks, runs)
    ]


def _judge_messages(question, map_text, fals_text, proofs_text, lang, style) -> list[dict]:
    if style == "explain":
        return prompts.judge_explain_messages(question, map_text, fals_text, lang)
    return prompts.judge_messages(question, map_text, fals_text, proofs_text, lang)


async def _judge(client, messages, errors) -> str | None:
    health.set_stage("judge")
    try:  # SYNTHESIZER already carries its own fallback chain
        return await chat(client, config.SYNTHESIZER, messages, temperature=0.2, max_tokens=config.FINAL_MAX_TOKENS)
    except LLMError as e:
        errors["judge"] = str(e)
        return None


async def _repair(client, base_messages, answer, missing, attempt, errors, writer=None) -> str | None:
    """The judge dropped required headings. Show it its own answer and ask for the complete answer again.
    Attempt 2 starts on a different model, because the same one may keep making the same mistake."""
    base = writer or config.SYNTHESIZER
    spec = base if attempt == 0 else config.rotated(base)
    health.set_stage(f"repair{attempt + 1}")
    messages = base_messages + [
        {"role": "assistant", "content": answer},
        {
            "role": "user",
            "content": "Format error: your answer is missing the required section heading(s): "
            + ", ".join(missing)
            + ". Write the COMPLETE answer again with exactly the required sections and heading names, in the "
            "required order. Keep the content (change it only if you notice a mistake). Do not mention this correction.",
        },
    ]
    try:
        return await chat(client, spec, messages, temperature=0.1, max_tokens=config.FINAL_MAX_TOKENS)
    except LLMError as e:
        errors[f"repair{attempt + 1}"] = str(e)
        return None


async def enforce_format(client, base_messages, answer, proofs, style, errors, log=None) -> tuple[str, list[str], int]:
    """Lint, and while required sections are missing re-ask (up to MAX_REPAIRS) BEFORE the user sees anything.
    Returns (answer, lint warnings for the FINAL text, repair attempts used)."""
    answer, lint = lint_answer(answer, proofs, style)
    repairs = 0
    while repairs < config.MAX_REPAIRS:
        missing = missing_sections(answer, style)
        if not missing:
            break
        config.emit("Format theek kar raha hu: " + ", ".join(missing) + " section gayab tha")
        fixed = await _repair(client, base_messages, answer, missing, repairs, errors)
        if log is not None:
            log.append({"attempt": repairs + 1, "missing": list(missing), "before": answer, "after": fixed})
        repairs += 1
        if fixed:
            answer, lint = lint_answer(fixed, proofs, style)
    missing = missing_sections(answer, style)
    if missing and repairs:
        lint = [w for w in lint if not w.startswith("Final answer is missing")] + [
            f"Format check failed after {repairs} repair attempt(s): missing {', '.join(missing)}."
        ]
    return answer, lint, repairs


# ------------------------------------------------------------------ audit

def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[*_`#>]|\[(?:PROVEN by code|REASONED|UNVERIFIED)\]", "", text)).strip().lower()


async def audit_answer(client, question, answer, lang, errors) -> dict:
    """A different model fact-checks the FINAL answer. Returns {"ran": bool, "issues": [...]}.
    An issue whose quote cannot be found in the answer is capped at low confidence (it may be invented)."""
    config.emit("Audit: facts dobara check ho rahe hain")
    health.set_stage("audit")
    try:
        out = await chat(
            client, config.AUDITOR, prompts.audit_messages(question, answer, lang),
            temperature=0.1, max_tokens=1500,
        )
    except LLMError as e:
        errors["auditor"] = str(e)
        return {"ran": False, "issues": []}
    data = _extract_json(out)
    if not isinstance(data, dict) or not isinstance(data.get("issues"), list):
        errors["auditor"] = "unreadable output"
        return {"ran": False, "issues": []}
    haystack, issues = _norm(answer), []
    for it in data["issues"][: config.AUDIT_MAX_ISSUES]:
        if not isinstance(it, dict):
            continue
        quote, problem, fix = (str(it.get(k) or "").strip() for k in ("quote", "problem", "fix"))
        conf = str(it.get("confidence") or "low").strip().lower()
        if not (problem and fix):
            continue
        if conf not in ("high", "medium", "low"):
            conf = "low"
        nq = _norm(quote)[:80]
        if conf != "low" and (not nq or nq not in haystack):
            conf = "low"
        issues.append({"quote": quote[:300], "problem": problem[:400], "fix": fix[:400], "confidence": conf})
    return {"ran": True, "issues": issues}


async def revise_answer(client, messages, errors, writer=None) -> str | None:
    health.set_stage("revise")
    try:
        return await chat(client, writer or config.SYNTHESIZER, messages, temperature=0.1, max_tokens=config.FINAL_MAX_TOKENS)
    except LLMError as e:
        errors["reviser"] = str(e)
        return None


# ------------------------------------------------------------------ entry point

async def run_verified(
    client, question, task, anon, lang, deep, run_code, errors, flagged=None, *, style="solve", judge_hint=None
):
    """Returns (answer, extras). Never raises. `lang` goes to the falsifiers, `judge_hint` (language + depth) to the judge."""
    config.emit("Drafts ko claims me tod raha hu")
    claim_map = await strip_to_claims(client, question, anon, flagged)
    if claim_map:
        config.emit(
            f"Tone-stripper: {sum(len(v) for v in claim_map['claims'].values())} claims, "
            f"{len(claim_map['consensus'])} sahmati, {len(claim_map['conflicts'])} takraav"
        )
        full_text = format_map(claim_map)
        compact_text = format_map(claim_map, compact=True)
    else:
        errors["tone_stripper"] = "failed, used raw drafts"
        full_text = format_raw(anon)
        compact_text = format_raw(anon, limit=1200)

    config.emit("Falsifiers galtiyan dhoondh rahe hain")
    reports, fal_errors = await falsify(client, question, compact_text, lang, deep)
    errors.update(fal_errors)
    fals_text = (
        "\n\n".join(f"#### {k}\n{v}" for k, v in reports.items())
        or "No falsification report available."
    )

    proofs: list[dict] = []
    if run_code and style == "solve" and task in config.VERIFY_TASKS:
        proofs = await verify_with_code(client, question, task, compact_text, fals_text, errors)
    proofs_text = format_proofs(proofs)

    warnings: list[str] = []
    config.emit("Final judge jawab likh raha hai")
    hint = judge_hint or lang
    judge_msgs = _judge_messages(question, full_text, fals_text, proofs_text, hint, style)
    answer = await _judge(client, judge_msgs, errors)
    judge_raw = answer
    repair_log: list[dict] = []
    audit_texts: dict = {}
    repairs = 0
    audit = {"enabled": config.AUDIT_ENABLED, "ran": False, "issues": [], "applied": [], "unsure": []}
    if answer is None:
        answer = max(anon.values(), key=len)
        warnings.append("Judge failed: returned the longest draft (unverified).")
    else:
        used = (health.last_call("judge") or {}).get("used", "")
        config.emit(f"Judge ({used}) ne jawab likha" if used else "Judge ne jawab likha")
        answer, lint, repairs = await enforce_format(client, judge_msgs, answer, proofs, style, errors, repair_log)

        if config.AUDIT_ENABLED and not missing_sections(answer, style):
            res = await audit_answer(client, question, answer, lang, errors)
            audit["ran"], issues = res["ran"], res["issues"]
            audit["issues"] = issues
            config.emit(f"Audit: {len(issues)} shak/galti mili" if issues else "Audit: koi galti nahi mili")
            actionable = [i for i in issues if i["confidence"] in ("high", "medium")]
            if actionable:
                config.emit("Galtiyan sudhar raha hu")
                rev_msgs = prompts.revise_messages(question, answer, actionable, hint)
                audit_texts["before"] = answer
                revised = await revise_answer(client, rev_msgs, errors)
                if revised:
                    r_answer, r_lint, r_repairs = await enforce_format(client, rev_msgs, revised, proofs, style, errors, repair_log)
                    # never end up worse than before: a rewrite that lost its sections is thrown away
                    if not missing_sections(r_answer, style):
                        answer, lint, repairs = r_answer, r_lint, repairs + r_repairs
                        audit["applied"] = actionable
                        audit_texts["after"] = answer
                    else:
                        audit_texts["discarded"] = r_answer  # rewrite lost required sections: not used
            applied_ids = {id(i) for i in audit["applied"]}
            audit["unsure"] = [i for i in issues if id(i) not in applied_ids]
        warnings += lint

    summary = {"total": len(proofs)}
    for s in ("PASS", "FAIL", "ERROR", "TIMEOUT", "REJECTED", "UNCLEAR", "UNSUPPORTED"):
        n = sum(1 for p in proofs if p["status"] == s)
        if n:
            summary[s.lower()] = n
    extras = {
        "proofs_summary": summary,
        "falsifier_notes": falsifier_notes(reports),
        "repairs": repairs,
        "audit": audit,
        "warnings": warnings,
        "debug": {
            "claims_map": claim_map,
            "falsification": reports,
            "proofs": proofs,
            "judge_raw": judge_raw,
            "repair_log": repair_log,
            "audit_texts": audit_texts,
        },
    }
    return answer, extras
