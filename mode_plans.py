"""Mode plans: one SEPARATE model combination + behaviour policy per chat mode (Standard, V, Physics, Math, Business, Coding).

Why: the 6 UI modes used to share one set of role chains and differed only by a prompt hint. Now every mode has
  * its own CHAINS: which model plays which of the 11 roles (picked for that kind of question), and
  * its own POLICY: how much checking it does (depth, falsifiers, debate, reviewers, research, code proofs, extra rules).
Edit a mode here and nothing else changes; the other modes keep their own plans.

Model choices are judgement calls from the models' known strengths (reasoning / coding / long context / knowledge work)
and the free quotas (OpenRouter 50 req/day for ALL free models -> used late in chains; Groq 8K tokens/min -> no big-input
roles first on Groq). They are NOT benchmark results. Same rules as config.validate_plan(): every chain has all three core
providers (groq, openrouter, gemini), the first fallback is on another provider, no model twice in one chain.
Spreading the PRIMARY models across modes also spreads the daily quota: Standard runs mostly on the lite models.
"""
from dataclasses import dataclass, field

import config
from config import use

# roles every plan must fill (falsifiers are a list)
ROLE_KEYS = ("architect", "theorist", "empiricist", "specialist", "pattern", "skeptic", "debater",
             "judge", "method", "evidence", "refiner", "verifier")


@dataclass(frozen=True)
class Policy:
    depth: str = "inherit"            # inherit (user's Fast/Deep) | deep (always deep unless quota is low)
    specialist: str = "deep"          # deep | always   (mode specialist drafter)
    pattern: str = "deep"             # deep | always   (Pattern Finder)
    falsifiers: tuple = (2, 3)        # (fast, deep) how many falsifiers attack the claims
    debate: str = "conflict"          # conflict (only on a factual clash / broken claim) | always | off
    debate_rounds: tuple = (1, 2)     # (fast, deep)
    reviewers_fast: tuple = ("method",)            # which reviewers run in fast
    reviewers_deep: tuple = ("method", "evidence")  # ... and in deep
    research: str = "auto"            # off | auto (Architect's SEARCH line) | must (always search, the question if needed)
    max_sources: int = 5
    code_proofs: str = "task"         # task (math/science/coding tasks) | always | never  (never on Android anyway)
    draft_temp: float = 0.5
    checks: dict = field(default_factory=dict)  # role -> extra rule lines (judge, falsifier, method, evidence, skeptic)
    low_conf_warn: bool = False       # warn the user when the final CONFIDENCE is low


@dataclass(frozen=True)
class ModePlan:
    mode: str
    title: str
    why: str
    chains: dict
    falsifiers: list
    policy: Policy

    def spec(self, role: str):
        return self.chains[role]


# ----------------------------------------------------------------------------- STANDARD: everyday, cheap and fast
STANDARD = ModePlan(
    "standard", "Standard",
    "Lite models first (gemini lite / gpt-oss-20b / gemma 26b) so everyday chat does not eat the big models' quota.",
    {
        "architect": use("gemini-3.1-flash-lite", "architect", ["gpt-oss-20b", "nemotron-lightning", "gemini-3.5-flash-lite"]),
        "theorist": use("gpt-oss-20b", "theorist", ["gemini-3.5-flash-lite", "gpt-oss-120b", "ling-3.2-flash"]),
        "empiricist": use("gemma-4-26b-g", "empiricist", ["qwen3.8-27b", "ling-3.2-flash", "gemini-3.5-flash-lite"]),
        "specialist": use("gemini-3.8-flash", "researcher", ["gpt-oss-120b", "nemotron-super-vl", "gemma-4-31b-g", config.HEAVY_FALLBACK]),
        "pattern": use(config.PATTERN, "pattern_finder", ["gemini-3.5-flash-lite", "gpt-oss-120b", "nemotron-lightning"]),
        "skeptic": use("gemini-3.1-flash-lite", "skeptic", ["gpt-oss-20b", "nemotron-lightning"]),
        "debater": use("gpt-oss-120b", "debater", ["gemini-3.5-flash-lite", "nemotron-ultra", config.HEAVY_FALLBACK]),
        "judge": use("gemini-3.8-flash", "synthesizer", ["gpt-oss-120b", "nemotron-ultra", config.HEAVY_FALLBACK, "or-free-router"]),
        "method": use("qwen3.8-27b", "method_reviewer", ["gemini-3.5-flash-lite", "nemotron-lightning"]),
        "evidence": use("gpt-oss-120b", "evidence_reviewer", ["gemini-3.5-flash-lite", "nemotron-lightning", config.HEAVY_FALLBACK]),
        "refiner": use("gemini-3.5-flash-lite", "refiner", ["gpt-oss-120b", "nemotron-ultra", "gemini-3.8-flash"]),
        "verifier": config.VERIFIER,
    },
    [
        use("gpt-oss-120b", "judge", ["gemini-3.5-flash-lite", "nemotron-lightning"]),
        use("gemma-4-31b-g", "judge", ["qwen3.8-27b", "ernie-5.5-flash"]),
        use("nemotron-ultra", "judge", ["gpt-oss-20b", "gemini-3.1-flash-lite"]),
    ],
    Policy(falsifiers=(1, 2), debate_rounds=(1, 1), reviewers_fast=("evidence",), research="auto", max_sources=3,
           draft_temp=0.5,
           checks={"judge": "STANDARD MODE: keep it short and useful. Lead with the answer; one example; no padding."}),
)

# ----------------------------------------------------------------------------- V (verified): facts that must be right
VERIFIED = ModePlan(
    "verified", "V (verified)",
    "Most model FAMILIES of any mode (gpt-oss, qwen, nemotron, gemma, ernie, glm, mistral, gemini) so no two checks share "
    "a blind spot; the drafters avoid the judge's model; the refiner is another family than the judge.",
    {
        "architect": use("gemma-4-31b-g", "architect", ["gpt-oss-120b", "nemotron-super-vl", "gemini-3.1-flash-lite"]),
        "theorist": use("gpt-oss-120b", "theorist", ["gemma-4-31b-g", "nemotron-ultra", "qwen3.8-27b", "cf-gpt-oss-120b"]),
        "empiricist": use("qwen3.8-27b", "empiricist", ["gemma-4-26b-g", "particle-1", "gpt-oss-120b"]),
        "specialist": use("nemotron-ultra", "researcher", ["gemma-4-26b-g", "gpt-oss-20b", config.CODER]),
        "pattern": use(config.PATTERN, "pattern_finder", ["gemini-3.5-flash-lite", "gpt-oss-20b", "nemotron-super-vl"]),
        "skeptic": use("gpt-oss-20b", "skeptic", ["gemini-3.1-flash-lite", "nemotron-lightning"]),
        "debater": use("gpt-oss-120b", "debater", ["gemini-3.8-flash", "nemotron-ultra", config.HEAVY_FALLBACK]),
        "judge": use("gemini-3.8-flash", "synthesizer", ["nemotron-ultra", "gpt-oss-120b", config.HEAVY_FALLBACK, "or-free-router"]),
        "method": use("qwen3.8-27b", "method_reviewer", ["gemini-3.5-flash-lite", "nemotron-ultra", "gpt-oss-120b"]),
        "evidence": use("gpt-oss-120b", "evidence_reviewer", ["gemini-3.5-flash-lite", config.HEAVY_FALLBACK, "nemotron-ultra"]),
        "refiner": use(config.WRITER, "refiner", ["gemini-3.8-flash", "gpt-oss-120b", "nemotron-ultra"]),
        "verifier": config.VERIFIER,
    },
    [
        use("gemma-4-31b-g", "judge", ["gpt-oss-20b", "ernie-5.5-flash"]),
        use("ernie-5.5-flash", "judge", ["gemini-3.5-flash-lite", "gpt-oss-120b"]),
        use(config.CODER, "judge", ["gemini-3.5-flash-lite", "qwen3.8-27b", "ling-3.2-flash"]),
    ],
    Policy(depth="deep", specialist="always", pattern="always", falsifiers=(3, 3), debate="always", debate_rounds=(1, 2),
           reviewers_fast=("method", "evidence"), reviewers_deep=("method", "evidence"), research="must", max_sources=6,
           code_proofs="always", draft_temp=0.3, low_conf_warn=True,
           checks={
               "judge": "V MODE: only claims that SURVIVED the falsifiers (or are backed by a source / code proof) are stated as "
                        "facts. Everything else is labelled (unsure) or dropped. CONFIDENCE high only if two independent checks agree.",
               "falsifier": "V MODE: attack the claim the answer depends on most first. Numbers, dates, names: look for the "
                            "exact value in the sources; a mismatch is BROKEN.",
               "evidence": "V MODE: flag every factual sentence with no source, proof or derivation behind it (kind: unsupported).",
           }),
)

# ----------------------------------------------------------------------------- PHYSICS: derivations, units, sanity checks
PHYSICS = ModePlan(
    "physics", "Physics",
    "Reasoning models draft (gpt-oss-120b derives, gemini 3.8 flash brings real-world numbers, nemotron-ultra first "
    "principles); falsifiers hit units and limiting cases; qwen reviews the method.",
    {
        "architect": use("gemma-4-31b-g", "architect", ["gpt-oss-20b", "nemotron-super-vl", "gemini-3.1-flash-lite"]),
        "theorist": use("gpt-oss-120b", "theorist", ["gemini-3.8-flash", "nemotron-ultra", "qwen3.8-27b", "cf-gpt-oss-120b"]),
        "empiricist": use("gemini-3.8-flash", "empiricist", ["qwen3.8-27b", "nemotron-super-vl", "gemma-4-31b-g"]),
        "specialist": use("nemotron-ultra", "first_principles", ["qwen3.8-27b", "gemini-3.5-flash-lite", config.CODER]),
        "pattern": use(config.PATTERN, "pattern_finder", ["gemma-4-31b-g", "gpt-oss-20b", "nemotron-ultra"]),
        "skeptic": use("gpt-oss-20b", "skeptic", ["gemini-3.1-flash-lite", "nemotron-lightning"]),
        "debater": use("gpt-oss-120b", "debater", ["gemini-3.8-flash", "nemotron-ultra", config.HEAVY_FALLBACK]),
        "judge": use("gemini-3.8-flash", "synthesizer", ["nemotron-ultra", "gpt-oss-120b", config.HEAVY_FALLBACK, "or-free-router"]),
        "method": use("qwen3.8-27b", "method_reviewer", ["gemini-3.5-flash-lite", "nemotron-ultra", "gpt-oss-120b"]),
        "evidence": use("gpt-oss-120b", "evidence_reviewer", ["gemini-3.5-flash-lite", config.HEAVY_FALLBACK, "nemotron-lightning"]),
        "refiner": use("gemini-3.8-flash", "refiner", ["gpt-oss-120b", "nemotron-ultra", config.HEAVY_FALLBACK]),
        "verifier": config.VERIFIER,
    },
    [
        use("qwen3.8-27b", "judge", ["gemini-3.5-flash-lite", "nemotron-ultra"]),
        use("gemma-4-31b-g", "judge", ["gpt-oss-20b", "ernie-5.5-flash"]),
        use(config.CODER, "judge", ["gemini-3.5-flash-lite", "gpt-oss-120b", "ling-3.2-flash"]),
    ],
    Policy(falsifiers=(2, 3), reviewers_fast=("method",), research="auto", max_sources=4,
           code_proofs="always", draft_temp=0.4,
           checks={
               "judge": "PHYSICS MODE: every equation with units; one dimension check; one order-of-magnitude sanity check "
                        "against a known value; say in which regime the law stops holding.",
               "falsifier": "PHYSICS MODE: first try units/dimensions, then limiting cases (zero, infinity, symmetry), then a "
                            "known measured value.",
               "method": "PHYSICS MODE: check that every symbol is defined, units balance in every step and the approximation used is named.",
           }),
)

# ----------------------------------------------------------------------------- MATH: exact, step by step
MATH = ModePlan(
    "math", "Math",
    "The strongest reasoners only: gpt-oss-120b + qwen3.8 derive, nemotron-ultra is the specialist, falsifiers try "
    "counter-examples, qwen re-derives every step as methodology reviewer. Little web research (math rarely needs it).",
    {
        "architect": use("gpt-oss-20b", "architect", ["gemini-3.1-flash-lite", "nemotron-lightning", "gemma-4-31b-g"]),
        "theorist": use("gpt-oss-120b", "theorist", ["gemini-3.8-flash", "nemotron-ultra", "qwen3.8-27b", "cf-gpt-oss-120b"]),
        "empiricist": use("qwen3.8-27b", "empiricist", ["gemini-3.8-flash", "particle-1", "gpt-oss-120b", config.CODER]),
        "specialist": use("nemotron-ultra", "logic_math", ["gpt-oss-120b", "gemini-3.8-flash", config.CODER]),
        "pattern": use("gemini-3.5-flash-lite", "pattern_finder", ["gpt-oss-20b", config.HEAVY_FALLBACK, "nemotron-super-vl"]),
        "skeptic": use("gemini-3.1-flash-lite", "skeptic", ["gpt-oss-20b", "nemotron-lightning"]),
        "debater": use("gpt-oss-120b", "debater", ["gemini-3.8-flash", "nemotron-ultra", config.HEAVY_FALLBACK]),
        "judge": use("gemini-3.8-flash", "synthesizer", ["nemotron-ultra", "gpt-oss-120b", config.HEAVY_FALLBACK, "or-free-router"]),
        "method": use("qwen3.8-27b", "method_reviewer", ["gemini-3.8-flash", "nemotron-ultra", "gpt-oss-120b"]),
        "evidence": use("gpt-oss-20b", "evidence_reviewer", ["gemini-3.5-flash-lite", "nemotron-lightning"]),
        "refiner": use("gemini-3.8-flash", "refiner", ["gpt-oss-120b", "nemotron-ultra"]),
        "verifier": config.VERIFIER,
    },
    [
        use("nemotron-ultra", "judge", ["qwen3.8-27b", "gemini-3.8-flash"]),
        use("gpt-oss-20b", "judge", ["gemini-3.5-flash-lite", "ling-3.2-flash"]),
        use(config.CODER, "judge", ["gemma-4-31b-g", "gpt-oss-120b", "nemotron-super-vl"]),
    ],
    Policy(pattern="always", falsifiers=(2, 3), reviewers_fast=("method",), reviewers_deep=("method", "evidence"),
           research="auto", max_sources=2, code_proofs="always", draft_temp=0.2,
           checks={
               "judge": "MATH MODE: exact result first (fractions, surds), then a decimal. Show the check: substitute the "
                        "answer back or solve a second way. Box or bold the final result.",
               "falsifier": "MATH MODE: try a counter-example, a small case (n = 0, 1, 2) and a sign / domain error first.",
               "method": "MATH MODE: re-derive each step yourself; any step that does not follow is high severity.",
           }),
)

# ----------------------------------------------------------------------------- BUSINESS: numbers, assumptions, risks
BUSINESS = ModePlan(
    "business", "Business",
    "Knowledge-work models: kimi-k3.1-pro as business specialist (NVIDIA quota, not OpenRouter), gemini 3.8 flash for "
    "market facts, ernie as backup; always researches; the evidence reviewer checks every number.",
    {
        "architect": use("gemini-3.1-flash-lite", "architect", ["gpt-oss-20b", "ernie-5.5-flash"]),
        "theorist": use("gpt-oss-120b", "theorist", ["gemini-3.8-flash", "nemotron-ultra", config.HEAVY_FALLBACK]),
        "empiricist": use("gemini-3.8-flash", "empiricist", ["gpt-oss-20b", "ernie-5.5-flash", "gemma-4-31b-g"]),
        "specialist": use(config.WRITER, "business", ["gemma-4-26b-g", "gpt-oss-20b", "ernie-5.5-flash", "gemini-3.1-flash-lite"]),
        "pattern": use("nemotron-ultra", "pattern_finder", ["gemini-3.5-flash-lite", "gpt-oss-120b"]),
        "skeptic": use("gpt-oss-20b", "skeptic", ["gemini-3.5-flash-lite", "nemotron-lightning"]),
        "debater": use("gpt-oss-120b", "debater", ["gemini-3.8-flash", "nemotron-ultra", config.HEAVY_FALLBACK]),
        "judge": use("gemini-3.8-flash", "synthesizer", [config.HEAVY_FALLBACK, "nemotron-ultra", "gpt-oss-120b", "or-free-router"]),
        "method": use("qwen3.8-27b", "method_reviewer", ["gemini-3.5-flash-lite", "nemotron-ultra"]),
        "evidence": use("gpt-oss-120b", "evidence_reviewer", ["gemini-3.5-flash-lite", config.HEAVY_FALLBACK, "nemotron-ultra"]),
        "refiner": use("gemini-3.8-flash", "refiner", ["gpt-oss-120b", "nemotron-ultra", config.HEAVY_FALLBACK]),
        "verifier": config.VERIFIER,
    },
    [
        use("qwen3.8-27b", "judge", ["gemini-3.5-flash-lite", "ernie-5.5-flash"]),
        use("gemma-4-31b-g", "judge", ["gpt-oss-120b", "ling-3.2-flash"]),
        use(config.CODER, "judge", ["gemini-3.5-flash-lite", "gpt-oss-20b", "nemotron-lightning"]),
    ],
    Policy(specialist="always", falsifiers=(2, 3), reviewers_fast=("evidence",), reviewers_deep=("evidence", "method"),
           research="must", max_sources=6, code_proofs="never", draft_temp=0.6,
           checks={
               "judge": "BUSINESS MODE: every number has a source [S#] or is labelled (assumption) / (estimate) with a range. "
                        "Give the unit economics, the 2-3 biggest risks and the first concrete step. No generic advice.",
               "falsifier": "BUSINESS MODE: attack market sizes, growth rates, prices and margins first; check them against the sources.",
               "evidence": "BUSINESS MODE: every number without [S#] and without an (assumption)/(estimate) label is an issue.",
           }),
)

# ----------------------------------------------------------------------------- CODING: correct, runnable, tested
CODING = ModePlan(
    "coding", "Coding",
    "Coders first: qwen3.8-27b (best coder on the list) and glm-5.3-flash (specialist, NVIDIA), gpt-oss-120b for design, "
    "laguna (coding model) as a falsifier; qwen does the code review.",
    {
        "architect": use("gemma-4-31b-g", "architect", ["gpt-oss-20b", "particle-1", "gemini-3.1-flash-lite"]),
        "theorist": use("gpt-oss-120b", "theorist", ["gemini-3.8-flash", "nemotron-ultra", "cf-gpt-oss-120b"]),
        "empiricist": use("qwen3.8-27b", "empiricist", ["gemini-3.8-flash", "particle-1", "laguna-xs-2.1"]),
        "specialist": use(config.CODER, "coder_edge", ["gemini-3.8-flash", "nemotron-ultra", "gpt-oss-20b", "laguna-xs-2.1"]),
        "pattern": use(config.PATTERN, "pattern_finder", ["gemini-3.5-flash-lite", "gpt-oss-20b", "flint"]),
        "skeptic": use("gpt-oss-20b", "skeptic", ["gemini-3.1-flash-lite", "flint"]),
        "debater": use("gpt-oss-120b", "debater", ["gemini-3.8-flash", "nemotron-ultra", config.HEAVY_FALLBACK]),
        "judge": use("gemini-3.8-flash", "synthesizer", ["nemotron-ultra", "gpt-oss-120b", config.HEAVY_FALLBACK, "or-free-router"]),
        "method": use("qwen3.8-27b", "method_reviewer", ["gemini-3.8-flash", "particle-1", "gpt-oss-120b"]),
        "evidence": use("gpt-oss-120b", "evidence_reviewer", ["gemini-3.5-flash-lite", "nemotron-lightning"]),
        "refiner": use("gemini-3.8-flash", "refiner", ["qwen3.8-27b", "nemotron-ultra"]),
        "verifier": config.VERIFIER,
    },
    [
        use("qwen3.8-27b", "judge", ["gemma-4-31b-g", "particle-1"]),
        use("laguna-xs-2.1", "judge", ["gpt-oss-120b", "gemini-3.5-flash-lite", "nemotron-lightning"]),
        use("gemma-4-26b-g", "judge", ["gpt-oss-20b", "flint"]),
    ],
    Policy(specialist="always", falsifiers=(2, 3), reviewers_fast=("method",), research="auto", max_sources=3,
           code_proofs="always", draft_temp=0.3,
           checks={
               "judge": "CODING MODE: complete runnable code (imports included), then complexity, edge cases and a test. "
                        "Never call an API or flag you are not sure exists without saying so.",
               "falsifier": "CODING MODE: run the code in your head on edge inputs (empty, one item, huge, negative, "
                            "duplicates, None/unicode). A wrong output or crash is BROKEN.",
               "method": "CODING MODE: review it like a senior engineer: off-by-one, mutation, None handling, error paths, "
                         "complexity, security (injection, secrets). Each bug = one line with severity.",
           }),
)

PLANS: dict[str, ModePlan] = {p.mode: p for p in (STANDARD, VERIFIED, PHYSICS, MATH, BUSINESS, CODING)}


ALIASES = {"v": "verified"}  # UI mode id -> plan


def get(mode: str) -> ModePlan:
    m = (mode or "").strip().lower()
    return PLANS.get(ALIASES.get(m, m), STANDARD)


def plan_roles() -> list[tuple[str, object]]:
    rows = []
    for m, p in PLANS.items():
        rows += [(f"mode:{m}:{r}", p.chains[r]) for r in ROLE_KEYS]
        rows += [(f"mode:{m}:falsifier{i}", s) for i, s in enumerate(p.falsifiers, 1)]
    return rows


def validate() -> list[str]:
    problems = []
    for m, p in PLANS.items():
        missing = set(ROLE_KEYS) - set(p.chains)
        if missing:
            problems.append(f"mode {m}: missing roles {sorted(missing)}")
        if len(p.falsifiers) < max(p.policy.falsifiers):
            problems.append(f"mode {m}: policy wants {max(p.policy.falsifiers)} falsifiers, plan has {len(p.falsifiers)}")
    return problems + config.check_chains(plan_roles())


def describe(mode: str) -> dict:
    """Small summary for the council page / steps: role -> first model, plus the policy in words."""
    p = get(mode)
    pol = p.policy
    return {
        "mode": p.mode, "title": p.title, "why": p.why,
        "models": {r: p.chains[r].label for r in ROLE_KEYS if r != "verifier"},
        "falsifiers": [s.label for s in p.falsifiers],
        "policy": {
            "depth": pol.depth, "specialist": pol.specialist, "pattern": pol.pattern,
            "falsifiers": list(pol.falsifiers), "debate": pol.debate, "debate_rounds": list(pol.debate_rounds),
            "reviewers_fast": list(pol.reviewers_fast), "reviewers_deep": list(pol.reviewers_deep),
            "research": pol.research, "max_sources": pol.max_sources, "code_proofs": pol.code_proofs,
        },
    }


PLAN_PROBLEMS = validate()
