"""The "council" record: everything each role was given, did and produced for ONE answer.

Built only when pipeline.run(record=True). The UI shows it as a separate page ("Kisne kya socha"),
so the chat itself stays clean. Nothing here calls a model: it is assembled from data the pipeline
already has, plus two cheap local analyses (pattern summary, draft -> final provenance).
"""
import json
import re
import time

import prompts

STAGE_TITLES = {
    "classify": "Sawaal ka type",
    "stripper": "Tone-stripper (drafts se claims)",
    "verifier": "Code-proof likhne wala",
    "judge": "Judge (final jawab)",
    "audit": "Auditor (fact check)",
    "revise": "Reviser (sudhaar ka rewrite)",
    "synth": "Synthesizer",
    "single": "Akela model (panel fail hua)",
    "architect": "Architect (jawab ka dhancha)",
    "skeptic": "Skeptic (3 sabse kamzor point)",
    "review:method": "Methodology reviewer (jawab kaise nikla)",
    "review:evidence": "Evidence reviewer (har claim ka saboot)",
    "refine": "Refiner (reviewers ke sudhaar)",
}
MAX_RECORD_CHARS = 350_000  # the phone keeps several of these; one huge record must not eat the storage
_SENT = re.compile(r"(?<=[.!?।])\s+|\n+")
_WORD = re.compile(r"[a-z0-9ऀ-ॿ]{3,}")


# manual mode reuses the stage names judge/audit/revise for its own steps
MASTER_TITLES = {
    "judge": "Master writer (jawab sirf paste kiye answers se)",
    "audit": "Grounding check (kya paste kiye answers isse support karte hain?)",
    "revise": "Grounding rewrite",
}


def stage_title(stage: str) -> str:
    kind, _, rest = stage.partition(":")
    if kind == "panel":
        return "Panel: " + prompts.ROLE_INFO.get(rest, (rest,))[0]
    if kind == "falsifier":
        return f"Falsifier {rest}"
    if kind == "debate":
        return f"Debater round {rest}" if rest.isdigit() else f"Debater ({rest})"
    if kind.startswith("repair"):
        return "Format repair " + kind.removeprefix("repair")
    return STAGE_TITLES.get(stage, stage)


def _sentences(text: str, min_len: int) -> list[str]:
    out = []
    for s in _SENT.split(re.sub(r"[*_`#>|]", " ", text or "")):
        s = " ".join(s.split())
        if len(s) >= min_len:
            out.append(s)
    return out


def _words(s: str) -> set[str]:
    return set(_WORD.findall(s.lower()))


def _sim(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def provenance(final: str, drafts: dict[str, str], limit: int = 10) -> dict:
    """Which draft each final sentence looks like, and which draft sentences did not make it.
    Word-overlap based: an estimate, not a proof of what the judge model did."""
    fin = [(s, _words(s)) for s in _sentences(final, 25)]
    dr = {name: [(s, _words(s)) for s in _sentences(txt, 40)] for name, txt in drafts.items()}
    kept, dropped = [], {}
    for s, w in fin:
        best, who = 0.0, ""
        for name, sents in dr.items():
            for _, dw in sents:
                v = _sim(w, dw)
                if v > best:
                    best, who = v, name
        kept.append({"text": s[:240], "from": who if best >= 0.4 else "", "score": round(best, 2)})
    final_words = [w for _, w in fin]
    for name, sents in dr.items():
        miss = [s[:240] for s, w in sents if max((_sim(w, fw) for fw in final_words), default=0.0) < 0.25]
        if miss:
            dropped[name] = miss[:limit]
    share: dict[str, int] = {}
    for k in kept:
        if k["from"]:
            share[k["from"]] = share.get(k["from"], 0) + 1
    return {"final_sentences": kept[:40], "dropped": dropped, "share": share,
            "note": "Shabd-milan se andaaza, judge ne asli me kya kiya iska pakka saboot nahi."}


def patterns(drafts: dict[str, str], claim_map: dict | None) -> dict:
    """Pattern finder's named pattern + what the drafts share / split on."""
    out: dict = {"named": "", "shared": [], "split": [], "warning": ""}
    for name, text in drafts.items():
        if "pattern_finder" in name or name.startswith(prompts.ROLE_INFO["pattern_finder"][0]):
            m = re.search(r"^\W*PATTERN:\s*(.+)$", text or "", re.I | re.M)
            if m:
                out["named"] = m.group(1).strip()[:200]
    if claim_map:
        out["shared"] = claim_map.get("consensus", [])[:8]
        out["split"] = [c.get("issue", "") for c in claim_map.get("conflicts", [])][:8]
        if len(drafts) >= 3 and out["shared"] and not out["split"]:
            out["warning"] = ("Saare drafts ek jaisa soch rahe hain. Model aksar ek hi jaisi galti saath me dohrate hain, "
                              "isliye sahmati ko saboot mat samjho: falsifier ki report dekho.")
    return out


def build(*, question, setup, trace, user_drafts, panel_drafts, letter_to_name, extras, guard_report,
          errors, warnings, final, panel_specs=None) -> dict:
    dbg = (extras or {}).get("debug", {})
    calls = []
    for e in trace:
        c = {k: e[k] for k in ("stage", "role", "asked", "used", "ok", "secs", "skips", "prompt", "output") if k in e}
        c["title"] = stage_title(e.get("stage") or e.get("role", ""))
        if (setup or {}).get("engine") == "master" and e.get("stage") in MASTER_TITLES:
            c["title"] = MASTER_TITLES[e["stage"]]
        if (e.get("stage") or "").startswith("panel:"):
            c["brief"] = prompts.ROLE_INFO.get(e["stage"].split(":", 1)[1], ("", ""))[1]
        calls.append(c)
    have = {c["stage"] for c in calls}
    # roles whose call left no trace (tests, or a failure before the call): still list them from the drafts we have
    for role, text in panel_drafts.items():
        if f"panel:{role}" not in have:
            info = prompts.ROLE_INFO.get(role, (role, ""))
            calls.append({"stage": f"panel:{role}", "role": role, "title": "Panel: " + info[0], "brief": info[1],
                          "ok": True, "output": text})
    all_drafts = {**user_drafts, **panel_drafts}
    drafts = [{"name": n, "kind": "user" if n in user_drafts else "panel",
               "title": prompts.ROLE_INFO.get(n, (n,))[0] if n not in user_drafts else n,
               "text": t, "letter": next((l for l, nm in (letter_to_name or {}).items() if nm == n), "")}
              for n, t in all_drafts.items()]
    audit = dict((extras or {}).get("audit") or {})
    texts = dbg.get("audit_texts") or {}
    audit.update({k: texts[k] for k in ("before", "after", "discarded") if k in texts})
    rec = {
        "v": 1,
        "ts": int(time.time()),
        "question": question[:2000],
        "setup": setup,
        "calls": calls,
        "drafts": drafts,
        "claims_map": dbg.get("claims_map"),
        "patterns": patterns(all_drafts, dbg.get("claims_map")),
        "falsifiers": dbg.get("falsification") or {},
        "proofs": dbg.get("proofs") or [],
        "judge_raw": dbg.get("judge_raw"),
        "repairs": dbg.get("repair_log") or [],
        "audit": audit,
        "provenance": provenance(final, all_drafts) if all_drafts else None,
        "lessons": (extras or {}).get("master"),
        "roles": dbg.get("roles"),
        "guard": guard_report or {},
        "errors": errors,
        "warnings": warnings,
        "final": final,
    }
    return _fit(rec)


def _fit(rec: dict) -> dict:
    """Shorten the stored prompts if the whole record is too big (outputs and analysis are never cut)."""
    if len(json.dumps(rec, ensure_ascii=False)) <= MAX_RECORD_CHARS:
        return rec
    for c in rec["calls"]:
        for m in c.get("prompt", []):
            if len(m["content"]) > 3000:
                m["content"] = m["content"][:3000] + "\n…[record chhota karne ke liye kaata gaya]"
    rec["trimmed"] = True
    return rec
