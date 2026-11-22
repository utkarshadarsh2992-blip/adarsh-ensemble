"""Verified engine.

  anonymised drafts
        |
  [2] tone-stripper    -> raw atomic claims + consensus / conflict map
  [3a] Popper falsifiers -> attack conflicts AND consensus (shared blind spots)
  [3b] executable truth  -> LLM writes Python checks, sandbox runs them
  [4] final judge        -> Direct Core Truth / Verified Mechanism / Trap Warning
  [5] contract linter    -> plain Python (no LLM): no "[PROVEN by code]" without a PASS proof

Falsifiers and the script-writer get a COMPACT map (consensus + conflicts) so their input
fits the small Groq per-minute token limit; the judge gets the full per-draft claims.
"""
import asyncio
import json
import re

import config
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
                conflicts.append(
                    {
                        "issue": str(c.get("issue", "")).strip(),
                        "positions": {str(k): str(v) for k, v in pos.items()}
                        if isinstance(pos, dict)
                        else {},
                    }
                )
    out = {"claims": claims, "consensus": _str_list(data.get("consensus")), "conflicts": conflicts}
    return out if (claims or out["consensus"] or conflicts) else None


def format_map(m: dict, compact: bool = False) -> str:
    lines = ["## CONSENSUS (most drafts agree)"]
    lines += [f"- {c}" for c in m["consensus"]] or ["- (none)"]
    lines.append("\n## CONFLICTS (logic collides)")
    if m["conflicts"]:
        for i, c in enumerate(m["conflicts"], 1):
            lines.append(f"{i}. {c['issue']}")
            lines += [f"   {k}: {v}" for k, v in c["positions"].items()]
    else:
        lines.append("- (none found)")
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


_TAG_RE = re.compile(r"\s*\[(?:PROVEN by code|REASONED|UNVERIFIED)\]", re.IGNORECASE)


def lint_answer(answer: str, proofs: list[dict], style: str = "solve") -> tuple[str, list[str]]:
    """Deterministic contract check (no LLM). Keeps the 'verified' label honest."""
    warnings: list[str] = []
    if style == "explain":
        # Nothing was run as code for an explanation, so proof tags would only suggest certainty that is not there.
        answer = _TAG_RE.sub("", answer)
        missing = [s for s in ("Short answer", "Explanation", "Common mistake") if s.lower() not in answer.lower()]
        if missing:
            warnings.append("Final answer is missing section(s): " + ", ".join(missing))
        return answer, warnings
    passed = sum(1 for p in proofs if p["status"] == "PASS")
    failed = sum(1 for p in proofs if p["status"] == "FAIL")
    if passed == 0 and re.search(r"\[PROVEN by code\]", answer, re.IGNORECASE):
        answer = re.sub(r"\[PROVEN by code\]", "[REASONED]", answer, flags=re.IGNORECASE)
        warnings.append("Judge wrote [PROVEN by code] but no code check passed: downgraded to [REASONED].")
    missing = [
        s for s in ("Direct Core Truth", "Verified Mechanism", "Trap Warning") if s.lower() not in answer.lower()
    ]
    if missing:
        warnings.append("Final answer is missing section(s): " + ", ".join(missing))
    if failed:
        warnings.append(f"{failed} code check(s) FAILED: compare debug.proofs with the answer.")
    if proofs and passed == 0 and failed == 0:
        warnings.append("No code check produced PASS or FAIL (errors, timeouts or rejected scripts).")
    return answer, warnings


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


async def falsify(client, question, map_text, lang, deep):
    debaters = config.DEBATERS if deep else config.DEBATERS[:2]
    results = await asyncio.gather(
        *[_popper_turn(client, d, question, map_text, lang) for d in debaters]
    )
    reports, errors = {}, {}
    for i, (text, err) in enumerate(results, 1):
        if text:
            reports[f"Falsifier {i}"] = text
        if err:
            errors[f"falsifier{i}"] = err
    return reports, errors


async def verify_with_code(client, question, task, map_text, fals_text, errors) -> list[dict]:
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


async def _judge(client, question, map_text, fals_text, proofs_text, lang, errors, style="solve") -> str | None:
    messages = (
        prompts.judge_explain_messages(question, map_text, fals_text, lang)
        if style == "explain"
        else prompts.judge_messages(question, map_text, fals_text, proofs_text, lang)
    )
    try:  # SYNTHESIZER already carries its own fallback chain
        return await chat(
            client, config.SYNTHESIZER,
            messages,
            temperature=0.2, max_tokens=config.FINAL_MAX_TOKENS,
        )
    except LLMError as e:
        errors["judge"] = str(e)
        return None


# ------------------------------------------------------------------ entry point

async def run_verified(
    client, question, task, anon, lang, deep, run_code, errors, flagged=None, *, style="solve", judge_hint=None
):
    """Returns (answer, extras). Never raises. `lang` goes to the falsifiers, `judge_hint` (language + depth) to the judge."""
    config.emit("Drafts ko claims me tod raha hu")
    claim_map = await strip_to_claims(client, question, anon, flagged)
    if claim_map:
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
    answer = await _judge(client, question, full_text, fals_text, proofs_text, judge_hint or lang, errors, style)
    if answer is None:
        answer = max(anon.values(), key=len)
        warnings.append("Judge failed: returned the longest draft (unverified).")
    else:
        answer, lint = lint_answer(answer, proofs, style)
        warnings += lint

    summary = {"total": len(proofs)}
    for s in ("PASS", "FAIL", "ERROR", "TIMEOUT", "REJECTED", "UNCLEAR", "UNSUPPORTED"):
        n = sum(1 for p in proofs if p["status"] == s)
        if n:
            summary[s.lower()] = n
    extras = {
        "proofs_summary": summary,
        "falsifier_notes": falsifier_notes(reports),
        "warnings": warnings,
        "debug": {
            "claims_map": claim_map,
            "falsification": reports,
            "proofs": proofs,
        },
    }
    return answer, extras
