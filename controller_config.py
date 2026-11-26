"""Validated, data-only adapter for the ADARSH controller wire contract v1.

This module deliberately does not import config.py at module load time. Android calls
apply_files() from android_entry.init() after private paths are set, so the configuration
is applied before other engine/routing modules import their defaults.
"""
from __future__ import annotations

import copy
import json
import os
import hashlib
import re
import tempfile
import threading
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

SCHEMA_VERSION = 1
MAX_CONFIG_BYTES = 256 * 1024
MAX_MODEL_ID = 128
MAX_CONFIG_AGE_SECONDS = 30 * 86400
MODEL_ID_RE = re.compile(r"^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,127}$")
LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
PROVIDERS = {
    "groq": "api.groq.com",
    "openrouter": "openrouter.ai",
    "gemini": "generativelanguage.googleapis.com",
    "nvidia": "integrate.api.nvidia.com",
    "cloudflare": "api.cloudflare.com",
}
CORE = {"groq", "openrouter", "gemini"}
MODES = {"standard", "verified", "physics", "math", "business", "coding"}
ROLE_NAMES = {
    "architect", "theorist", "empiricist", "specialist", "pattern", "skeptic", "debater",
    "judge", "method", "evidence", "refiner", "verifier", "falsifier1", "falsifier2", "falsifier3",
}
UTILITY_NAMES = {
    "quick", "auditor", "master_writer", "master_auditor", "classifier", "stripper",
    "verifier", "judge", "synthesizer", "guard_llm",
}
QUALITY_ENUMS = {
    "truthLevel": {"strict", "balanced", "creative"},
    "factCheck": {"off", "auto", "always"},
}
QUALITY_BOOLEANS = {"builtInWebSearch", "audit", "ground", "research", "review", "debate"}
EXTRA_ENUMS = {
    "reasoning_effort": {"low", "medium", "high"},
    "reasoning_format": {"hidden", "raw", "parsed"},
}

_lock = threading.RLock()
_base_config: dict[str, Any] | None = None
_base_plans: dict[str, Any] | None = None
_last_revision: int | None = None


class ControllerConfigError(ValueError):
    """A remote document is invalid or violates a bundled routing invariant."""


def _object(value: Any, where: str) -> dict:
    if not isinstance(value, dict):
        raise ControllerConfigError(f"{where} must be an object")
    return value


def _keys(value: dict, allowed: set[str], where: str) -> None:
    extra = set(value) - allowed
    if extra:
        raise ControllerConfigError(f"{where} has unsupported fields")


def _text(value: Any, where: str, max_len: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or len(value) > max_len or (not allow_empty and not value.strip()):
        raise ControllerConfigError(f"{where} must be a string of at most {max_len} characters")
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ControllerConfigError(f"{where} contains control characters")
    return value


def _endpoint(provider: str, value: Any) -> str:
    raw = _text(value, f"providers.{provider}.base_url", 500)
    if raw != raw.strip() or any(c.isspace() for c in raw) or "%" in raw or "?" in raw or "#" in raw or "\\" in raw:
        raise ControllerConfigError("provider endpoint contains a forbidden URL component")
    try:
        parts = urlsplit(raw)
        decoded_path = unquote(parts.path)
        # Accessing .port also catches malformed port syntax; any explicit port is forbidden.
        explicit_port = parts.port is not None
    except ValueError as exc:
        raise ControllerConfigError("provider endpoint URL is malformed") from exc
    if (parts.scheme != "https" or parts.netloc.lower() != PROVIDERS[provider] or parts.hostname != PROVIDERS[provider]
            or parts.username is not None or parts.password is not None or explicit_port
            or parts.query or parts.fragment):
        raise ControllerConfigError("provider endpoint must use its fixed HTTPS host without credentials, port, query, or fragment")
    segments = decoded_path.split("/")
    if any(piece in (".", "..") for piece in segments) or "%2f" in parts.path.lower() or "%5c" in parts.path.lower():
        raise ControllerConfigError("provider endpoint path traversal is forbidden")
    if re.search(r"(?:^|/)chat/completions/?$", decoded_path, re.IGNORECASE):
        raise ControllerConfigError("base_url must not include /chat/completions")
    if provider == "cloudflare":
        if raw.count("{CLOUDFLARE_ACCOUNT_ID}") != 1 or "{" in raw.replace("{CLOUDFLARE_ACCOUNT_ID}", "") or "}" in raw.replace("{CLOUDFLARE_ACCOUNT_ID}", ""):
            raise ControllerConfigError("Cloudflare endpoint must contain only the account-id placeholder")
        if "/accounts/{CLOUDFLARE_ACCOUNT_ID}/" not in raw:
            raise ControllerConfigError("Cloudflare endpoint must keep the local account-id placeholder in its path")
    elif "{" in raw or "}" in raw:
        raise ControllerConfigError("provider endpoint placeholders are unsupported")
    return raw.rstrip("/")


def route_keys() -> set[str]:
    return {f"mode:{mode}:{role}" for mode in MODES for role in ROLE_NAMES} | {
        f"utility:{name}" for name in UTILITY_NAMES
    }


def validate_document(document: Any) -> dict:
    """Validate the wire schema and URL/model constraints without importing engine modules."""
    doc = _object(document, "config")
    _keys(doc, {"schema_version", "revision", "issued_at", "rollback_of", "providers", "models", "routes", "quality", "limits"}, "config")
    if type(doc.get("schema_version")) is not int or doc["schema_version"] != SCHEMA_VERSION:
        raise ControllerConfigError("unsupported schema_version")
    if "revision" in doc and (type(doc["revision"]) is not int or doc["revision"] < 1):
        raise ControllerConfigError("invalid revision")
    if "rollback_of" in doc and (type(doc["rollback_of"]) is not int or doc["rollback_of"] < 1):
        raise ControllerConfigError("invalid rollback marker")
    if "issued_at" in doc:
        _text(doc["issued_at"], "issued_at", 40)
        try: __import__("datetime").datetime.fromisoformat(doc["issued_at"].replace("Z", "+00:00"))
        except ValueError as exc: raise ControllerConfigError("invalid issued_at") from exc
    if type(doc.get("schema_version")) is not int or doc["schema_version"] != SCHEMA_VERSION:
        raise ControllerConfigError("unsupported schema_version")

    raw_providers = _object(doc.get("providers"), "providers")
    _keys(raw_providers, set(PROVIDERS), "providers")
    providers = {}
    for provider, raw in raw_providers.items():
        row = _object(raw, f"providers.{provider}")
        _keys(row, {"base_url"}, f"providers.{provider}")
        if "base_url" not in row:
            raise ControllerConfigError(f"providers.{provider}.base_url is required")
        providers[provider] = {"base_url": _endpoint(provider, row["base_url"])}

    rows = doc.get("models")
    if not isinstance(rows, list) or len(rows) > 100:
        raise ControllerConfigError("models must be an array of at most 100 entries")
    models, labels = [], set()
    for i, raw in enumerate(rows):
        row = _object(raw, f"models[{i}]")
        _keys(row, {"label", "provider", "model", "enabled", "extra"}, f"models[{i}]")
        if not {"label", "provider", "model", "enabled"}.issubset(row):
            raise ControllerConfigError(f"models[{i}] is missing a required field")
        label = _text(row["label"], f"models[{i}].label", 80)
        if not LABEL_RE.fullmatch(label):
            raise ControllerConfigError("model labels may contain only letters, digits, dot, underscore, and hyphen")
        if label in labels:
            raise ControllerConfigError("model labels must be unique")
        labels.add(label)
        provider = row["provider"]
        if not isinstance(provider, str) or provider not in PROVIDERS:
            raise ControllerConfigError(f"models[{i}].provider is unsupported")
        model = _text(row["model"], f"models[{i}].model", MAX_MODEL_ID)
        if not MODEL_ID_RE.fullmatch(model):
            raise ControllerConfigError("model IDs cannot contain whitespace")
        if type(row["enabled"]) is not bool:
            raise ControllerConfigError(f"models[{i}].enabled must be boolean")
        extra = row.get("extra", {})
        extra = _object(extra, f"models[{i}].extra")
        _keys(extra, set(EXTRA_ENUMS), f"models[{i}].extra")
        for key, allowed in EXTRA_ENUMS.items():
            if key in extra and extra[key] not in allowed:
                raise ControllerConfigError(f"models[{i}].extra.{key} is unsupported")
        models.append({"label": label, "provider": provider, "model": model,
                       "enabled": row["enabled"], "extra": dict(extra)})

    raw_routes = _object(doc.get("routes"), "routes")
    _keys(raw_routes, route_keys(), "routes")
    routes = {}
    for key, value in raw_routes.items():
        if not isinstance(value, list) or not 1 <= len(value) <= 10:
            raise ControllerConfigError(f"route {key} must contain 1..10 model labels")
        if any(not isinstance(label, str) or label not in labels for label in value):
            # A route may reference bundled labels not repeated in models; resolve them at runtime.
            if any(not isinstance(label, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", label) for label in value):
                raise ControllerConfigError(f"route {key} contains an invalid label")
        if len(set(value)) != len(value):
            raise ControllerConfigError(f"route {key} repeats a model label")
        routes[key] = list(value)

    quality = _object(doc.get("quality"), "quality")
    _keys(quality, set(QUALITY_ENUMS) | QUALITY_BOOLEANS, "quality")
    for key, value in quality.items():
        if key in QUALITY_ENUMS and value not in QUALITY_ENUMS[key]:
            raise ControllerConfigError(f"quality.{key} is unsupported")
        if key in QUALITY_BOOLEANS and type(value) is not bool:
            raise ControllerConfigError(f"quality.{key} must be boolean")

    raw_limits = _object(doc.get("limits"), "limits")
    _keys(raw_limits, set(PROVIDERS), "limits")
    limits = {}
    for provider, raw in raw_limits.items():
        row = _object(raw, f"limits.{provider}")
        _keys(row, {"daily_tokens", "daily_requests"}, f"limits.{provider}")
        clean = {}
        for key, value in row.items():
            if type(value) is not int or value < 0 or value > 10**12:
                raise ControllerConfigError(f"limits.{provider}.{key} must be a bounded non-negative integer")
            clean[key] = value
        limits[provider] = clean

    return {"schema_version": SCHEMA_VERSION, **({"revision": doc["revision"]} if "revision" in doc else {}), **({"issued_at": doc["issued_at"]} if "issued_at" in doc else {}), **({"rollback_of": doc["rollback_of"]} if "rollback_of" in doc else {}), "providers": providers, "models": models,
            "routes": routes, "quality": dict(quality), "limits": limits}


def _capture_base():
    global _base_config, _base_plans
    if _base_config is not None:
        return
    import config
    import mode_plans

    names = (
        "PANEL", "DEBATERS", "CLASSIFIER", "GUARD", "GUARD_LLM", "STRIPPER", "VERIFIER", "JUDGE",
        "SYNTHESIZER", "QUICK", "AUDITOR", "MASTER_WRITER", "MASTER_AUDITOR", "ARCHITECT", "THEORIST",
        "EMPIRICIST", "SPECIALISTS", "SKEPTIC", "DEBATER", "METHOD_REVIEWER", "EVIDENCE_REVIEWER", "REFINER",
        "AUDIT_ENABLED", "GROUND_ENABLED", "REVIEW_ENABLED", "DEBATE_ENABLED", "RESEARCH_ENABLED",
    )
    _base_config = {"providers": dict(config.PROVIDERS), "registry": dict(config.REGISTRY),
                    "values": {name: getattr(config, name) for name in names},
                    "plan_constants": {name: getattr(mode_plans, name) for name in MODES if hasattr(mode_plans, name)},
                    "plan_aliases": dict(mode_plans.ALIASES)}
    _base_plans = dict(mode_plans.PLANS)


def _reset_bundled():
    import config
    import mode_plans

    _capture_base()
    config.PROVIDERS.clear()
    config.PROVIDERS.update(_base_config["providers"])
    config.REGISTRY.clear()
    config.REGISTRY.update(_base_config["registry"])
    for name, value in _base_config["values"].items():
        setattr(config, name, value)
    mode_plans.PLANS.clear()
    mode_plans.PLANS.update(_base_plans)
    for name, value in _base_config["plan_constants"].items():
        setattr(mode_plans, name, value)
    mode_plans.ALIASES.clear()
    mode_plans.ALIASES.update(_base_config["plan_aliases"])
    config.STANDARD_CHAIN_LABELS = ("gpt-oss-120b",)
    config.REMOTE_QUALITY = {}
    config.REMOTE_LIMITS = {}
    config.REMOTE_MODEL_EXTRAS = {}
    config.CONTROLLER_CONFIG_ACTIVE = False
    config.PLAN_PROBLEMS = config.validate_plan()
    mode_plans.PLAN_PROBLEMS = mode_plans.validate()


def _resolve_default(spec, disabled: set[str], *, strict: bool, route: str = "bundled"):
    import config

    labels = [spec.label, *spec.fallbacks]
    if strict and any(label in disabled or label not in config.REGISTRY for label in labels):
        bad = [label for label in labels if label in disabled or label not in config.REGISTRY]
        raise ControllerConfigError(f"{route} references missing/disabled model label(s): {', '.join(bad)}; add an explicit replacement route")
    active = [label for label in labels if label not in disabled and label in config.REGISTRY]
    if not active:
        raise ControllerConfigError(f"disabled models leave a bundled route empty: {spec.label}")
    primary = replace(config.REGISTRY[active[0]], role=spec.role,
                      fallbacks=tuple(active[1:]))
    return primary


def _route_spec(base, labels: list[str], disabled: set[str], route: str):
    import config

    if not labels or any(label in disabled or label not in config.REGISTRY for label in labels):
        bad = [label for label in labels if label in disabled or label not in config.REGISTRY]
        raise ControllerConfigError(f"{route} references missing/disabled model label(s): {', '.join(bad) or '(empty)'}")
    return replace(config.REGISTRY[labels[0]], role=base.role, fallbacks=tuple(labels[1:]))


def _check_chain(spec, name: str):
    import config

    chain = config.chain_of(spec)
    labels = [entry.label for entry in chain]
    if len(labels) > 10 or len(set(labels)) != len(labels):
        raise ControllerConfigError(f"{name} has duplicate labels or exceeds ten entries")
    missing = CORE - {entry.provider for entry in chain}
    if missing:
        raise ControllerConfigError(f"{name} would break bundled fallback coverage")
    if len(chain) > 1 and chain[1].provider == chain[0].provider:
        raise ControllerConfigError(f"{name} first fallback must use a different provider")


def _apply_document(doc: dict):
    import config
    import mode_plans

    _reset_bundled()
    disabled = set()
    # Once a remote document is accepted its model array is authoritative. Bundled models are not silently
    # unioned back in; omitted labels remain absent and every effective route must explicitly stop referencing them.
    bundled_registry = dict(config.REGISTRY)
    config.REGISTRY.clear()
    remote_extras = {}
    for row in doc["models"]:
        label = row["label"]
        previous = bundled_registry.get(label)
        role = previous.role if previous else ""
        if previous is None or dict(previous.extra) != row["extra"]:
            remote_extras[label] = dict(row["extra"])
        config.REGISTRY[label] = config.ModelSpec(label=label, provider=row["provider"], model=row["model"],
                                                  role=role, extra=dict(row["extra"]))
        if not row["enabled"]:
            disabled.add(label)

    for provider, row in doc["providers"].items():
        config.PROVIDERS[provider] = replace(config.PROVIDERS[provider], base_url=row["base_url"])

    # Re-resolve all controller routes against the current registry. Effective defaults are exact bundled
    # chains; disabling one requires an explicit replacement for every affected route.
    routes = doc["routes"]
    utility_targets = {
        "quick": "QUICK", "auditor": "AUDITOR", "master_writer": "MASTER_WRITER", "master_auditor": "MASTER_AUDITOR",
        "classifier": "CLASSIFIER", "stripper": "STRIPPER", "verifier": "VERIFIER", "judge": "JUDGE",
        "synthesizer": "SYNTHESIZER", "guard_llm": "GUARD_LLM",
    }
    utility_by_target = {target: utility for utility, target in utility_targets.items()}
    # Legacy/non-controller bundles have no route key: safely filter disabled entries while preserving all invariants.
    for name in ("PANEL", "DEBATERS"):
        setattr(config, name, [_resolve_default(spec, disabled, strict=False, route=f"legacy:{name}") for spec in getattr(config, name)])
    scalar_names = ("CLASSIFIER", "GUARD", "GUARD_LLM", "STRIPPER", "VERIFIER", "JUDGE", "SYNTHESIZER", "QUICK",
                    "AUDITOR", "MASTER_WRITER", "MASTER_AUDITOR", "ARCHITECT", "THEORIST", "EMPIRICIST", "SKEPTIC",
                    "DEBATER", "METHOD_REVIEWER", "EVIDENCE_REVIEWER", "REFINER")
    for utility, target in utility_targets.items():
        key = f"utility:{utility}"
        if key in routes:
            base = _base_config["values"][target]
            spec = _route_spec(base, routes[key], disabled, key)
            _check_chain(spec, key)
            setattr(config, target, spec)
        else:
            setattr(config, target, _resolve_default(_base_config["values"][target], disabled, strict=True, route=key))
    for name in scalar_names:
        if name in utility_by_target:
            continue
        setattr(config, name, _resolve_default(getattr(config, name), disabled, strict=False, route=f"legacy:{name}") )
    config.SPECIALISTS = {mode: _resolve_default(spec, disabled, strict=False, route=f"legacy:specialist:{mode}")
                          for mode, spec in config.SPECIALISTS.items()}

    # Standard's direct one-call Groq path shares the utility:quick route; it must never fall through to another provider.
    quick_labels = [item.label for item in config.chain_of(config.QUICK) if item.provider == "groq"]
    if not quick_labels:
        raise ControllerConfigError("utility:quick has no enabled Groq model for Standard mode")
    config.STANDARD_CHAIN_LABELS = tuple(quick_labels if "utility:quick" in routes else quick_labels[:1])
    if any(config.REGISTRY[label].provider != "groq" for label in config.STANDARD_CHAIN_LABELS):
        raise ControllerConfigError("Standard direct route must use Groq models only")

    plan_constants = {"standard": "STANDARD", "verified": "VERIFIED", "physics": "PHYSICS", "math": "MATH",
                      "business": "BUSINESS", "coding": "CODING"}
    rebuilt = {}
    for mode, plan in mode_plans.PLANS.items():
        chains = {}
        for role in mode_plans.ROLE_KEYS:
            key = f"mode:{mode}:{role}"
            if key in routes:
                chains[role] = _route_spec(plan.chains[role], routes[key], disabled, key)
            else:
                chains[role] = _resolve_default(plan.chains[role], disabled, strict=True, route=key)
        falsifiers = []
        for i, base in enumerate(plan.falsifiers, 1):
            key = f"mode:{mode}:falsifier{i}"
            if key in routes:
                falsifiers.append(_route_spec(base, routes[key], disabled, key))
            else:
                falsifiers.append(_resolve_default(base, disabled, strict=True, route=key))
        updated = replace(plan, chains=chains, falsifiers=falsifiers)
        for role, spec in updated.chains.items():
            _check_chain(spec, f"mode:{mode}:{role}")
        for i, spec in enumerate(updated.falsifiers, 1):
            _check_chain(spec, f"mode:{mode}:falsifier{i}")
        rebuilt[mode] = updated
        setattr(mode_plans, plan_constants[mode], updated)
    mode_plans.PLANS.clear()
    mode_plans.PLANS.update(rebuilt)

    quality = doc["quality"]
    config.REMOTE_QUALITY = dict(quality)
    config.REMOTE_LIMITS = copy.deepcopy(doc["limits"])
    config.REMOTE_MODEL_EXTRAS = remote_extras
    flags = {"audit": "AUDIT_ENABLED", "ground": "GROUND_ENABLED", "research": "RESEARCH_ENABLED",
             "review": "REVIEW_ENABLED", "debate": "DEBATE_ENABLED"}
    for source, target in flags.items():
        if source in quality:
            setattr(config, target, quality[source])
    config.CONTROLLER_CONFIG_ACTIVE = True
    config.PLAN_PROBLEMS = config.validate_plan()
    mode_plans.PLAN_PROBLEMS = mode_plans.validate()
    if config.PLAN_PROBLEMS or mode_plans.PLAN_PROBLEMS:
        raise ControllerConfigError("validated config violates fallback-chain invariants")


def _read_candidate(path: str | None) -> tuple[dict | None, bytes | None, str | None]:
    if not path:
        return None, None, None
    try:
        with open(path, "rb") as stream:
            raw = stream.read(MAX_CONFIG_BYTES + 1)
        if not raw or len(raw) > MAX_CONFIG_BYTES:
            return None, None, "config document is empty or exceeds 256 KiB"
        parsed = json.loads(raw.decode("utf-8"))
        checked = validate_document(parsed)
        if checked.get("issued_at"):
            from datetime import datetime, timezone
            issued = datetime.fromisoformat(checked["issued_at"].replace("Z", "+00:00"))
            if (datetime.now(timezone.utc) - issued).total_seconds() > MAX_CONFIG_AGE_SECONDS:
                return None, None, "config document is stale"
        return checked, raw, None
    except ControllerConfigError as exc:
        return None, None, str(exc)[:240]
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError):
        return None, None, "config document could not be read as valid JSON"


def _atomic_write(path: str, raw: bytes) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=".controller-config-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.chmod(temp_path, 0o600)
        except OSError:
            pass
        os.replace(temp_path, path)
    finally:
        try:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        except OSError:
            pass


def apply_files(cache_path: str | None, pending_path: str | None = None) -> dict:
    """Apply a valid incoming document, otherwise a last-known-good cache, or bundled defaults."""
    global _last_revision
    with _lock:
        incoming, incoming_raw, incoming_error = _read_candidate(pending_path)
        cached, cached_raw, cached_error = _read_candidate(cache_path)
        candidates = []
        last_error = incoming_error or cached_error
        if incoming is not None:
            revision = incoming.get("revision")
            if revision is not None and _last_revision is not None and revision < _last_revision:
                incoming = None; incoming_raw = None; incoming_error = "config revision is older than the applied revision"
            else:
                candidates.append((incoming, incoming_raw, True))
        if cached is not None:
            candidates.append((cached, cached_raw, False))
        if not candidates:
            if _base_config is not None:
                _reset_bundled()
            result = {"ok": True, "source": "bundled", "active": False}
            if last_error:
                result["error"] = last_error
            return result
        for doc, raw, is_incoming in candidates:
            try:
                _apply_document(doc)
            except (ControllerConfigError, KeyError, TypeError, ValueError, AttributeError) as exc:
                last_error = str(exc)[:240]
                _reset_bundled()
                continue
            if is_incoming and cache_path and raw is not None:
                try:
                    _atomic_write(cache_path, raw)
                except OSError:
                    # The config is active for this session, but is not claimed to be cached LKG.
                    return {"ok": True, "source": "remote", "active": True, "cached": False,
                            "config_digest": hashlib.sha256(raw).hexdigest()}
                if pending_path:
                    try:
                        os.remove(pending_path)
                    except OSError:
                        pass
                if doc.get("revision") is not None: _last_revision = doc["revision"]
                return {"ok": True, "source": "remote", "active": True, "cached": True,
                        "config_digest": hashlib.sha256(raw).hexdigest()}
            if doc.get("revision") is not None: _last_revision = max(_last_revision or 0, doc["revision"])
            result = {"ok": True, "source": "cache", "active": True, "cached": True,
                      "config_digest": hashlib.sha256(raw).hexdigest()}
            if last_error:
                result["warning"] = last_error
            return result
        result = {"ok": True, "source": "bundled", "active": False}
        if last_error:
            result["error"] = last_error
        return result


def restore_bundled_for_test() -> None:
    """Reset mutable module state between offline unit tests; never touches user files."""
    with _lock:
        if _base_config is not None:
            _reset_bundled()
