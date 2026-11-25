"""Config: providers, model registry, role -> model chains, quota knobs.

Model IDs come from the free lists (OpenRouter ':free', Groq free plan, Gemini API), Nov 2026.
They change often: if a model starts failing with "model not found", re-check its ID.

How it works: every ROLE has a PRIMARY model plus FALLBACKS (a chain). If the primary is
rate-limited, out of daily quota, has no API key, or is gone, the next model in the chain
answers (see llm.py / health.py). That is what makes free quotas last longer.
"""
import json
import os
import warnings
from dataclasses import dataclass, field, replace

from dotenv import load_dotenv

load_dotenv()

# Every provider takes up to KEY_SLOTS keys (Settings > API keys: Groq 1-3, OpenRouter 1-3, Gemini 1-3, NVIDIA 1-3,
# Cloudflare 1-3 each with its own account id). Env names: GROQ_API_KEY, GROQ_API_KEY_2, GROQ_API_KEY_3 ...
# A call uses key 1; when that key hits its limit (429), needs credits (402), is rejected (401/403) or the server
# fails (5xx / network), the SAME model is tried with key 2, then key 3, and only then the next model in the chain.
# An empty slot is simply skipped (key 1 empty + key 2 set = key 2 is used first).
KEY_SLOTS = 3


def slot_env(name: str, slot: int) -> str:
    """Env name of key slot `slot` (1-based): slot 1 keeps the old name, so existing setups keep working."""
    return name if slot <= 1 else f"{name}_{slot}"


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str  # OpenAI-compatible endpoint; may contain {ENV_NAME} placeholders (see `needs`)
    api_key_env: str
    needs: tuple = ()  # extra env values the endpoint needs besides the key (Cloudflare: account id)

    def _need(self, env: str, slot: int) -> str:
        """An extra value (Cloudflare account id) for a slot. Slots 2/3 fall back to slot 1's value when their own
        is empty (several tokens of one account); a token of another account then just fails over."""
        own = os.getenv(slot_env(env, slot), "").strip()
        return own or (os.getenv(env, "").strip() if slot > 1 else "")

    def key(self, slot: int = 1) -> str:
        """The key in one slot, or "" when that slot is not fully configured (so it is skipped, not called)."""
        if any(not self._need(n, slot) for n in self.needs):
            return ""
        return os.getenv(slot_env(self.api_key_env, slot), "").strip()

    def slots(self) -> list[int]:
        """The configured key slots, in the order they are tried."""
        return [s for s in range(1, KEY_SLOTS + 1) if self.key(s)]

    def url_for(self, slot: int = 1) -> str:
        out = self.base_url
        for n in self.needs:
            out = out.replace("{" + n + "}", self._need(n, slot))
        return out

    @property
    def api_key(self) -> str:
        """The first configured key, or "" when no slot is fully configured (so the provider is skipped)."""
        for s in range(1, KEY_SLOTS + 1):
            k = self.key(s)
            if k:
                return k
        return ""

    @property
    def url(self) -> str:
        s = self.slots()
        return self.url_for(s[0] if s else 1)


PROVIDERS = {
    "openrouter": Provider(
        "openrouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"
    ),
    "groq": Provider("groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "gemini": Provider(
        "gemini",
        "https://generativelanguage.googleapis.com/v1beta/openai",
        "GEMINI_API_KEY",
    ),
    # Cloudflare Workers AI: OpenAI-compatible, needs an API token AND the account id in the URL.
    "cloudflare": Provider(
        "cloudflare",
        "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
        "CLOUDFLARE_API_TOKEN",
        needs=("CLOUDFLARE_ACCOUNT_ID",),
    ),
    # NVIDIA NIM hosted API (build.nvidia.com): OpenAI-compatible.
    "nvidia": Provider("nvidia", "https://integrate.api.nvidia.com/v1", "NVIDIA_API_KEY"),
}
# The fallback plan must always be answerable from these three; the other providers are optional extras.
CORE_PROVIDERS = ("groq", "openrouter", "gemini")
# Every env name a key screen / android_entry may set: 3 slots x (5 provider keys + the Cloudflare account id) + Tavily.
_SLOTTED_ENVS = ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
                 "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "NVIDIA_API_KEY")
SECRET_ENVS = tuple(slot_env(n, s) for s in range(1, KEY_SLOTS + 1) for n in _SLOTTED_ENVS) + ("TAVILY_API_KEY",)


def provider_keys(provider: str) -> list[tuple[int, str]]:
    """[(slot, key)] for every configured slot of a provider (voice / media code rotates over these)."""
    p = PROVIDERS[provider]
    return [(s, p.key(s)) for s in p.slots()]


@dataclass(frozen=True)
class ModelSpec:
    label: str     # short name used in debug output / fallback lists
    provider: str  # key in PROVIDERS
    model: str     # model id at that provider
    role: str = ""  # key in prompts.ROLES (the "thinking style" of this member)
    extra: dict = field(default_factory=dict, compare=False, hash=False, repr=False)
    fallbacks: tuple = ()  # labels from REGISTRY, tried in order
    key_slot: int = 0  # 0 = whichever key is configured first; 1-3 = that key slot only (see keyed())


def base_label(label: str) -> str:
    """"gpt-oss-120b#2" -> "gpt-oss-120b" (the registry label without the key slot)."""
    return label.split("#", 1)[0]


def keyed(spec: "ModelSpec", slot: int) -> "ModelSpec":
    """`spec` pinned to one key slot. Slot 1 keeps the plain label (same health / quota state as before multi-key);
    slots 2 and 3 get "#2" / "#3", so each key has its own cooldowns and daily counters."""
    base = base_label(spec.label)
    return replace(spec, key_slot=slot, label=base if slot <= 1 else f"{base}#{slot}")


# ----------------------------------------------------------------------------- registry
REGISTRY: dict[str, ModelSpec] = {}


def _reg(label: str, provider: str, model: str, extra: dict | None = None) -> None:
    REGISTRY[label] = ModelSpec(label, provider, model, extra=dict(extra or {}))


# Groq free plan. Per model: 30 RPM, 1K req/day, 8K tokens/min, 200K tokens/day.
# (safeguard: 3 RPM, 2K TPM. prompt-guard: 14.4K req/day, 15K TPM, 500K tokens/day.)
_reg("gpt-oss-120b", "groq", "openai/gpt-oss-120b", {"reasoning_effort": "medium"})
_reg("gpt-oss-20b", "groq", "openai/gpt-oss-20b", {"reasoning_effort": "medium"})
_reg("qwen3.8-27b", "groq", "qwen/qwen3.8-27b", {"reasoning_format": "hidden"})
_reg("safeguard-20b", "groq", "openai/gpt-oss-safeguard-20b", {"reasoning_effort": "low"})
_reg("prompt-guard-22m", "groq", "meta-llama/llama-prompt-guard-2-22m")
_reg("prompt-guard-86m", "groq", "meta-llama/llama-prompt-guard-2-86m")

# OpenRouter ':free': 20 RPM, and 50 req/day (1000/day once you bought >= 10 credits),
# shared by ALL free models together. So OpenRouter models are used sparingly.
_reg("nemotron-ultra", "openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free")
_reg("nemotron-lightning", "openrouter", "nvidia/nemotron-3.5-lightning:free")
_reg("nemotron-super-vl", "openrouter", "nvidia/nemotron-3.5-super-vl:free")
_reg("nemotron-nano-omni", "openrouter", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free")
_reg("gemma-4-31b", "openrouter", "google/gemma-4-31b-it:free")
_reg("gemma-4-26b", "openrouter", "google/gemma-4-26b-a4b-it:free")
_reg("ernie-5.5-flash", "openrouter", "baidu/ernie-5.5-flash-preview:free")
_reg("ling-3.2-flash", "openrouter", "inclusionai/ling-3.2-flash:free")
_reg("particle-1", "openrouter", "particle-ai/particle-1:free")
_reg("flint", "openrouter", "recursive/flint-v1.0:free")
_reg("lfm-3-1.7b", "openrouter", "liquid/lfm-3-1.7b:free")
_reg("or-free-router", "openrouter", "openrouter/free")  # random free model: last resort only

# Gemini API free tier (per-model limits are only shown in Google AI Studio, not in the docs).
_reg("gemini-3.8-flash", "gemini", "gemini-3.8-flash")
_reg("gemini-3.1-flash-lite", "gemini", "gemini-3.1-flash-lite", {"reasoning_effort": "low"})
# Gemma 4 straight from Google (saves OpenRouter's tiny daily quota). Not verified on the
# OpenAI-compatible endpoint: if it errors, the chain simply moves on and remembers it.
_reg("gemma-4-31b-g", "gemini", "gemma-4-31b-it")
_reg("gemma-4-26b-g", "gemini", "gemma-4-26b-a4b-it")
_reg("gemini-3.5-flash-lite", "gemini", "gemini-3.5-flash-lite", {"reasoning_effort": "low"})
# gemini-2.5-flash-lite is gone: Google answers HTTP 404 "no longer available to new users, use gemini-3.5-flash-lite"
# (Nov 2026). Its chain places now use gemini-3.5-flash-lite, or gemini-3.1-flash-lite where 3.5 lite is already there.

# Cloudflare Workers AI (10,000 neurons/day, resets 00:00 UTC; neurons are not tokens, so no local cap:
# real 429s move the chain on). bge-m3 is an embedding model, not a chat model, so it is not used here.
# IDs below follow the "@cf/<maker>/<model>" pattern; only gpt-oss-120b is confirmed in Cloudflare's docs.
_reg("cf-gpt-oss-120b", "cloudflare", "@cf/openai/gpt-oss-120b")
_reg("cf-gemma-4-26b", "cloudflare", "@cf/google/gemma-4-26b-a4b-it")

# NVIDIA NIM. mistralai/mistral-large-4-1t-a52b is confirmed on build.nvidia.com (Nov 2026). The other IDs are best guesses ("<maker>/<model>"); z-ai/glm-5-3 is confirmed.
# Settings > API keys > Test connection lists the IDs that do not exist and suggests the closest real ones.
_reg("mistral-large-4", "nvidia", "mistralai/mistral-large-4-1t-a52b")
_reg("laguna-xs-2.1", "nvidia", "poolside/laguna-xs-2.1")
_reg("glm-5-3-flash", "nvidia", "z-ai/glm-5-3-flash")

# one more OpenRouter free model (ID unverified, same note as above)
_reg("inkling-2-small", "openrouter", "thinkingmachines/inkling-2-small:free")


def use(label: str, role: str, fallbacks=(), extra: dict | None = None) -> ModelSpec:
    """A registry model in a given role, with its fail-over chain."""
    for f in fallbacks:
        if f not in REGISTRY:
            raise KeyError(f"unknown fallback model label: {f}")
    base = REGISTRY[label]
    return replace(base, role=role, extra={**base.extra, **(extra or {})}, fallbacks=tuple(fallbacks))


# ----------------------------------------------------------------------------- role plan
# RULES (checked at startup by validate_plan(), see PLAN_PROBLEMS and GET /health):
#   1. every chain has models on all three CORE providers (groq, openrouter, gemini); cloudflare/nvidia are extras
#   2. the FIRST fallback is on a DIFFERENT provider than the primary
# So if a whole provider is down (or its key/quota is gone), the role still answers.
# Exception: GUARD (prompt-guard models exist only on Groq) -> see GUARD_LLM below.
# Big-input roles (stripper, judge): Groq is in the chain but is skipped when the input does
# not fit its 8K tokens/min, so those two really run on Gemini <-> OpenRouter.

# Drafting panel = 6 different model FAMILIES x 6 thinking styles.
# Order matters: the first 3 are used in "fast" mode, and they avoid OpenRouter completely.
PANEL: list[ModelSpec] = [
    # strict derivations: fast reasoning model
    use("gpt-oss-120b", "logic_math", ["gemini-3.8-flash", "nemotron-ultra", "qwen3.8-27b", "cf-gpt-oss-120b"]),
    # broad / research angle, long context
    use("gemini-3.8-flash", "researcher", ["gpt-oss-120b", "nemotron-super-vl", "gemma-4-31b-g", "mistral-large-4"]),
    # algorithmic / boundary view: best coder on the list (LiveCodeBench v6 90.3)
    use("qwen3.8-27b", "coder_edge", ["gemini-3.8-flash", "particle-1", "gpt-oss-120b", "flint", "laguna-xs-2.1"]),
    # first principles: biggest brain (550B MoE; multi-step reasoning + planning)
    use("nemotron-ultra", "first_principles", ["gpt-oss-120b", "gemini-3.8-flash", "gemma-4-31b-g", "glm-5-3-flash"]),
    # business: knowledge work + deep research tuned
    use("ernie-5.5-flash", "business", ["gemma-4-26b-g", "gpt-oss-20b", "gemini-3.1-flash-lite", "ling-3.2-flash", "cf-gemma-4-26b"]),
    # planner: dense reasoning model with good instruction following
    use("gemma-4-31b-g", "planner", ["gpt-oss-20b", "gemma-4-31b", "gemini-3.1-flash-lite", "nemotron-lightning", "gemini-3.5-flash-lite"]),
    # pattern finder: names the known pattern / theorem / classic mistake the question matches, then solves with it.
    # LAST on purpose: "fast" mode uses only the first 3 panel members, so it never runs there.
    use("mistral-large-4", "pattern_finder", ["gemini-3.8-flash", "gpt-oss-120b", "nemotron-ultra", "cf-gpt-oss-120b"]),
]

# Popper falsifiers (first 2 are used in "fast" mode). Different families on purpose.
DEBATERS: list[ModelSpec] = [
    use("nemotron-ultra", "judge", ["qwen3.8-27b", "gemini-3.8-flash", "gemma-4-31b-g"]),
    use("gpt-oss-20b", "judge", ["gemma-4-26b-g", "ernie-5.5-flash", "gemini-3.1-flash-lite"]),
    use("gemma-4-31b-g", "judge", ["gpt-oss-120b", "nemotron-super-vl", "gemini-3.1-flash-lite"]),
]

# Utility roles
# task classifier: tiny job. The safeguard model is a policy-following classifier (as far as I
# know; the Groq page I read did not state its purpose), 3 RPM is plenty for one call/question.
CLASSIFIER = use("safeguard-20b", "judge", ["gemini-3.1-flash-lite", "lfm-3-1.7b", "gpt-oss-20b"])
# input guard for answers YOU paste (prompt-injection / jailbreak detector, 512-token window).
# Those models exist only on Groq, so when both fail guard.py falls back to GUARD_LLM below.
GUARD = use("prompt-guard-22m", "judge", ["prompt-guard-86m"])
# weaker fallback: a normal LLM asked (with the text wrapped as data) for an injection score.
GUARD_LLM = use("gemini-3.1-flash-lite", "judge", ["nemotron-lightning", "gpt-oss-20b"])
# tone-stripper: long input (all drafts) + strict JSON -> long-context, fast, cheap model.
STRIPPER = use("gemini-3.1-flash-lite", "judge", ["nemotron-lightning", "gpt-oss-20b", "gemini-3.8-flash", "ling-3.2-flash", "gemini-3.5-flash-lite"])
# writes the Python verification scripts: strongest coder.
VERIFIER = use("qwen3.8-27b", "coder_edge", ["gemini-3.8-flash", "particle-1", "gpt-oss-120b", "flint"])
# final judge / synthesizer: big context (claims + reports + proofs) -> Gemini first, not Groq (8K TPM).
JUDGE = use("gemini-3.8-flash", "judge", ["nemotron-ultra", "gpt-oss-120b", "mistral-large-4", "or-free-router"])
SYNTHESIZER = use("gemini-3.8-flash", "synthesizer", ["nemotron-ultra", "gpt-oss-120b", "mistral-large-4", "or-free-router"])
# Standard mode: ONE fast call, no council. Groq first (fastest), then Gemini, then OpenRouter.
QUICK = use("gpt-oss-120b", "synthesizer", ["gemini-3.1-flash-lite", "nemotron-lightning", "gpt-oss-20b", "gemini-3.8-flash"],
            {"reasoning_effort": "low"})
# Remote-compatible Standard route. The controller adapter replaces this only with validated Groq labels.
STANDARD_CHAIN_LABELS = ("gpt-oss-120b",)
# fact auditor: a DIFFERENT model family from the judge (Gemini) so they do not share blind spots. Its input is only the
# question + final answer, so it fits Groq's 8K tokens/min.
# The same chain also runs the Manual-mode grounding check, whose input is BIG (pasted answers + claims + master answer):
# the two Groq models are then skipped at once (8K tokens/min) and the Gemini lite models take over. They have their own
# quota, unlike gemini-3.8-flash which has just written the answer. nemotron-ultra (slow reasoning model, often an empty
# answer on a small token budget) comes late, gemini-3.8-flash last.
AUDITOR = use("gpt-oss-120b", "judge", ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "mistral-large-4", "nemotron-ultra", "qwen3.8-27b", "gemini-3.8-flash"])

# MANUAL MODE ONLY (master.py): the writer and the grounding check start on NVIDIA / Cloudflare so the Gemini and Groq
# free quotas are kept for Auto. The two are different model families (Mistral vs gpt-oss), like judge vs auditor.
# If a key is missing, an ID is wrong (404) or a quota is gone, the chain moves on to Gemini / Groq on its own.
MASTER_WRITER = use("mistral-large-4", "synthesizer", ["gemini-3.8-flash", "gpt-oss-120b", "nemotron-ultra", "cf-gpt-oss-120b"])
MASTER_AUDITOR = use("cf-gpt-oss-120b", "judge", ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "mistral-large-4", "gpt-oss-120b", "nemotron-lightning"])

# NOTE: the roles engine now takes its chains PER CHAT MODE from mode_plans.py (Standard, V, Physics, Math, Business,
# Coding each have their own combination). The chains below are the defaults kept for the other engines / tools.
# ROLES ENGINE (roles.py, the 11 role prompts in role_prompts.py). Same rules: all 3 core providers in every chain,
# first fallback on another provider. The two "fast" drafters (theorist, empiricist) are both on Groq but different
# families (gpt-oss vs qwen), so fast mode does not touch OpenRouter's 50/day quota for drafting.
ARCHITECT = use("gemma-4-31b-g", "architect", ["gpt-oss-120b", "nemotron-super-vl", "gemini-3.1-flash-lite"])
THEORIST = use("gpt-oss-120b", "theorist", ["gemini-3.8-flash", "nemotron-ultra", "qwen3.8-27b", "cf-gpt-oss-120b"])
EMPIRICIST = use("qwen3.8-27b", "empiricist", ["gemini-3.8-flash", "particle-1", "gpt-oss-120b", "laguna-xs-2.1"])
# deep mode only: one domain specialist picked by the chat mode, plus the pattern finder (PANEL[-1])
SPECIALISTS = {
    "standard": use("gemini-3.8-flash", "researcher", ["gpt-oss-120b", "nemotron-super-vl", "gemma-4-31b-g", "mistral-large-4"]),
    "verified": use("gemini-3.8-flash", "researcher", ["gpt-oss-120b", "nemotron-super-vl", "gemma-4-31b-g", "mistral-large-4"]),
    "physics": use("nemotron-ultra", "logic_math", ["gpt-oss-120b", "gemini-3.8-flash", "gemma-4-31b-g", "glm-5-3-flash"]),
    "math": use("nemotron-ultra", "logic_math", ["gpt-oss-120b", "gemini-3.8-flash", "gemma-4-31b-g", "glm-5-3-flash"]),
    "business": use("ernie-5.5-flash", "business", ["gemma-4-26b-g", "gpt-oss-20b", "gemini-3.1-flash-lite", "ling-3.2-flash"]),
    "coding": use("nemotron-ultra", "coder_edge", ["qwen3.8-27b", "gemini-3.8-flash", "particle-1", "laguna-xs-2.1"]),
}
SKEPTIC = use("gpt-oss-20b", "skeptic", ["gemini-3.1-flash-lite", "nemotron-lightning", "gemma-4-26b-g"])
DEBATER = use("gpt-oss-120b", "debater", ["gemini-3.8-flash", "nemotron-ultra", "mistral-large-4"])
METHOD_REVIEWER = use("qwen3.8-27b", "method_reviewer", ["gemini-3.5-flash-lite", "nemotron-ultra", "gpt-oss-120b"])
EVIDENCE_REVIEWER = use("gpt-oss-120b", "evidence_reviewer", ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "mistral-large-4", "nemotron-ultra", "gemini-3.8-flash"])
REFINER = use("gemini-3.8-flash", "refiner", ["nemotron-ultra", "gpt-oss-120b", "mistral-large-4", "or-free-router"])

# Reserved (no text role yet): nemotron-super-vl / nemotron-nano-omni / qwen3.8-27b can read
# images; the tts / live / translate / lyria / recraft / rerank models are not chat models.


def rotated(spec: ModelSpec) -> ModelSpec:
    """Second format repair may rotate models, but never proactively change providers.

    Use an existing same-provider fallback if present; otherwise retain the original primary.
    Real provider failover remains the responsibility of llm.chat after keys/models are exhausted.
    """
    label = next((label for label in spec.fallbacks if REGISTRY[label].provider == spec.provider), None)
    if label is None:
        return spec
    first = REGISTRY[label]
    return replace(first, role=spec.role, extra=first.extra,
                   fallbacks=tuple(other for other in spec.fallbacks if other != label) + (spec.label,))


def chain_of(spec: ModelSpec) -> list[ModelSpec]:
    return [spec] + [REGISTRY[label] for label in spec.fallbacks]


def all_roles() -> list[tuple[str, ModelSpec]]:
    rows = [(f"panel:{s.role}", s) for s in PANEL]
    rows += [(f"falsifier{i + 1}", s) for i, s in enumerate(DEBATERS)]
    for name in ("CLASSIFIER", "STRIPPER", "VERIFIER", "JUDGE", "SYNTHESIZER", "QUICK", "AUDITOR", "MASTER_WRITER", "MASTER_AUDITOR"):
        rows.append((name.lower(), globals()[name]))
    for name in ("ARCHITECT", "THEORIST", "EMPIRICIST", "SKEPTIC", "DEBATER", "METHOD_REVIEWER", "EVIDENCE_REVIEWER", "REFINER"):
        rows.append((f"roles:{name.lower()}", globals()[name]))
    rows += [(f"roles:specialist:{m}", s) for m, s in SPECIALISTS.items()]
    return rows


def check_chains(rows) -> list[str]:
    """The fallback rules for (name, spec) rows: all core providers, first fallback elsewhere, no model twice."""
    problems = []
    for name, spec in rows:
        chain = chain_of(spec)
        missing = set(CORE_PROVIDERS) - {c.provider for c in chain}
        if missing:
            problems.append(f"{name}: no model on {', '.join(sorted(missing))}")
        if spec.fallbacks and REGISTRY[spec.fallbacks[0]].provider == spec.provider:
            problems.append(f"{name}: first fallback is on the same provider ({spec.provider})")
        labels = [c.label for c in chain]
        if len(set(labels)) != len(labels):
            problems.append(f"{name}: a model appears twice in its chain")
    return problems


def validate_plan() -> list[str]:
    return check_chains(all_roles() + [("guard_llm", GUARD_LLM)])


PLAN_PROBLEMS = validate_plan()
if PLAN_PROBLEMS:
    warnings.warn("Fallback plan problems: " + "; ".join(PLAN_PROBLEMS))

# ----------------------------------------------------------------------------- knobs
import contextvars
import sys

# Stage progress for UIs (set per request by android_entry; a no-op everywhere else)
PROGRESS: contextvars.ContextVar = contextvars.ContextVar("progress", default=None)


def emit(msg: str) -> None:
    cb = PROGRESS.get()
    if cb:
        try:
            cb(msg)
        except Exception:
            pass


CALL_TAG = "\u0001call "  # marks a structured model-call line inside the plain progress text
PART_TAG = "\u0001part "  # one finished answer part {"n", "of", "text"}: the chat shows it at once (big answers)


def emit_part(event: dict) -> None:
    """A finished Part k/N of a long council answer, sent while the next part is still being written."""
    cb = PROGRESS.get()
    if not cb:
        return
    try:
        cb(PART_TAG + json.dumps(event, ensure_ascii=False))
    except Exception:
        pass


def emit_call(event: dict) -> None:
    """One model-call event for the chat UI's live panel: {"t": "try"|"ok"|"fail"|"dead", "stage", "model",
    "provider", "why", "secs"}. A client that does not know the tag simply shows it as a progress line."""
    cb = PROGRESS.get()
    if not cb:
        return
    try:
        cb(CALL_TAG + json.dumps(event, ensure_ascii=False))
    except Exception:
        pass


# Android (Chaquopy): there is no usable `python` executable to spawn, so the code-proof sandbox
# cannot run. Everything else (panel, falsifiers, judge, linter) is unchanged.
ON_ANDROID = hasattr(sys, "getandroidapilevel") or sys.platform == "android" or "ANDROID_ARGUMENT" in os.environ
CODE_EXEC_SUPPORTED = not ON_ANDROID
MAX_DEBATE_ROUNDS = 2
MAX_USER_ANSWERS = 8

# Verified engine
VERIFY_TASKS = {"math", "science", "coding", "first_principles"}
# Concept questions ("what is math", "kya hota hai ...") get a plain explanation instead of the
# Direct Core Truth / Verified Mechanism / Trap Warning format. EXPLAIN_STYLE=0 restores the old behaviour.
EXPLAIN_STYLE = os.getenv("EXPLAIN_STYLE", "1") == "1"
# If the judge drops a required section, ask again (second attempt on another model) before showing anything.
MAX_REPAIRS = int(os.getenv("MAX_REPAIRS", "2"))
# After the judge, a different model fact-checks the answer; high/medium-confidence errors are fixed by a rewrite.
# AUDIT=0 skips it (saves 1-2 model calls per question).
AUDIT_ENABLED = os.getenv("AUDIT", "1") == "1"
AUDIT_MAX_ISSUES = 6
# Manual mode builds ONE master answer only from the pasted answers (master.py). MASTER=0 restores the old manual flow.
MASTER_ENABLED = os.getenv("MASTER", "1") == "1"
LEARNER_PROFILE = os.getenv("LEARNER_PROFILE", "1") == "1"  # teach Utkarsh in his style (see prompts.LEARNER_PROFILE)
GROUND_ENABLED = os.getenv("GROUND", "1") == "1"  # grounding check + rewrite of the master answer
GROUND_MAX_ISSUES = 6
GROUND_MAX_TOKENS = int(os.getenv("GROUND_MAX_TOKENS", "3000"))  # reasoning models spend part of it on thinking: 1800 was too little
GROUND_TIMEOUT_S = float(os.getenv("GROUND_TIMEOUT_S", "60"))    # per model attempt (the check is optional: do not sit on it)
GROUND_BUDGET_S = float(os.getenv("GROUND_BUDGET_S", "150"))     # total for the whole chain; then the answer is shown unchecked
MAX_CHECKS = 4
SANDBOX_TIMEOUT_S = int(os.getenv("SANDBOX_TIMEOUT_S", "10"))
SANDBOX_MEM_MB = int(os.getenv("SANDBOX_MEM_MB", "1024"))

# Input guard for pasted answers (flag + warn; never silently drops an answer)
GUARD_ENABLED = os.getenv("GUARD_ENABLED", "1") == "1"
GUARD_THRESHOLD = float(os.getenv("GUARD_THRESHOLD", "0.8"))
GUARD_CHUNK_CHARS = int(os.getenv("GUARD_CHUNK_CHARS", "1400"))
GUARD_MAX_CHUNKS = int(os.getenv("GUARD_MAX_CHUNKS", "20"))

# Timeouts / token budgets (reasoning models spend part of max_tokens on thinking)
# Total time ONE council stage (draft, falsifier, judge, ...) may take, all fallbacks included. 480 s leaves room for
# a heavy model (300 s attempt) plus one fallback attempt.
PANEL_TIMEOUT_S = float(os.getenv("PANEL_TIMEOUT_S", "480"))
MIN_PANEL_SUCCESS = int(os.getenv("MIN_PANEL_SUCCESS", "2"))
PANEL_MAX_TOKENS = int(os.getenv("PANEL_MAX_TOKENS", "3000"))
FALSIFIER_MAX_TOKENS = int(os.getenv("FALSIFIER_MAX_TOKENS", "2500"))
FINAL_MAX_TOKENS = int(os.getenv("FINAL_MAX_TOKENS", "6000"))
# A thinking model can spend the whole max_tokens on thinking and return an empty answer (finish_reason "length").
# llm.py then asks the SAME model and key once more with a bigger budget (2x, at least +2048, at most this, and inside
# the model's tokens/min limit) and lighter thinking, before the chain moves on. If that key has no tokens/min room
# left this minute, the bigger request goes to the model's next key (each key has its own window). 0 turns it off.
THINK_RETRY_MAX_TOKENS = int(os.getenv("THINK_RETRY_MAX_TOKENS", "8192"))
# Slow providers (queued free models, big NVIDIA models) send nothing on a plain request until the whole answer is
# ready. Some phone networks drop such a silent connection: "network error: ReadError". These providers are asked
# with stream=true instead, so tokens / keep-alive comments keep the connection busy; the answer is assembled in
# llm.py and the rest of the app sees the same text. Comma list of provider names; "" = never stream.
STREAM_PROVIDERS = frozenset(
    p.strip() for p in os.getenv("LLM_STREAM_PROVIDERS", "openrouter,nvidia").split(",") if p.strip()
)
# TCP keep-alive probes after this many silent seconds on every model connection (llm.make_client): keeps the
# phone's / carrier's NAT entry alive while a model is still queued or thinking. 0 = off.
TCP_KEEPALIVE_S = int(os.getenv("TCP_KEEPALIVE_S", "15"))
# How long ONE model attempt (one model on one key) may take before the chain moves on. Plain request: until the whole
# answer arrives. Streamed providers (above): the longest silent gap; the whole stream may take at most 2x.
# MODEL_TIMEOUT_S overrides the default per registry label (all keys of that model); MODEL_TIMEOUTS="label=secs,..."
# adds or changes entries. A caller that passes its own short timeout (guard, grounding check, Standard agent,
# classifier) keeps it: those steps must fail fast. Every stage still has its own total limit (PANEL_TIMEOUT_S).
LLM_TIMEOUT_S = float(os.getenv("LLM_TIMEOUT_S", "120"))


def _timeouts(raw: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for part in raw.split(","):
        label, sep, secs = part.partition("=")
        try:
            if sep and label.strip() and float(secs) > 0:
                out[label.strip()] = float(secs)
        except ValueError:
            pass  # a typo in the setting must not stop the app
    return out


MODEL_TIMEOUT_S: dict[str, float] = {
    "gemini-3.8-flash": 200.0,  # long Judge / Synthesizer / Refiner answers: 120 s cut it off while it was still writing
    "mistral-large-4": 300.0,  # 1T-parameter NVIDIA model: long queue + slow writing
    "nemotron-ultra": 300.0,  # 550B free OpenRouter model: often queued before the first token
    **_timeouts(os.getenv("MODEL_TIMEOUTS", "")),
}


def model_timeout(spec: "ModelSpec") -> float:
    """Seconds one attempt of this model may take ("gemini-3.8-flash#2" uses the "gemini-3.8-flash" entry)."""
    return MODEL_TIMEOUT_S.get(base_label(spec.label), LLM_TIMEOUT_S)


APP_API_KEY = os.getenv("APP_API_KEY", "")  # if set, clients must send X-API-Key or Authorization: Bearer <key>

# ADARSH UI chat endpoint (/api/chat): how each chat message is answered
CHAT_ENGINE = os.getenv("CHAT_ENGINE", "roles")  # roles (11 role prompts) | verified (older 3-section engine) | simple
CHAT_MODE = os.getenv("CHAT_MODE", "deep")  # deep | fast (fast = fewer models, much cheaper on free quota)
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]

# Roles engine knobs
ROLE_MAX_TOKENS = int(os.getenv("ROLE_MAX_TOKENS", "1800"))       # architect, skeptic, debater, reviewers (short output + thinking)
REVIEW_ENABLED = os.getenv("REVIEW", "1") == "1"                    # methodology + evidence review + refiner after the judge
DEBATE_ENABLED = os.getenv("DEBATE", "1") == "1"                    # debater runs only when drafts clash on a FACT
# Research: web lookup before drafting (Wikipedia always, Tavily if TAVILY_API_KEY is set). RESEARCH=0 turns it off.
RESEARCH_ENABLED = os.getenv("RESEARCH", "1") == "1"
# Set only by controller_config after complete schema and fallback validation. Missing keys retain local request defaults.
REMOTE_QUALITY: dict = {}
REMOTE_LIMITS: dict = {}
REMOTE_MODEL_EXTRAS: dict = {}
CONTROLLER_CONFIG_ACTIVE = False
RESEARCH_TIMEOUT_S = float(os.getenv("RESEARCH_TIMEOUT_S", "8"))
RESEARCH_PER_QUERY = int(os.getenv("RESEARCH_PER_QUERY", "2"))
RESEARCH_CHARS = int(os.getenv("RESEARCH_CHARS", "900"))               # per source
RESEARCH_MAX_SOURCES = int(os.getenv("RESEARCH_MAX_SOURCES", "5"))
RESEARCH_TOTAL_CHARS = int(os.getenv("RESEARCH_TOTAL_CHARS", "3600"))  # all sources together (Groq: 8K tokens/min)

# Daily quotas we guard locally (0 = no local cap; we still fail over on real 429s).
OPENROUTER_RPD = int(os.getenv("OPENROUTER_RPD", "50"))  # set 1000 if you bought >= 10 credits
GROQ_RPD = int(os.getenv("GROQ_RPD", "1000"))             # per model
GROQ_TPD = int(os.getenv("GROQ_TPD", "200000"))           # per model
GEMINI_RPD = int(os.getenv("GEMINI_RPD", "0"))            # per model; check AI Studio, then set

# Groq tokens-per-minute per model. A request whose (input + max_tokens) would not fit is
# skipped instead of wasting a call; the next model in the chain takes it.
GROQ_TPM_DEFAULT = int(os.getenv("GROQ_TPM", "8000"))
TPM_LIMIT = {
    "openai/gpt-oss-safeguard-20b": 2000,
    "meta-llama/llama-prompt-guard-2-22m": 15000,
    "meta-llama/llama-prompt-guard-2-86m": 15000,
}


# Requests per minute we allow OURSELVES per quota key (see health.reserve_slot). 0 = no local cap, real 429s still fail over.
# Set a little under the real limit. OpenRouter's 20 RPM is shared by all :free models together.
OPENROUTER_RPM = int(os.getenv("OPENROUTER_RPM", "18"))
GROQ_RPM = int(os.getenv("GROQ_RPM", "25"))      # real: 30 per model
GEMINI_RPM = int(os.getenv("GEMINI_RPM", "9"))   # per model; the docs do not say: free tiers are often 10-15. If 429s remain, lower it
NVIDIA_RPM = int(os.getenv("NVIDIA_RPM", "30"))  # free dev tier is about 40
RPM_LIMIT = {"openai/gpt-oss-safeguard-20b": 3}  # per-model exceptions (Groq: safeguard is 3 RPM)
RL_MAX_WAIT_S = float(os.getenv("RL_MAX_WAIT_S", "12"))        # wait this long for a free slot, else try the next model
RL_ROUND_WAIT_S = float(os.getenv("RL_ROUND_WAIT_S", "45"))    # if EVERY model is only rate-limited, wait up to this long once

# Quota saving (see health.py). Stages that may use the LAST part of a daily quota (QUOTA_RESERVE_MARGIN):
CRITICAL_STAGES = ("judge", "repair", "refine", "revise", "synth", "single", "classify", "architect")
# Legacy compatibility setting; llm.balance now enforces provider-first order and never reorders
# a healthy primary behind another provider because of quota usage. Hard quota guards still apply.
QUOTA_BALANCE_AT = float(os.getenv("QUOTA_BALANCE_AT", "0"))
# Share of quota left (first model of every role) below which the roles engine saves on its own:
QUOTA_TIGHT = float(os.getenv("QUOTA_TIGHT", "0.35"))  # deep -> fast
QUOTA_LOW = float(os.getenv("QUOTA_LOW", "0.15"))      # fast, no debate, no reviewers (judge still answers)
QUOTA_AUTO = os.getenv("QUOTA_AUTO", "1") == "1"       # 0 = never switch on its own


def rpm_limit(spec: ModelSpec) -> int:
    if spec.model in RPM_LIMIT:
        return RPM_LIMIT[spec.model]
    return {"openrouter": OPENROUTER_RPM, "groq": GROQ_RPM, "gemini": GEMINI_RPM, "nvidia": NVIDIA_RPM}.get(spec.provider, 0)


def tpm_limit(spec: ModelSpec) -> int:
    if spec.provider != "groq":
        return 0
    return TPM_LIMIT.get(spec.model, GROQ_TPM_DEFAULT)
