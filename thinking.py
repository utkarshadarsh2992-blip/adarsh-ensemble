"""Thinking by the weight of the question (every council mode; Standard never uses it).

Why: a thinking model that thinks hard on a big max_tokens is fine, but "medium" thinking on a tight budget, or
"high" thinking on a small one, ends as "empty answer (ran out of tokens while thinking)". So the app first weighs the
question on the phone (no model call), then every role call gets a thinking level that FITS its budget:

  weight  0 light   short / simple question             -> effort "low",    no extra tokens
          1 medium  normal question                      -> effort "medium", +THINK_EXTRA_TOKENS[1]
          2 heavy   long, many parts, maths / proofs ... -> effort "high",   +THINK_EXTRA_TOKENS[2]

  * Some roles never need deep thinking (Architect, Skeptic, Claims map, classifier, sub-topic split): always light.
    Falsifiers, reviewers, debater and the pattern finder: at most medium (STAGE_CAP).
  * The level is lowered until  answer budget + thinking extra  fits the model's tokens/min room (Groq 8K/min), so a
    heavy question never turns into a request that is skipped as too big or that thinks itself empty.
  * Only models whose thinking switch is KNOWN get a setting (THINK_PARAM); every other model is left as it is.
  * An empty answer is still retried once with LOWER thinking (llm._think_retry: "high"/"medium" -> "low").
The weight stays internal: it is not shown in the chat or the thinking steps.

To change a rule later, edit one line: THINK_PARAM (which models), EFFORT (names), THINK_EXTRA_TOKENS (budgets),
STAGE_CAP (roles).
"""
from __future__ import annotations

import contextvars
import re

LIGHT, MEDIUM, HEAVY = 0, 1, 2
EFFORT = {LIGHT: "low", MEDIUM: "medium", HEAVY: "high"}
THINK_EXTRA_TOKENS = {LIGHT: 0, MEDIUM: 1536, HEAVY: 4096}
# requests without a tokens/min limit (Gemini, OpenRouter, NVIDIA ...) are still kept under this many tokens
THINK_ROOM_MAX = 16384
# "<provider>:<model id prefix>" -> how that model's thinking is set. First match wins; no match = untouched.
#   effort     -> payload["reasoning_effort"] = "low" | "medium" | "high"   (Groq gpt-oss, Gemini OpenAI endpoint)
#   openrouter -> payload["reasoning"] = {"effort": ..., "exclude": True}   (OpenRouter's unified reasoning switch)
THINK_PARAM = (
    ("groq:openai/gpt-oss-safeguard", None),  # classifier: keeps its own "low"
    ("groq:openai/gpt-oss", "effort"),
    ("gemini:gemini-", "effort"),
    ("openrouter:", "openrouter"),
)
# stage name prefix -> highest weight that role may think with (others: the question's weight)
STAGE_CAP = (
    ("architect", LIGHT), ("skeptic", LIGHT), ("stripper", LIGHT), ("classify", LIGHT), ("guard", LIGHT),
    ("decompose", LIGHT),
    ("falsifier", MEDIUM), ("review", MEDIUM), ("debate", MEDIUM), ("panel:pattern_finder", MEDIUM),
    ("audit", MEDIUM), ("verifier", MEDIUM),
)
MODE_BONUS = {"math": 1, "physics": 1, "coding": 1, "v": 0, "verified": 0, "business": 0}

_weight: contextvars.ContextVar = contextvars.ContextVar("think_weight", default=None)

_MATH = re.compile(
    r"(\d\s*[\^*/=]\s*\d|[∫∑√π∞≈≤≥±]|\b(prove|proof|derive|derivation|integral|integrate|differentiat|derivative|"
    r"equation|theorem|lemma|matrix|eigen|probability|limit of|solve for|calculate|compute|sabit karo|hal karo|"
    r"nikalo|ganana)\b)", re.I)
_DEEP = re.compile(
    r"\b(step by step|in detail|detail mein|vistar|explain why|kyu|kyun|why does|compare|comparison|analy[sz]e|"
    r"analysis|trade-?offs?|pros and cons|strategy|architecture|design a|optimi[sz]e|root cause|research|evaluate|"
    r"critique|implications?|samjhao|samjha do|deep|gehra|tulna)\b", re.I)
_CODE = re.compile(r"(```|\bdef |\bclass |function\s*\(|=>|\bimport |traceback|exception|stack trace|segfault|"
                   r"\bbug\b|\berror\b|\bcompile)", re.I)
_PART = re.compile(r"^\s*(\d+[.)]|[-*•])\s+\S", re.M)


def weigh(text: str, mode: str = "") -> int:
    """LIGHT / MEDIUM / HEAVY for a question, from its own text and the chat mode. No model call, no network."""
    t = text or ""
    n = len(t)
    score = MODE_BONUS.get((mode or "").lower(), 0)
    score += (n > 400) + (n > 1500) + (n > 4000)
    parts = t.count("?") + len(_PART.findall(t))
    score += (parts >= 3) + (parts >= 6)
    score += bool(_MATH.search(t)) + min(len(_DEEP.findall(t)), 2) + bool(_CODE.search(t))
    if n < 60 and score <= 1:
        return LIGHT
    return LIGHT if score <= 1 else MEDIUM if score <= 3 else HEAVY


def set_weight(level: int | None):
    """Set the weight for the rest of this request (asyncio tasks started later inherit it). Returns a reset token."""
    return _weight.set(level if level in (LIGHT, MEDIUM, HEAVY) else None)


def reset(token) -> None:
    _weight.reset(token)


def current() -> int | None:
    return _weight.get()


def param_for(provider: str, model: str) -> str | None:
    key = f"{provider}:{model}"
    for prefix, kind in THINK_PARAM:
        if key.startswith(prefix):
            return kind
    return None


def level_for(stage: str, weight: int | None = None) -> int | None:
    """The thinking level of one role call: the question's weight, capped for light roles. None = no weight set."""
    w = current() if weight is None else weight
    if w is None:
        return None
    s = stage or ""
    for prefix, cap in STAGE_CAP:
        if s.startswith(prefix):
            return min(w, cap)
    return w


def apply(kind: str, extra: dict, level: int) -> dict:
    out = dict(extra)
    if kind == "effort":
        out["reasoning_effort"] = EFFORT[level]
    elif kind == "openrouter":
        out["reasoning"] = {"effort": EFFORT[level], "exclude": True}
    return out


def plan(provider: str, model: str, extra: dict, max_tokens: int | None, est: int, tpm: int,
         stage: str) -> tuple[int | None, dict, int | None]:
    """(max_tokens, extra, level) for one model attempt. Unchanged when no weight is set (Standard, tools, tests),
    when the model has no known thinking switch, or when the caller gave no token budget."""
    level = level_for(stage)
    kind = param_for(provider, model)
    if level is None or kind is None or not max_tokens:
        return max_tokens, extra, None
    room = (int(tpm * 0.9) - est) if tpm else THINK_ROOM_MAX
    while level > LIGHT and max_tokens + THINK_EXTRA_TOKENS[level] > room:
        level -= 1  # not enough room for that much thinking: think less, never think the answer away
    return max_tokens + THINK_EXTRA_TOKENS[level], apply(kind, extra, level), level
