"""Config: providers, model registry, role -> model chains, quota knobs.

Model IDs come from the free lists (OpenRouter ':free', Groq free plan, Gemini API), Nov 2026.
They change often: if a model starts failing with "model not found", re-check its ID.

How it works: every ROLE has a PRIMARY model plus FALLBACKS (a chain). If the primary is
rate-limited, out of daily quota, has no API key, or is gone, the next model in the chain
answers (see llm.py / health.py). That is what makes free quotas last longer.
"""
import os
import warnings
from dataclasses import dataclass, field, replace

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str  # OpenAI-compatible endpoint
    api_key_env: str

    @property
    def api_key(self) -> str:
        return os.getenv(self.api_key_env, "")


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
}


@dataclass(frozen=True)
class ModelSpec:
    label: str     # short name used in debug output / fallback lists
    provider: str  # key in PROVIDERS
    model: str     # model id at that provider
    role: str = ""  # key in prompts.ROLES (the "thinking style" of this member)
    extra: dict = field(default_factory=dict, compare=False, hash=False, repr=False)
    fallbacks: tuple = ()  # labels from REGISTRY, tried in order


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


def use(label: str, role: str, fallbacks=(), extra: dict | None = None) -> ModelSpec:
    """A registry model in a given role, with its fail-over chain."""
    for f in fallbacks:
        if f not in REGISTRY:
            raise KeyError(f"unknown fallback model label: {f}")
    base = REGISTRY[label]
    return replace(base, role=role, extra={**base.extra, **(extra or {})}, fallbacks=tuple(fallbacks))


# ----------------------------------------------------------------------------- role plan
# RULES (checked at startup by validate_plan(), see PLAN_PROBLEMS and GET /health):
#   1. every chain has models on ALL THREE providers (groq, openrouter, gemini)
#   2. the FIRST fallback is on a DIFFERENT provider than the primary
# So if a whole provider is down (or its key/quota is gone), the role still answers.
# Exception: GUARD (prompt-guard models exist only on Groq) -> see GUARD_LLM below.
# Big-input roles (stripper, judge): Groq is in the chain but is skipped when the input does
# not fit its 8K tokens/min, so those two really run on Gemini <-> OpenRouter.

# Drafting panel = 6 different model FAMILIES x 6 thinking styles.
# Order matters: the first 3 are used in "fast" mode, and they avoid OpenRouter completely.
PANEL: list[ModelSpec] = [
    # strict derivations: fast reasoning model
    use("gpt-oss-120b", "logic_math", ["gemini-3.8-flash", "nemotron-ultra", "qwen3.8-27b"]),
    # broad / research angle, long context
    use("gemini-3.8-flash", "researcher", ["gpt-oss-120b", "nemotron-super-vl", "gemma-4-31b-g"]),
    # algorithmic / boundary view: best coder on the list (LiveCodeBench v6 90.3)
    use("qwen3.8-27b", "coder_edge", ["gemini-3.8-flash", "particle-1", "gpt-oss-120b", "flint"]),
    # first principles: biggest brain (550B MoE; multi-step reasoning + planning)
    use("nemotron-ultra", "first_principles", ["gpt-oss-120b", "gemini-3.8-flash", "gemma-4-31b-g"]),
    # business: knowledge work + deep research tuned
    use("ernie-5.5-flash", "business", ["gemma-4-26b-g", "gpt-oss-20b", "gemini-3.1-flash-lite", "ling-3.2-flash"]),
    # planner: dense reasoning model with good instruction following
    use("gemma-4-31b-g", "planner", ["gpt-oss-20b", "gemma-4-31b", "gemini-3.1-flash-lite", "nemotron-lightning"]),
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
STRIPPER = use("gemini-3.1-flash-lite", "judge", ["nemotron-lightning", "gpt-oss-20b", "gemini-3.8-flash", "ling-3.2-flash"])
# writes the Python verification scripts: strongest coder.
VERIFIER = use("qwen3.8-27b", "coder_edge", ["gemini-3.8-flash", "particle-1", "gpt-oss-120b", "flint"])
# final judge / synthesizer: big context (claims + reports + proofs) -> Gemini first, not Groq (8K TPM).
JUDGE = use("gemini-3.8-flash", "judge", ["nemotron-ultra", "gpt-oss-120b", "or-free-router"])
SYNTHESIZER = use("gemini-3.8-flash", "synthesizer", ["nemotron-ultra", "gpt-oss-120b", "or-free-router"])

# Reserved (no text role yet): nemotron-super-vl / nemotron-nano-omni / qwen3.8-27b can read
# images; the tts / live / translate / lyria / recraft / rerank models are not chat models.


def chain_of(spec: ModelSpec) -> list[ModelSpec]:
    return [spec] + [REGISTRY[label] for label in spec.fallbacks]


def all_roles() -> list[tuple[str, ModelSpec]]:
    rows = [(f"panel:{s.role}", s) for s in PANEL]
    rows += [(f"falsifier{i + 1}", s) for i, s in enumerate(DEBATERS)]
    for name in ("CLASSIFIER", "STRIPPER", "VERIFIER", "JUDGE", "SYNTHESIZER"):
        rows.append((name.lower(), globals()[name]))
    return rows


def validate_plan() -> list[str]:
    problems = []
    for name, spec in all_roles() + [("guard_llm", GUARD_LLM)]:
        chain = chain_of(spec)
        missing = set(PROVIDERS) - {c.provider for c in chain}
        if missing:
            problems.append(f"{name}: no model on {', '.join(sorted(missing))}")
        if spec.fallbacks and REGISTRY[spec.fallbacks[0]].provider == spec.provider:
            problems.append(f"{name}: first fallback is on the same provider ({spec.provider})")
        labels = [c.label for c in chain]
        if len(set(labels)) != len(labels):
            problems.append(f"{name}: a model appears twice in its chain")
    return problems


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


# Android (Chaquopy): there is no usable `python` executable to spawn, so the code-proof sandbox
# cannot run. Everything else (panel, falsifiers, judge, linter) is unchanged.
ON_ANDROID = hasattr(sys, "getandroidapilevel") or sys.platform == "android" or "ANDROID_ARGUMENT" in os.environ
CODE_EXEC_SUPPORTED = not ON_ANDROID
MAX_DEBATE_ROUNDS = 2
MAX_USER_ANSWERS = 8

# Verified engine
VERIFY_TASKS = {"math", "science", "coding", "first_principles"}
MAX_CHECKS = 4
SANDBOX_TIMEOUT_S = int(os.getenv("SANDBOX_TIMEOUT_S", "10"))
SANDBOX_MEM_MB = int(os.getenv("SANDBOX_MEM_MB", "1024"))

# Input guard for pasted answers (flag + warn; never silently drops an answer)
GUARD_ENABLED = os.getenv("GUARD_ENABLED", "1") == "1"
GUARD_THRESHOLD = float(os.getenv("GUARD_THRESHOLD", "0.8"))
GUARD_CHUNK_CHARS = int(os.getenv("GUARD_CHUNK_CHARS", "1400"))
GUARD_MAX_CHUNKS = int(os.getenv("GUARD_MAX_CHUNKS", "20"))

# Timeouts / token budgets (reasoning models spend part of max_tokens on thinking)
PANEL_TIMEOUT_S = float(os.getenv("PANEL_TIMEOUT_S", "240"))
MIN_PANEL_SUCCESS = int(os.getenv("MIN_PANEL_SUCCESS", "2"))
PANEL_MAX_TOKENS = int(os.getenv("PANEL_MAX_TOKENS", "3000"))
FALSIFIER_MAX_TOKENS = int(os.getenv("FALSIFIER_MAX_TOKENS", "2500"))
FINAL_MAX_TOKENS = int(os.getenv("FINAL_MAX_TOKENS", "6000"))
APP_API_KEY = os.getenv("APP_API_KEY", "")  # if set, clients must send X-API-Key or Authorization: Bearer <key>

# ADARSH UI chat endpoint (/api/chat): how each chat message is answered
CHAT_ENGINE = os.getenv("CHAT_ENGINE", "verified")  # verified | simple
CHAT_MODE = os.getenv("CHAT_MODE", "deep")  # deep | fast (fast = fewer models, much cheaper on free quota)
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]

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


def tpm_limit(spec: ModelSpec) -> int:
    if spec.provider != "groq":
        return 0
    return TPM_LIMIT.get(spec.model, GROQ_TPM_DEFAULT)
