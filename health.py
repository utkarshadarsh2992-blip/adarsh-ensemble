"""Per-model health, daily quota guard and call trace.

Why: free tiers are small (OpenRouter 50 req/day, Groq 200K tokens/day per model...).
Instead of burning retries on a model that is rate-limited or gone, we
  - put it in COOLDOWN (using Retry-After when the provider sends it),
  - stop using it once its local daily quota is (almost) used up,
  - skip providers whose API key is missing,
and the caller moves on to the next model in the chain.
Usage counters are saved to a small JSON file so a restart does not forget them.
"""
import base64
import contextvars
import copy
import datetime as dt
import hashlib
import hmac
import json
import os
import random
import re
import secrets
import threading
import time

import config
from config import PROVIDERS, ModelSpec

STATE_FILE = os.getenv("USAGE_FILE", ".usage.json")
MARGIN = float(os.getenv("QUOTA_MARGIN", "0.95"))  # stop at 95% of a daily quota
# Helper roles (drafters, skeptic, falsifiers, debater, reviewers...) stop earlier, so the last part of every daily
# quota stays free for the calls the answer can not do without (judge, format repair, refiner: see config.CRITICAL_STAGES).
RESERVE_MARGIN = float(os.getenv("QUOTA_RESERVE_MARGIN", "0.8"))
LEARN_MIN = int(os.getenv("QUOTA_LEARN_MIN", "20"))  # a daily 429 after fewer requests than this is not learned as the cap

_cool: dict[str, float] = {}       # model label -> unix time until which it is skipped
_prov_cool: dict[str, float] = {}  # provider -> unix time (network circuit breaker: the whole server is skipped)
_key_cool: dict[str, float] = {}   # key slot ("groq", "groq#2", ...) -> unix time (401 / 402 / daily cap of ONE key)
_streak: dict[str, int] = {}       # consecutive failures per model label
_perr: dict[str, dict[int, list[float]]] = {}  # provider -> key slot -> recent network failure timestamps
_trace: contextvars.ContextVar = contextvars.ContextVar("trace", default=None)
_rec: contextvars.ContextVar = contextvars.ContextVar("trace_record", default=False)
_stage: contextvars.ContextVar = contextvars.ContextVar("stage", default="")
_request_generation: contextvars.ContextVar = contextvars.ContextVar("request_generation", default=None)
MAX_PROMPT_CHARS = 12000  # per message kept in a recorded trace


def _today() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


HIST_DAYS = 14  # usage screen: daily totals per provider survive the day roll this long
MAX_DAILY_GENERATIONS = 45  # up to 15 active slots + 30 retired generations
_GEN_RE = re.compile(r"^[0-9a-f]{32}$")


def _new_salt() -> str:
    return base64.b64encode(secrets.token_bytes(32)).decode("ascii")


def _valid_salt(value) -> str:
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) == 32:
            return value
    except (ValueError, TypeError):
        pass
    return _new_salt()


def _parse_qkey(qkey: str) -> tuple[str, str, int]:
    base, slot = str(qkey), 1
    head, sep, tail = base.rpartition("#")
    if sep and tail.isdigit():
        base, slot = head, int(tail)
    prov, _, model = base.partition(":")
    return prov, model, slot


def _slot_key(provider: str, slot: int) -> str:
    return f"{provider}#{slot}"


def _bucket() -> dict:
    return {"req": {}, "tok": {}}


def _slot_ledger(box: dict, name: str) -> dict:
    slots = box.setdefault("slots", {})
    item = slots.get(name)
    if not isinstance(item, dict):
        item = {"generations": {}, "unknown": _bucket()}
        slots[name] = item
    if not isinstance(item.get("generations"), dict):
        item["generations"] = {}
    if not isinstance(item.get("unknown"), dict):
        item["unknown"] = _bucket()
    for metric in ("req", "tok"):
        if not isinstance(item["unknown"].get(metric), dict):
            item["unknown"][metric] = {}
    return item


def _increment(bucket: dict, metric: str, model: str, count: int) -> None:
    if metric not in ("req", "tok") or count <= 0:
        return
    counts = bucket.setdefault(metric, {})
    counts[model] = max(0, int(counts.get(model, 0) or 0)) + count


def _all_ledger_counts(item: dict, metric: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for gen in (item.get("generations") or {}).values():
        for model, value in (gen.get(metric) or {}).items():
            counts[model] = counts.get(model, 0) + max(0, int(value or 0))
    for model, value in ((item.get("unknown") or {}).get(metric) or {}).items():
        counts[model] = counts.get(model, 0) + max(0, int(value or 0))
    return counts


def _provider_totals(data: dict) -> tuple[dict[str, int], dict[str, int]]:
    req: dict[str, int] = {}
    tok: dict[str, int] = {}
    for slot_name, item in ((data.get("key_usage") or {}).get("slots") or {}).items():
        provider = str(slot_name).rsplit("#", 1)[0]
        if provider not in PROVIDERS:
            continue
        for metric, out in (("req", req), ("tok", tok)):
            total = sum(_all_ledger_counts(item, metric).values())
            out[provider] = out.get(provider, 0) + total
    return req, tok


def _reconcile_ledger(data: dict) -> bool:
    """Preserve any pre-ledger/manual counters as unknown, never as invented generation detail."""
    changed = False
    ledger = data.setdefault("key_usage", {"slots": {}})
    for metric in ("req", "tok"):
        for qkey, value in (data.get(metric) or {}).items():
            provider, model, slot = _parse_qkey(qkey)
            if provider not in PROVIDERS:
                continue
            amount = max(0, int(value or 0))
            item = _slot_ledger(ledger, _slot_key(provider, slot))
            counts = _all_ledger_counts(item, metric)
            # OpenRouter's quota counter covers every :free model; its ledger keeps model detail.
            tracked = sum(counts.values()) if provider == "openrouter" and not model else counts.get(model, 0)
            if amount > tracked:
                _increment(item["unknown"], metric, model, amount - tracked)
                changed = True
    return changed


def _prune_generations(data: dict) -> None:
    """Keep the daily ledger bounded; pruned counts remain explicitly unattributed."""
    box = data.get("key_usage")
    if not isinstance(box, dict):
        return
    state = data.get("key_generation_state") or {}
    entries = []
    for slot_name, item in (box.get("slots") or {}).items():
        provider, _, slot = str(slot_name).rpartition("#")
        active_id = (state.get(slot_name) or {}).get("id")
        for gen_id, record in (item.get("generations") or {}).items():
            is_active = gen_id == active_id if slot_name in state else bool(record.get("active"))
            entries.append((slot_name, gen_id, record, is_active,
                            str(record.get("since_day") or ""), float(record.get("created_at") or 0)))
    if len(entries) <= MAX_DAILY_GENERATIONS:
        return
    retired = sorted((e for e in entries if not e[3]), key=lambda e: (e[4], e[5], e[0], e[1]))
    drop = len(entries) - MAX_DAILY_GENERATIONS
    for slot_name, gen_id, record, _active, _since, _created in retired[:drop]:
        if not record:
            continue
        item = _slot_ledger(box, slot_name)
        for metric in ("req", "tok"):
            for model, value in (record.get(metric) or {}).items():
                _increment(item["unknown"], metric, str(model), max(0, int(value or 0)))
        item["generations"].pop(gen_id, None)


def _prepare_usage(data: dict) -> dict:
    """Migrate old slot counters to an explicitly unknown ledger without inventing key identities."""
    if not isinstance(data.get("req"), dict):
        data["req"] = {}
    if not isinstance(data.get("tok"), dict):
        data["tok"] = {}
    if not isinstance(data.get("key_usage"), dict) or data.get("key_ledger_version") != 1:
        data["key_usage"] = {"slots": {}}
        for metric in ("req", "tok"):
            for qkey, value in (data.get(metric) or {}).items():
                provider, model, slot = _parse_qkey(qkey)
                if provider not in PROVIDERS:
                    continue
                amount = max(0, int(value or 0))
                if amount:
                    item = _slot_ledger(data["key_usage"], _slot_key(provider, slot))
                    _increment(item["unknown"], metric, model, amount)
        data["key_ledger_version"] = 1
    else:
        if not isinstance(data["key_usage"].get("slots"), dict):
            data["key_usage"] = {"slots": {}}
        for slot_name in list(data["key_usage"]["slots"]):
            item = _slot_ledger(data["key_usage"], str(slot_name))
            generations = {}
            for gen_id, record in item["generations"].items():
                if not _GEN_RE.fullmatch(str(gen_id)) or not isinstance(record, dict):
                    continue
                clean = {"since_day": str(record.get("since_day") or "")[:10],
                         "active": bool(record.get("active")),
                         "created_at": float(record.get("created_at") or 0)}
                for metric in ("req", "tok"):
                    clean[metric] = {str(m)[:200]: max(0, int(n or 0))
                                     for m, n in (record.get(metric) or {}).items()}
                generations[str(gen_id)] = clean
            item["generations"] = generations
    data["key_generation_salt"] = _valid_salt(data.get("key_generation_salt"))
    if not isinstance(data.get("key_generation_state"), dict):
        data["key_generation_state"] = {}
    try:
        data["_sampled_at_ms"] = max(0, int(data.get("_sampled_at_ms") or 0))
    except (TypeError, ValueError, OverflowError):
        data["_sampled_at_ms"] = 0
    if not isinstance(data.get("hist"), list):
        data["hist"] = []
    for name in ("out", "gone", "feat", "truth", "learned"):
        if not isinstance(data.get(name), dict):
            data[name] = {}
    _prune_generations(data)
    return data


def _fresh(learned: dict | None = None, old: dict | None = None, hist: list | None = None) -> dict:
    # out:  quota key -> unix time a DAILY 429 said it is empty until (that model on that key).
    # gone: "provider:model" -> {"until", "why"}: the model does not exist / was retired (404), on every key.
    # Both are kept on disk (an app restart does not spend a request just to hear the same error again) and survive
    # the UTC day roll while still in the future: Gemini's day ends at midnight Pacific, not at midnight UTC.
    # learned: daily caps seen in real 429s; survive the day roll.
    now = time.time()
    old = old or {}
    out = {k: v for k, v in (old.get("out") or {}).items() if isinstance(v, (int, float)) and v > now}
    gone = {k: v for k, v in (old.get("gone") or {}).items()
            if isinstance(v, dict) and isinstance(v.get("until"), (int, float)) and v["until"] > now}
    return {"day": _today(), "req": {}, "tok": {}, "out": out, "gone": gone, "learned": dict(learned or {}),
            "feat": {}, "truth": {}, "hist": list(hist or [])[-HIST_DAYS:],
            "key_ledger_version": 1, "key_usage": {"slots": {}},
            "key_generation_salt": _valid_salt(old.get("key_generation_salt")),
            "key_generation_state": copy.deepcopy(old.get("key_generation_state") or {}),
            "_sampled_at_ms": max(0, int(old.get("_sampled_at_ms") or 0))}
def _provider_of(qkey: str) -> str:
    return qkey.split(":", 1)[0].split("#", 1)[0]


def _day_summary(data: dict) -> dict:
    """One finished day for the history: totals per provider + per feature + fact-check counts."""
    _reconcile_ledger(data)
    req, tok = _provider_totals(data)
    return {"day": str(data.get("day") or ""), "req": req, "tok": tok,
            "feat": dict(data.get("feat") or {}), "truth": dict(data.get("truth") or {}),
            "key_usage": copy.deepcopy(data.get("key_usage") or {"slots": {}})}


def _rolled_hist(data: dict) -> list:
    hist = [h for h in (data.get("hist") or []) if isinstance(h, dict)]
    has_key_history = bool(((data.get("key_usage") or {}).get("slots") or {}))
    if data.get("day") and (data.get("req") or data.get("tok") or has_key_history):
        hist.append(_day_summary(data))
    return hist[-HIST_DAYS:]


def _load() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            _prepare_usage(data)
            learned = data.get("learned") if isinstance(data.get("learned"), dict) else {}
            if data.get("day") != _today():
                return _fresh(learned, data, _rolled_hist(data))
            for k in ("req", "tok", "out", "gone", "feat", "truth"):
                if not isinstance(data.get(k), dict):
                    data[k] = {}
            data["learned"] = learned
            return data
    except (OSError, ValueError):
        pass
    return _fresh()


_usage: dict = _load()
# The engine runs model calls from several threads (Android: one asyncio loop per request + voice / media threads), so
# every change to the usage counters and every save happens under this lock (audit H8).
_usage_lock = threading.RLock()


def _roll() -> None:
    with _usage_lock:
        if _usage.get("day") != _today():
            learned = _usage.get("learned") or {}
            old = dict(_usage)
            hist = _rolled_hist(_usage)
            _usage.clear()
            _usage.update(_fresh(learned, old, hist))
            _save()


def _save() -> None:
    """Atomic write (temp file + os.replace): a crash or a parallel save can not leave a half-written file."""
    with _usage_lock:
        try:
            blob = json.dumps(_usage)
        except (TypeError, ValueError, RuntimeError):
            return
        tmp = f"{STATE_FILE}.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(blob)
            os.replace(tmp, STATE_FILE)
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass


def _sampled_at_locked() -> int:
    """Persist a strictly increasing report timestamp while the corresponding snapshot is locked."""
    sampled_at = max(int(time.time() * 1000), int(_usage.get("_sampled_at_ms") or 0) + 1)
    _usage["_sampled_at_ms"] = sampled_at
    _save()
    return sampled_at


def _generation_identity_values(provider: str, slot: int, key: str, account: dict) -> str | None:
    """Salt the exact credential/account snapshot used for a request; never retain its input values."""
    if not key:
        return None
    prov = PROVIDERS[provider]
    snapshot = {name: str((account or {}).get(name, "") or "") for name in prov.needs}
    if any(not value for value in snapshot.values()):
        return None
    material = json.dumps([provider, int(slot), key, snapshot], ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    salt = base64.b64decode(_usage["key_generation_salt"], validate=True)
    return hmac.new(salt, material, hashlib.sha256).digest()[:16].hex()


def _generation_identity(provider: str, slot: int) -> str | None:
    """Return a salted opaque identity; raw provider credentials are used only in this calculation."""
    prov = PROVIDERS[provider]
    key = prov.key(slot)
    if not key:
        return None
    account = {name: prov._need(name, slot) for name in prov.needs}
    return _generation_identity_values(provider, slot, key, account)


def capture_request_context(spec: ModelSpec, credential: str, account: dict | None = None) -> tuple:
    """Capture only provider/slot/opaque-generation/day for the exact HTTP credential snapshot."""
    slot = _slot(spec) or ((PROVIDERS[spec.provider].slots() or [1])[0])
    account = account or {}
    with _usage_lock:
        _roll()
        _sync_generations()
        generation = _generation_identity_values(spec.provider, slot, credential, account)
        if generation:
            name = _slot_key(spec.provider, slot)
            item = _slot_ledger(_usage.setdefault("key_usage", {"slots": {}}), name)
            record = item["generations"].get(generation)
            active_id = ((_usage.get("key_generation_state") or {}).get(name) or {}).get("id")
            if not isinstance(record, dict):
                record = {"since_day": _today(), "active": generation == active_id,
                          "created_at": time.time(), "req": {}, "tok": {}}
                item["generations"][generation] = record
            elif generation != active_id:
                record["active"] = False
            _prune_generations(_usage)
        return (spec.provider, slot, generation, _usage["day"])


def _clear_slot_quota(provider: str, slot: int) -> None:
    """Clear only the rotated slot's active quota counters and quota marks."""
    for name in ("req", "tok", "out", "learned"):
        box = _usage.setdefault(name, {})
        for qkey in list(box):
            qprov, _model, qslot = _parse_qkey(qkey)
            if qprov == provider and qslot == slot:
                box.pop(qkey, None)
    kid = provider if slot == 1 else f"{provider}#{slot}"
    _key_cool.pop(kid, None)
    with _slots_lock:
        for qkey in list(_slots):
            # Generation-scoped windows belong to already-selected credentials, not this replacement slot.
            owner = _generation_windows.get(qkey)
            if owner:
                continue
            qprov, _model, qslot = _parse_qkey(qkey)
            if qprov == provider and qslot == slot:
                events = _slots.get(qkey, [])
                generations = {ctx[2] for _when, _tokens, rid in events
                               if rid and (ctx := _reservation_context.get(rid))
                               and ctx[0] == provider and ctx[1] == slot and ctx[2]}
                if generations:
                    # Keep the full prior window for each generation with an outstanding request; this preserves
                    # rate-limit spacing for its in-flight calls without charging the replacement key's window.
                    for generation in generations:
                        retired_key = _generation_window_key(qkey, generation)
                        _generation_windows[retired_key] = (provider, slot, generation)
                        _slots.setdefault(retired_key, []).extend(events)
                _slots.pop(qkey, None)


def _generation_record(provider: str, slot: int, gen_id: str, since_day: str | None = None) -> dict:
    ledger = _usage.setdefault("key_usage", {"slots": {}})
    item = _slot_ledger(ledger, _slot_key(provider, slot))
    record = item["generations"].get(gen_id)
    if not isinstance(record, dict):
        record = {"since_day": since_day or _today(), "active": True, "created_at": time.time(),
                  "req": {}, "tok": {}}
        item["generations"][gen_id] = record
    record.setdefault("since_day", since_day or _today())
    record.setdefault("created_at", time.time())
    record["active"] = True
    record.setdefault("req", {})
    record.setdefault("tok", {})
    return record


def _sync_generations(changed_slots: set[int] | None = None, provider_filter: str | None = None) -> bool:
    """Compare configured slots to persisted identities; reset quota counters only on actual slot changes."""
    changed = False
    states = _usage.setdefault("key_generation_state", {})
    for provider, prov in PROVIDERS.items():
        if provider_filter and provider != provider_filter:
            continue
        for slot in range(1, config.KEY_SLOTS + 1):
            slot_name = _slot_key(provider, slot)
            current_id = _generation_identity(provider, slot)
            had_state = slot_name in states and isinstance(states.get(slot_name), dict)
            previous = states.get(slot_name) if had_state else {}
            previous_id = previous.get("id") if isinstance(previous, dict) else None
            if not had_state:
                changed = True  # persist the initial identity map even before the first request
            if had_state and previous_id != current_id:
                if changed_slots is not None:
                    changed_slots.add(slot)
                _clear_slot_quota(provider, slot)
                changed = True
                if previous_id:
                    old_item = _slot_ledger(_usage["key_usage"], slot_name)
                    old_record = old_item["generations"].get(previous_id)
                    if isinstance(old_record, dict):
                        old_record["active"] = False
            if current_id:
                item = _slot_ledger(_usage["key_usage"], slot_name)
                existing = item["generations"].get(current_id)
                if not isinstance(existing, dict):
                    changed = True
                since = (existing or {}).get("since_day") or (
                    previous.get("since_day") if previous_id == current_id else None) or _today()
                _generation_record(provider, slot, current_id, since)
                if previous_id != current_id:
                    # A credential re-added later in the same UTC day resumes its own quota, not another key's.
                    record = item["generations"][current_id]
                    for metric in ("req", "tok"):
                        restored = {}
                        for model, count in (record.get(metric) or {}).items():
                            qkey = _quota_name(provider, model, slot)
                            restored[qkey] = restored.get(qkey, 0) + max(0, int(count or 0))
                        _usage[metric].update(restored)
            elif previous_id:
                item = _slot_ledger(_usage["key_usage"], slot_name)
                old_record = item["generations"].get(previous_id)
                if isinstance(old_record, dict):
                    old_record["active"] = False
            states[slot_name] = {"id": current_id,
                                 "since_day": ((previous or {}).get("since_day") if previous_id == current_id else None)
                                 or (( _slot_ledger(_usage["key_usage"], slot_name)["generations"].get(current_id) or {}).get("since_day") if current_id else None)}
    _prune_generations(_usage)
    return changed


def _record_generation_count(provider: str, slot: int, gen_id: str | None, day: str,
                             metric: str, model: str, count: int) -> None:
    """Attach request/token usage to its captured generation, including a just-retired one."""
    if not gen_id or metric not in ("req", "tok") or count <= 0:
        return
    target = _usage if _usage.get("day") == day else None
    if target is None:
        target = next((row for row in _usage.get("hist", [])
                       if isinstance(row, dict) and row.get("day") == day), None)
        if target is None:
            return
        ledger = target.setdefault("key_usage", {"slots": {}})
        item = _slot_ledger(ledger, _slot_key(provider, slot))
    else:
        item = _slot_ledger(target.setdefault("key_usage", {"slots": {}}), _slot_key(provider, slot))
    record = item["generations"].get(gen_id)
    if not isinstance(record, dict):
        # The bounded daily archive may already have pruned this retired identity.
        _increment(item["unknown"], metric, model, count)
    else:
        _increment(record, metric, model, count)
    _prune_generations(target if target is _usage else {"key_usage": target.get("key_usage"),
                                                          "key_generation_state": {}})
    if target is not _usage:
        _, provider_tokens = _provider_totals({"key_usage": target.get("key_usage")})
        target["tok"] = provider_tokens


def _slot(spec: ModelSpec) -> int:
    return int(getattr(spec, "key_slot", 0) or 0)


def key_id(spec: ModelSpec) -> str:
    """Which API key a call uses: "groq" for key 1 (or an unpinned spec), "groq#2" / "groq#3" for the others."""
    n = _slot(spec)
    return spec.provider if n <= 1 else f"{spec.provider}#{n}"


def quota_key(spec: ModelSpec) -> str:
    # OpenRouter's daily limit is shared by all :free models; Groq/Gemini count per model. Every API key has its own
    # quota, so keys 2 and 3 count separately ("groq:openai/gpt-oss-120b#2"); key 1 keeps the old name.
    base = "openrouter" if spec.provider == "openrouter" else f"{spec.provider}:{spec.model}"
    n = _slot(spec)
    return base if n <= 1 else f"{base}#{n}"


def _slot_specs(spec: ModelSpec) -> list:
    """An unpinned spec stands for all of its provider's configured keys; a pinned one only for itself."""
    if _slot(spec):
        return [spec]
    slots = PROVIDERS[spec.provider].slots()
    return [config.keyed(spec, n) for n in slots] if len(slots) > 1 else [spec]


def _has_key(spec: ModelSpec) -> bool:
    prov = PROVIDERS[spec.provider]
    return bool(prov.key(_slot(spec)) if _slot(spec) else prov.api_key)


def _set_limit(spec: ModelSpec) -> int:
    """The daily request cap from config (0 = not known)."""
    return {
        "openrouter": config.OPENROUTER_RPD,
        "groq": config.GROQ_RPD,
        "gemini": config.GEMINI_RPD,
    }.get(spec.provider, 0)


def req_limit(spec: ModelSpec) -> int:
    """Config cap, else the cap learned from a real daily 429 (Gemini, NVIDIA, Cloudflare do not publish theirs)."""
    return _set_limit(spec) or int((_usage.get("learned") or {}).get(quota_key(spec), 0))


def tok_limit(spec: ModelSpec) -> int:
    return {"groq": config.GROQ_TPD}.get(spec.provider, 0)


def critical() -> bool:
    """Is the current call one the answer can not do without? (No stage set = direct call: treated as critical.)"""
    s = _stage.get() or ""
    return not s or s.startswith(config.CRITICAL_STAGES)


def used_frac(spec: ModelSpec) -> float:
    """How much of today's quota this model has used, 0..1 (0 when no cap is known). With several keys: the average
    over the keys (3 keys = 3x the quota)."""
    specs = _slot_specs(spec)
    if len(specs) > 1:
        return sum(_used_frac_one(s) for s in specs) / len(specs)
    return _used_frac_one(spec)


def _used_frac_one(spec: ModelSpec) -> float:
    _roll()
    key = quota_key(spec)
    if _usage["out"].get(key, 0) > time.time():
        return 1.0
    f = 0.0
    rl, tl = req_limit(spec), tok_limit(spec)
    if rl:
        f = max(f, _usage["req"].get(key, 0) / rl)
    if tl:
        f = max(f, _usage["tok"].get(key, 0) / tl)
    return min(f, 1.0)


def capped(spec: ModelSpec) -> bool:
    return bool(req_limit(spec) or tok_limit(spec))


def gone_key(spec: ModelSpec) -> str:
    return f"{spec.provider}:{spec.model}"


def _clock(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts).strftime("%H:%M")


def _quota_block(spec: ModelSpec, margin: float) -> str:
    key = quota_key(spec)
    gone = (_usage.get("gone") or {}).get(gone_key(spec))
    if gone and gone.get("until", 0) > time.time():
        return f"skipped today: {gone.get('why') or 'model not found'}"[:160]
    until = _usage["out"].get(key, 0)
    if until > time.time():
        return f"daily quota used up (skipped till {_clock(until)})"
    rl = req_limit(spec)
    if rl and _usage["req"].get(key, 0) >= rl * margin:
        return "daily request quota used up"
    tl = tok_limit(spec)
    if tl and _usage["tok"].get(key, 0) >= tl * margin:
        return "daily token quota used up"
    return ""


def available(spec: ModelSpec) -> tuple[bool, str]:
    prov = PROVIDERS[spec.provider]
    if not _has_key(spec):
        return False, f"{config.slot_env(prov.api_key_env, _slot(spec) or 1)} not set"
    now = time.time()
    if _prov_cool.get(spec.provider, 0) > now:
        return False, f"provider cooling down {int(_prov_cool[spec.provider] - now)}s"
    kid = key_id(spec)
    if _key_cool.get(kid, 0) > now:
        return False, f"key {kid} cooling down {int(_key_cool[kid] - now)}s"
    if _cool.get(spec.label, 0) > now:
        return False, f"cooling down {int(_cool[spec.label] - now)}s"
    _roll()
    why = _quota_block(spec, MARGIN)
    if why:
        return False, why
    if not critical() and min(RESERVE_MARGIN, MARGIN) < MARGIN:
        why = _quota_block(spec, RESERVE_MARGIN)
        if why:
            return False, f"last {int(round((1 - RESERVE_MARGIN) * 100))}% of today's quota kept for the judge"
    return True, ""


def pressure(chains) -> tuple[str, float]:
    """How tight today's quota is for the given role chains: ("ok" | "tight" | "low", share of quota left).
    Uses the first model of each chain (where the load goes) and only models with a known cap.
    "low" also when some role has no model left at all."""
    _roll()
    lefts, dead = [], False
    for spec in chains:
        chain = [spec] + [config.REGISTRY[label] for label in spec.fallbacks]
        live = [c for c in chain if PROVIDERS[c.provider].api_key]
        if not live:
            continue
        if all(capped(c) and used_frac(c) >= RESERVE_MARGIN for c in live):
            dead = True
        if PROVIDERS[spec.provider].api_key and capped(spec):
            lefts.append(1.0 - used_frac(spec))
    left = sum(lefts) / len(lefts) if lefts else 1.0
    if dead or left < config.QUOTA_LOW:
        return "low", left
    if left < config.QUOTA_TIGHT:
        return "tight", left
    return "ok", left


def wait_hint(specs) -> float | None:
    """Shortest remaining cooldown among models that are otherwise usable (key set, quota left)."""
    now = time.time()
    best = None
    for s in specs:
        if not _has_key(s):
            continue
        _roll()
        if _quota_block(s, MARGIN if critical() else min(RESERVE_MARGIN, MARGIN)):
            continue
        left = max(_cool.get(s.label, 0), _prov_cool.get(s.provider, 0), _key_cool.get(key_id(s), 0)) - now
        if left > 0 and (best is None or left < best):
            best = left
    return best


def note_request(spec: ModelSpec, accounting_context: tuple | None = None) -> None:
    """Count every HTTP attempt (providers may count failed ones too)."""
    with _usage_lock:
        _roll()
        _sync_generations()
        slot = _slot(spec) or ((PROVIDERS[spec.provider].slots() or [1])[0])
        slot_state = (_usage.get("key_generation_state") or {}).get(_slot_key(spec.provider, slot)) or {}
        generation, day = slot_state.get("id"), _usage["day"]
        if (isinstance(accounting_context, tuple) and len(accounting_context) == 4
                and accounting_context[0] == spec.provider and accounting_context[1] == slot):
            _provider, _slot_num, generation, day = accounting_context
        if generation:
            _record_generation_count(spec.provider, slot, generation, day, "req", spec.model, 1)
        # Retired in-flight calls are visible in their old ledger but never consume the replacement key's daily cap.
        active_id = ((_usage.get("key_generation_state") or {}).get(_slot_key(spec.provider, slot)) or {}).get("id")
        if generation == active_id and day == _usage["day"]:
            key = quota_key(spec)
            _usage["req"][key] = _usage["req"].get(key, 0) + 1
        _request_generation.set((spec.provider, slot, generation, day))
        feat = _usage.setdefault("feat", {})
        f = feature(_stage.get())
        feat[f] = feat.get(f, 0) + 1
        _save()


def feature(stage_name: str) -> str:
    """Which app feature a model call belongs to (usage screen). Unknown stages count as council work."""
    s = (stage_name or "").split(":", 1)[0]
    named = {"standard": "standard", "briefing": "briefing", "checks": "checks", "factcheck": "factcheck",
             "guard": "guard", "voice": "voice", "tts": "voice", "news": "news", "casual": "standard"}
    if s in named:
        return named[s]
    return "council" if s else "other"


def note_truth(res: dict) -> None:
    """A finished fact-check (truth.py): today's counts for the usage screen."""
    if not isinstance(res, dict):
        return
    with _usage_lock:
        _roll()
        t = _usage.setdefault("truth", {})
        t["answers"] = t.get("answers", 0) + 1
        for v in ("ok", "shak", "galat"):
            t[v] = t.get(v, 0) + int(res.get(v) or 0)
        _save()


def success(spec: ModelSpec, tokens: int) -> None:
    _streak[spec.label] = 0
    with _usage_lock:
        _perr.pop(spec.provider, None)
        _roll()
        _sync_generations()
        slot = _slot(spec) or ((PROVIDERS[spec.provider].slots() or [1])[0])
        captured = _request_generation.get()
        if (isinstance(captured, tuple) and len(captured) == 4
                and captured[0] == spec.provider and captured[1] == slot):
            _provider, _slot_num, generation, day = captured
        else:
            slot_state = (_usage.get("key_generation_state") or {}).get(_slot_key(spec.provider, slot)) or {}
            generation, day = slot_state.get("id"), _usage["day"]
        try:
            amount = max(0, int(tokens or 0))
        except (TypeError, ValueError, OverflowError):
            amount = 0
        if amount:
            _record_generation_count(spec.provider, slot, generation, day, "tok", spec.model, amount)
            active_id = ((_usage.get("key_generation_state") or {}).get(_slot_key(spec.provider, slot)) or {}).get("id")
            if day == _usage["day"] and generation == active_id:
                key = quota_key(spec)
                _usage["tok"][key] = _usage["tok"].get(key, 0) + amount
        _request_generation.set(None)
        _save()


def cooldown(spec: ModelSpec, seconds: float) -> None:
    _cool[spec.label] = time.time() + min(seconds, 86400)


def cooldown_provider(provider: str, seconds: float) -> None:
    _prov_cool[provider] = time.time() + min(seconds, 86400)


def cooldown_key(spec: ModelSpec, seconds: float) -> None:
    """Skip every model on THIS API key (bad key, no credits, the key's daily cap); the provider's other keys stay."""
    kid = key_id(spec)
    _key_cool[kid] = time.time() + min(seconds, 86400)


def provider_error(provider: str, key_slot: int = 0) -> None:
    """Open the network breaker only after EVERY configured key has failed recently.

    Repeated failures on key 1/2 must never hide an untouched key 3. Single-key providers
    retain their two-failure retry allowance. An omitted slot refers to the first configured key.
    """
    slots = PROVIDERS[provider].slots()
    if not slots:
        return
    slot = key_slot or slots[0]
    if slot not in slots:
        return
    now = time.time()
    with _usage_lock:
        recent = {s: [t for t in times if now - t < 60][-1:]
                  for s, times in _perr.get(provider, {}).items() if s in slots}
        recent.setdefault(slot, []).append(now)
        _perr[provider] = recent
        if all(recent.get(s) for s in slots) and sum(map(len, recent.values())) >= max(2, len(slots)):
            _perr.pop(provider, None)
            cooldown_provider(provider, 60)


def fail(spec: ModelSpec, base_seconds: float) -> None:
    """Escalating cooldown: base, 2x, 4x ... capped at 1 hour."""
    n = _streak.get(spec.label, 0) + 1
    _streak[spec.label] = n
    cooldown(spec, min(base_seconds * 2 ** (n - 1), 3600))


def next_reset(provider: str, now: float | None = None) -> float:
    """Unix time of the provider's next daily quota reset (config.DAILY_RESET_UTC_HOUR)."""
    now = time.time() if now is None else now
    hour = config.DAILY_RESET_UTC_HOUR.get(provider, 0)
    t = dt.datetime.fromtimestamp(now, dt.timezone.utc).replace(hour=hour, minute=0, second=0, microsecond=0)
    if t.timestamp() <= now:
        t += dt.timedelta(days=1)
    return t.timestamp()


def daily_skip_seconds(spec: ModelSpec, wait: float | None, now: float | None = None) -> float:
    """How long a model+key with a used-up DAILY quota is skipped. Providers with a rolling day (Groq: "try again in
    7m12s") are trusted; the others reset at a fixed hour, whatever short "retry in 34s" their message carries."""
    now = time.time() if now is None else now
    reset_in = next_reset(spec.provider, now) - now
    if wait and (spec.provider in config.DAILY_WAIT_TRUSTED or wait > reset_in):
        return max(wait, 60.0)
    return max(reset_in, 60.0)


def model_gone(spec: ModelSpec, why: str = "model not found") -> None:
    """The provider says this model does not exist (404 / retired): skip it on EVERY key for MODEL_GONE_SKIP_S,
    saved on disk, so neither a restart nor key 2 / key 3 spends a request on it again today."""
    until = time.time() + config.MODEL_GONE_SKIP_S
    for s in _slot_specs(spec):
        cooldown(s, config.MODEL_GONE_SKIP_S)
    cooldown(spec, config.MODEL_GONE_SKIP_S)
    with _usage_lock:
        _roll()
        _usage.setdefault("gone", {})[gone_key(spec)] = {"until": until, "why": str(why)[:120]}
        _save()


def forget_provider(provider: str) -> None:
    """A key of this provider was added / changed / removed: its old "quota used up" and "model gone" marks may not
    hold for the new key, so they are dropped (the worst case is one call that hears the same error again)."""
    changed_slots: set[int] = set()
    with _usage_lock:
        _roll()
        _sync_generations(changed_slots, provider)
        for name in ("out", "gone"):
            box = _usage.get(name) or {}
            for k in list(box):
                qprovider, _model, qslot = _parse_qkey(k)
                if qprovider == provider and (name == "gone" or not changed_slots):
                    box.pop(k, None)
        _save()
    for box in (_cool,):
        for label in [lb for lb in box if config.REGISTRY.get(config.base_label(lb)) is not None
                      and config.REGISTRY[config.base_label(lb)].provider == provider]:
            box.pop(label, None)
    if not changed_slots:
        for kid in [k for k in _key_cool if k == provider or k.startswith(provider + "#")]:
            _key_cool.pop(kid, None)
    _prov_cool.pop(provider, None)


def rate_limited(spec: ModelSpec, wait: float | None, daily: bool = False) -> None:
    """A real 429. `wait` = how long the provider said to wait (None if it did not say), `daily` = it is the
    per-DAY quota, which waiting a minute will not fix: that model on that key is skipped until the provider's
    daily reset (daily_skip_seconds), and the mark is saved, so a restart does not try it again."""
    if daily:
        secs = daily_skip_seconds(spec, wait)
        cooldown(spec, secs)
        with _usage_lock:
            _roll()
            key = quota_key(spec)
            _usage["out"][key] = time.time() + min(secs, 86400)
            used = _usage["req"].get(key, 0)
            if not _set_limit(spec) and used >= LEARN_MIN:  # unknown cap: remember it, so next time we stop BEFORE the 429
                _usage["learned"][key] = used
            _save()
        if spec.provider == "openrouter":
            cooldown_key(spec, secs)  # one daily cap for all :free models of THIS key: every one of them is out
        return
    if wait:
        # small margin + jitter, so parallel callers do not all come back in the same second and fail together again
        cooldown(spec, wait + 1.0 + random.random() * 2.0)
        if spec.provider == "openrouter" and wait > 600:
            cooldown_key(spec, wait)  # daily cap hit: every :free model on this key is out
    else:
        fail(spec, 30)


# ------------------------------------------------------------------ our own rate limiter (before the call)
# Free tiers say "30 requests/min, 8000 tokens/min". Reacting only AFTER a 429 wastes a call, puts the model in a long
# cooldown, and a parallel panel fires 6 requests in the same second, so most of them fail. Instead every request first
# reserves a time slot in a sliding 60 s window per quota key (see quota_key):
#   slot is free now             -> send at once
#   slot frees up within max_wait -> wait for it (parallel requests get spaced out instead of fired together)
#   slot is further away          -> the caller moves on to the next model in its chain
# Slots are handed out in order (never earlier than the previous one), so it is enough to check each new request
# against the 60 s before it to keep EVERY 60 s window inside the limits.
_WINDOW = 60.0
_slots: dict[str, list[tuple[float, int, str | None]]] = {}  # key -> [(slot time, tokens, reservation id)]
_slots_lock = threading.Lock()
_reservation_context: dict[str, tuple[str, int, str]] = {}
_reservation_created: dict[str, float] = {}
_generation_windows: dict[str, tuple[str, int, str]] = {}
_RESERVATION_TTL = max(3600.0, float(getattr(config, "LLM_TIMEOUT_S", 120.0)) * 4)


def _reap_reservations_locked(now: float) -> None:
    """Drop abandoned reservation metadata and its slot, without retaining request IDs forever."""
    cutoff = now - _RESERVATION_TTL
    stale = [rid for rid, created in _reservation_created.items() if created < cutoff]
    for rid in stale:
        for events in _slots.values():
            events[:] = [event for event in events if len(event) < 3 or event[2] != rid]
        _reservation_created.pop(rid, None)
        _reservation_context.pop(rid, None)


def _generation_window_key(key: str, generation: str) -> str:
    return f"{key}\x1f{generation}"


def request_window_key(spec: ModelSpec, accounting_context: tuple | None) -> str:
    """Use the shared active window unless the captured request already belongs to a retired generation."""
    key = quota_key(spec)
    if not (isinstance(accounting_context, tuple) and len(accounting_context) == 4
            and accounting_context[0] == spec.provider and accounting_context[2]):
        return key
    provider, slot, generation, _day = accounting_context
    with _usage_lock:
        _roll()
        _sync_generations()
        active = ((_usage.get("key_generation_state") or {}).get(_slot_key(provider, slot)) or {}).get("id")
    if generation == active:
        return key
    retired_key = _generation_window_key(key, generation)
    with _slots_lock:
        _generation_windows[retired_key] = (provider, slot, generation)
        # Retired windows are short-lived; prune old reservations to keep rotations bounded.
        cutoff = time.time() - _WINDOW
        for window, events in list(_slots.items()):
            if window in _generation_windows:
                events[:] = [event for event in events if event[0] > cutoff]
                if not events:
                    _slots.pop(window, None)
                    _generation_windows.pop(window, None)
    return retired_key


def reserve_slot(key: str, rpm: int, tpm: int, tokens: int, max_wait: float, now: float | None = None,
                 reservation_id: str | None = None, accounting_context: tuple | None = None) -> tuple[bool, float | None]:
    """(True, seconds to wait before sending; 0.0 = now) or (False, seconds until a slot is free / None = never).
    rpm / tpm = 0 means no cap of that kind."""
    if not rpm and not tpm:
        return True, 0.0
    now = time.time() if now is None else now
    with _slots_lock:
        _reap_reservations_locked(now)
        ev = _slots.setdefault(key, [])
        ev[:] = [e for e in ev if e[0] > now - _WINDOW]  # what left the window can not matter any more
        start = max(now, ev[-1][0]) if ev else now
        # a slot can only open up at the moment an earlier request leaves the window (+1 ms for float rounding)
        times = [start] + sorted({e[0] + _WINDOW + 0.001 for e in ev if e[0] + _WINDOW + 0.001 > start})
        for t in times:
            inside = [e for e in ev if t - _WINDOW < e[0] <= t]
            if rpm and len(inside) >= rpm:
                continue
            if tpm and sum(e[1] for e in inside) + tokens > tpm:
                continue
            if t - now > max_wait:
                return False, t - now
            ev.append((t, tokens, reservation_id))
            if reservation_id:
                _reservation_created[reservation_id] = now
            if (reservation_id and isinstance(accounting_context, tuple) and len(accounting_context) == 4
                    and accounting_context[2]):
                _reservation_context[reservation_id] = (accounting_context[0], accounting_context[1],
                                                        accounting_context[2])
            return True, t - now
    return False, None


def cancel_reservation(key: str, reservation_id: str | None) -> None:
    """Remove a reservation when a request is abandoned before its HTTP attempt."""
    if not reservation_id:
        return
    with _slots_lock:
        events = _slots.get(key, [])
        events[:] = [event for event in events if len(event) < 3 or event[2] != reservation_id]
        _reservation_context.pop(reservation_id, None)
        _reservation_created.pop(reservation_id, None)


def finish_reservation(reservation_id: str | None) -> None:
    """Stop treating a completed HTTP attempt as an outstanding request during future key rotations."""
    if reservation_id:
        with _slots_lock:
            _reservation_context.pop(reservation_id, None)
            _reservation_created.pop(reservation_id, None)


def settle_slot(key: str, reservation_id: str | None, actual_tokens: int) -> bool:
    """Replace one completed request's conservative TPM reservation with provider-reported usage.

    The reservation stays at its original timestamp, so in-flight calls remain protected and RPM is unchanged.
    A unique id prevents concurrent requests for the same model/key from settling each other's reservations.
    """
    if not reservation_id:
        return False
    try:
        actual = max(0, int(actual_tokens))
    except (TypeError, ValueError, OverflowError):
        return False
    with _slots_lock:
        ev = _slots.get(key, [])
        for i, item in enumerate(ev):
            if len(item) >= 3 and item[2] == reservation_id:
                ev[i] = (item[0], actual, item[2])
                return True
    return False


# ------------------------------------------------------------------ trace (per request)

def start_trace(record: bool = False) -> list:
    """record=True also keeps every prompt and output (for the council view). Off by default: it is big."""
    t: list = []
    _trace.set(t)
    _rec.set(record)
    return t


def _cut(text: str, n: int) -> str:
    if len(text) <= n:
        return text
    return text[:n] + "\n…[record me yahan kaata gaya, model ko poora prompt gaya tha]"


def set_stage(name: str) -> None:
    """Label the model calls that follow (per asyncio task), e.g. "panel:logic_math", "judge"."""
    _stage.set(name)


def stage() -> str:
    """The stage of the call happening now ("" when none was set)."""
    return _stage.get()


def trace_add(asked: ModelSpec, used: ModelSpec, ok: bool, *, messages=None, output=None, secs=None, skips=None) -> None:
    t = _trace.get()
    if t is None:
        return
    e = {"role": asked.role or asked.label, "asked": asked.label, "used": used.label, "ok": ok, "stage": _stage.get()}
    if secs is not None:
        e["secs"] = round(secs, 2)
    if skips:
        e["skips"] = dict(skips)
    if _rec.get() and e["stage"] != "guard":
        if messages is not None:
            e["prompt"] = [{"role": m.get("role", ""), "content": _cut(str(m.get("content", "")), MAX_PROMPT_CHARS)} for m in messages]
        if output is not None:
            e["output"] = output
    t.append(e)


def last_call(stage: str) -> dict | None:
    for e in reversed(_trace.get() or []):
        if e.get("stage") == stage:
            return e
    return None


def summarize(trace: list) -> dict:
    out: dict[str, int] = {}
    for e in trace:
        if e["ok"]:
            out[e["used"]] = out.get(e["used"], 0) + 1
    return out


def snapshot() -> dict:
    _roll()
    now = time.time()
    cooling = {k: int(v - now) for k, v in _cool.items() if v > now}
    cooling.update({f"provider:{k}": int(v - now) for k, v in _prov_cool.items() if v > now})
    cooling.update({f"key:{k}": int(v - now) for k, v in _key_cool.items() if v > now})
    return {
        "day_utc": _usage["day"],
        "requests_today": dict(_usage["req"]),
        "tokens_today": dict(_usage["tok"]),
        "out_today": {k: int(v - now) for k, v in _usage.get("out", {}).items() if v > now},
        "gone_today": {k: v.get("why", "") for k, v in (_usage.get("gone") or {}).items() if v.get("until", 0) > now},
        "learned_daily_caps": dict(_usage.get("learned", {})),
        "cooling_down": cooling,
    }


# ------------------------------------------------------------------ usage screen (change 1.4)
PROVIDER_NAMES = {"groq": "Groq", "gemini": "Gemini", "openrouter": "OpenRouter", "nvidia": "NVIDIA", "cloudflare": "Cloudflare"}
STANDARD_MODEL = "openai/gpt-oss-120b"  # Legacy fallback if no configured Standard Groq label resolves


def _selected_standard_spec():
    """Configured Standard primary, constrained to Groq; retain the legacy model as a safe fallback."""
    labels = getattr(config, "STANDARD_CHAIN_LABELS", ()) or ()
    for label in labels:
        spec = config.REGISTRY.get(config.base_label(str(label)))
        if spec and spec.provider == "groq":
            return spec
    return _spec_for("groq", STANDARD_MODEL)


def _split_qkey(qkey: str) -> tuple[str, str, int]:
    """'groq:openai/gpt-oss-120b#2' -> ('groq', 'openai/gpt-oss-120b', 2); 'openrouter#3' -> ('openrouter', '', 3)."""
    base, slot = qkey, 1
    head, sep, tail = qkey.rpartition("#")
    if sep and tail.isdigit():
        base, slot = head, int(tail)
    prov, _, model = base.partition(":")
    return prov, model, slot


def _spec_for(prov: str, model: str):
    for s in config.REGISTRY.values():
        if s.provider == prov and (not model or s.model == model):
            return s
    return None


def _minute(qkey: str, now: float) -> tuple[int, int]:
    """Requests and tokens our own limiter booked for this quota key in the last 60 s (rate-limit view)."""
    with _slots_lock:
        ev = [e for e in _slots.get(qkey, []) if now - _WINDOW < e[0]]
    return len(ev), sum(int(e[1]) for e in ev)


def limits_text(prov: str) -> str:
    stop = int(round(MARGIN * 100))
    return {
        "groq": (f"Har key alag account hai, sabki apni limit: har model {config.GROQ_RPD} req/din aur "
                 f"{config.GROQ_TPD // 1000}K tokens/din; {config.GROQ_RPM} req/min (asli 30), "
                 f"~{config.GROQ_TPM_DEFAULT // 1000}K tokens/min. {stop}% par app khud ruk kar agli key leta hai."),
        "openrouter": (f"Free models ki ek hi din ki limit: {config.OPENROUTER_RPD} req/din per key (sab :free models milke), "
                       f"{config.OPENROUTER_RPM} req/min."),
        "gemini": (f"{config.GEMINI_RPM} req/min per model. Din ki limit Google batata nahi: pehle 429 se seekh kar "
                   "yaad rakhi jaati hai."),
        "nvidia": f"{config.NVIDIA_RPM} req/min. Din ki limit pehle 429 se seekhi jaati hai.",
        "cloudflare": "Din ki limit account ke neurons par hai; 429 aaye to key 2, phir key 3.",
    }.get(prov, "")


def _model_row(prov: str, model: str, slot: int, qk: str, req: dict, tok: dict, out: dict, now: float) -> dict:
    spec = _spec_for(prov, model)
    pinned = config.keyed(spec, slot) if spec else None
    rl = req_limit(pinned) if pinned else 0
    tl = tok_limit(pinned) if pinned else 0
    r, t = int(req.get(qk, 0)), int(tok.get(qk, 0))
    out_s = max(0, int(out.get(qk, 0) - now))
    frac = 1.0 if out_s else min(1.0, max(r / rl if rl else 0.0, t / tl if tl else 0.0))
    m_req, m_tok = _minute(qk, now)
    return {
        "model": model or "sab :free models (shared)",
        "label": config.base_label(spec.label) if spec and model else "",
        "req": r, "tok": t, "req_limit": rl, "tok_limit": tl, "frac": round(frac, 3),
        "out_s": out_s, "cool_s": max(0, int(_cool.get(pinned.label, 0) - now)) if pinned else 0,
        "rpm": config.rpm_limit(pinned) if pinned else 0, "tpm": config.tpm_limit(pinned) if pinned else 0,
        "min_req": m_req, "min_tok": m_tok,
    }


def _key_state(have: bool, cool_s: int, models: list[dict]) -> str:
    if not have:
        return "nokey"
    if cool_s > 0:
        return "cool"
    capped_rows = [m for m in models if m["req_limit"] or m["tok_limit"] or m["out_s"]]
    if capped_rows and all(m["out_s"] or m["frac"] >= MARGIN for m in capped_rows):
        return "out"
    if any(m["out_s"] or m["frac"] >= RESERVE_MARGIN for m in capped_rows):
        return "low"
    return "ok"


def _quota_name(provider: str, model: str, slot: int) -> str:
    base = "openrouter" if provider == "openrouter" else f"{provider}:{model}"
    return base if slot <= 1 else f"{base}#{slot}"


def _generation_model_rows(provider: str, slot: int, req_counts: dict, tok_counts: dict,
                           req: dict, tok: dict, out: dict, now: float) -> list[dict]:
    rows = []
    for model in sorted(set(req_counts or {}) | set(tok_counts or {})):
        qkey = _quota_name(provider, model, slot)
        model_req = {qkey: max(0, int((req_counts or {}).get(model, 0) or 0))}
        model_tok = {qkey: max(0, int((tok_counts or {}).get(model, 0) or 0))}
        rows.append(_model_row(provider, model, slot, qkey, model_req, model_tok, out, now))
    return sorted(rows, key=lambda x: (-x["req"], x["model"]))


def _key_row(provider: str, slot: int, *, have: bool, generation: str | None = None,
             record: dict | None = None, unknown: dict | None = None, active: bool = False,
             state: str | None = None, cool_s: int = 0, now: float, req: dict, tok: dict,
             out: dict, report_day: str) -> dict:
    record = record or {}
    req_counts = dict(record.get("req") or {})
    tok_counts = dict(record.get("tok") or {})
    unknown = unknown or {}
    for model, value in (unknown.get("req") or {}).items():
        req_counts[model] = req_counts.get(model, 0) + max(0, int(value or 0))
    for model, value in (unknown.get("tok") or {}).items():
        tok_counts[model] = tok_counts.get(model, 0) + max(0, int(value or 0))
    model_rows = _generation_model_rows(provider, slot, req_counts, tok_counts, req, tok,
                                        out if active else {}, now)
    since = str(record.get("since_day") or "")[:10]
    try:
        if not since or dt.date.fromisoformat(since) > dt.date.fromisoformat(report_day):
            since = report_day
    except ValueError:
        since = report_day
    row = {"slot": slot, "set": bool(have), "state": state or ("ok" if have else "nokey"),
           "cool_s": int(cool_s if active else 0),
           "req": sum(int(m["req"]) for m in model_rows), "tok": sum(int(m["tok"]) for m in model_rows),
           "models": model_rows, "active": bool(active)}
    if generation and _GEN_RE.fullmatch(str(generation)):
        row["generation"] = str(generation)
        if since:
            row["tracked_since_day"] = since
    elif unknown and (row["req"] or row["tok"]):
        row["generation_unknown"] = True
    return row


def _current_key_rows(provider: str, *, now: float, report_day: str, req: dict, tok: dict,
                      out: dict, key_usage: dict, generation_state: dict) -> list[dict]:
    set_slots = set(PROVIDERS[provider].slots())
    standard_spec = _selected_standard_spec() if provider == "groq" else None
    rows: list[dict] = []
    for slot in range(1, config.KEY_SLOTS + 1):
        have = slot in set_slots
        name = _slot_key(provider, slot)
        item = (key_usage.get("slots") or {}).get(name) or {"generations": {}, "unknown": _bucket()}
        state = generation_state.get(name) or {}
        active_id = state.get("id")
        current_record = (item.get("generations") or {}).get(active_id) if active_id else None
        if provider == "groq" and have and current_record is not None and standard_spec:
            if standard_spec.model not in (current_record.get("req") or {}) and standard_spec.model not in (current_record.get("tok") or {}):
                # The Standard row remains visible even before it has usage.
                current_record = copy.deepcopy(current_record)
                current_record.setdefault("req", {}).setdefault(standard_spec.model, 0)
                current_record.setdefault("tok", {}).setdefault(standard_spec.model, 0)
        kid = provider if slot == 1 else f"{provider}#{slot}"
        cool_s = max(0, int(max(_key_cool.get(kid, 0), _prov_cool.get(provider, 0)) - now)) if have else 0
        quota_models = {model for qkey in (set(req) | set(tok))
                        for p, model, n in [_parse_qkey(qkey)] if p == provider and n == slot}
        if provider == "groq" and have and standard_spec:
            quota_models.add(standard_spec.model)
        quota_rows = [_model_row(provider, model, slot, _quota_name(provider, model, slot), req, tok, out, now)
                      for model in sorted(quota_models)]
        active_state = _key_state(have, cool_s, quota_rows)
        if current_record is not None:
            rows.append(_key_row(provider, slot, have=have, generation=active_id, record=current_record,
                                 active=True, state=active_state, cool_s=cool_s, now=now, req=req, tok=tok,
                                 out=out, report_day=report_day))
        else:
            # Exactly one no-identity slot row is kept when no key is configured; legacy counts live here.
            legacy = (item.get("unknown") or {})
            merge_unknown = not have and bool(sum((legacy.get("req") or {}).values()) or sum((legacy.get("tok") or {}).values()))
            rows.append(_key_row(provider, slot, have=have, record={}, unknown=legacy if merge_unknown else None,
                                 active=False, state=active_state, now=now, req=req, tok=tok, out=out,
                                 report_day=report_day))
        for gen_id, record in sorted((item.get("generations") or {}).items(),
                                     key=lambda pair: (str(pair[1].get("since_day") or ""), pair[0])):
            if gen_id == active_id or not _GEN_RE.fullmatch(str(gen_id)):
                continue
            rows.append(_key_row(provider, slot, have=False, generation=gen_id, record=record,
                                 active=False, state="ok", now=now, req=req, tok=tok, out={},
                                 report_day=report_day))
        legacy = item.get("unknown") or {}
        if have and (sum((legacy.get("req") or {}).values()) or sum((legacy.get("tok") or {}).values())):
            rows.append(_key_row(provider, slot, have=False, unknown=legacy, active=False, state="ok",
                                 now=now, req=req, tok=tok, out={}, report_day=report_day))
    return rows


def _historical_key_rows(provider: str, key_usage: dict, report_day: str, now: float) -> list[dict]:
    rows = []
    for slot in range(1, config.KEY_SLOTS + 1):
        item = ((key_usage.get("slots") or {}).get(_slot_key(provider, slot)) or {})
        for gen_id, record in sorted((item.get("generations") or {}).items(),
                                     key=lambda pair: (str(pair[1].get("since_day") or ""), pair[0])):
            if not _GEN_RE.fullmatch(str(gen_id)):
                continue
            active = bool(record.get("active"))
            rows.append(_key_row(provider, slot, have=active, generation=gen_id, record=record,
                                 active=active, state="ok", now=now, req={}, tok={}, out={}, report_day=report_day))
        unknown = item.get("unknown") or {}
        if sum((unknown.get("req") or {}).values()) or sum((unknown.get("tok") or {}).values()):
            rows.append(_key_row(provider, slot, have=False, unknown=unknown, active=False, state="ok",
                                 now=now, req={}, tok={}, out={}, report_day=report_day))
    return rows


def report() -> dict:
    """Everything the API usage screen shows, from local counters only (no network, works with zero keys)."""
    _roll()
    now = time.time()
    with _usage_lock:
        changed = _sync_generations()
        changed = _reconcile_ledger(_usage) or changed
        if changed:
            _save()
        req, tok = dict(_usage["req"]), dict(_usage["tok"])
        out = dict(_usage.get("out") or {})
        feat, truth = dict(_usage.get("feat") or {}), dict(_usage.get("truth") or {})
        hist, day = list(_usage.get("hist") or []), _usage["day"]
        today = _day_summary(_usage)
        key_usage = copy.deepcopy(_usage.get("key_usage") or {"slots": {}})
        generation_state = copy.deepcopy(_usage.get("key_generation_state") or {})
        sampled_at = _sampled_at_locked()
    providers = []
    order = [p for p in PROVIDER_NAMES if p in PROVIDERS] + [p for p in PROVIDERS if p not in PROVIDER_NAMES]
    standard_spec = _selected_standard_spec()
    for prov in order:
        set_slots = PROVIDERS[prov].slots()
        keys = _current_key_rows(prov, now=now, report_day=day, req=req, tok=tok, out=out,
                                 key_usage=key_usage, generation_state=generation_state)
        providers.append({"id": prov, "name": PROVIDER_NAMES.get(prov, prov), "keys": keys, "keys_complete": True,
                          "set": len(set_slots), "limits": limits_text(prov),
                          "req": sum(k["req"] for k in keys), "tok": sum(k["tok"] for k in keys)})
    std = {"state": "nokey", "left": 0.0}
    if PROVIDERS["groq"].slots() and standard_spec:
        left = 1.0 - used_frac(standard_spec)
        std = {"left": round(left, 3),
               "state": "low" if left < config.QUOTA_LOW else "tight" if left < config.QUOTA_TIGHT else "ok"}
    tomorrow = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(days=1)
    days = [{"day": h.get("day", ""), "req": sum((h.get("req") or {}).values()), "tok": sum((h.get("tok") or {}).values()),
             "by": dict(h.get("req") or {})} for h in hist[-6:] if isinstance(h, dict)]
    days.append({"day": day, "req": sum(today["req"].values()), "tok": sum(today["tok"].values()), "by": today["req"]})
    provider_req, provider_tok = _provider_totals({"key_usage": key_usage})
    return {
        "day_utc": day,
        "sampled_at": sampled_at,
        "reset_in_s": max(0, int(tomorrow.timestamp() - now)),
        "totals": {"req": sum(provider_req.values()), "tok": sum(provider_tok.values())},
        "providers": providers,
        "features": feat,
        "days": days,
        "truth": {k: int(truth.get(k, 0)) for k in ("answers", "ok", "shak", "galat")},
        "standard": std,
        "margin": MARGIN,
        "reserve": RESERVE_MARGIN,
    }


def controller_reports() -> list[dict]:
    """Prompt-free absolute per-day reports; historical rows expose aggregates, never invented model/key detail."""
    current = report()
    with _usage_lock:
        history = [dict(row) for row in _usage.get("hist", []) if isinstance(row, dict)]
        sampled_at = _sampled_at_locked()
    try:
        current_day = dt.date.fromisoformat(str(current.get("day_utc") or ""))
    except ValueError:
        current_day = dt.datetime.now(dt.timezone.utc).date()
    first_day = current_day - dt.timedelta(days=HIST_DAYS - 1)
    history_by_day = {}
    for row in history:
        try:
            hist_day = dt.date.fromisoformat(str(row.get("day") or ""))
        except ValueError:
            continue
        if first_day <= hist_day < current_day:
            history_by_day[hist_day] = row  # last stored copy wins if corrupted history repeats a date
    reports = []
    # The current day retains the precise provider/model/key-slot breakdown from health.report().
    current = dict(current)
    reports.append(current)
    for hist_day in sorted(history_by_day, reverse=True)[:HIST_DAYS - 1]:
        row = history_by_day[hist_day]
        day = hist_day.isoformat()
        req = {str(k): max(0, int(v or 0)) for k, v in (row.get("req") or {}).items() if str(k) in PROVIDERS}
        tok = {str(k): max(0, int(v or 0)) for k, v in (row.get("tok") or {}).items() if str(k) in PROVIDERS}
        providers = []
        for provider in PROVIDER_NAMES:
            if provider not in PROVIDERS:
                continue
            providers.append({"id": provider, "name": PROVIDER_NAMES[provider], "set": 0,
                              "req": req.get(provider, 0), "tok": tok.get(provider, 0),
                              "keys_complete": isinstance(row.get("key_usage"), dict),
                              "keys": _historical_key_rows(provider, row.get("key_usage") or {"slots": {}},
                                                           day, sampled_at / 1000.0)})
        reports.append({
            "day_utc": day,
            "sampled_at": sampled_at,
            "totals": {"req": sum(req.values()), "tok": sum(tok.values())},
            "providers": providers,
            "features": {str(k)[:60]: max(0, int(v or 0)) for k, v in (row.get("feat") or {}).items()},
            "days": [{"day": day, "req": sum(req.values()), "tok": sum(tok.values()), "by": req}],
            "truth": {k: max(0, int((row.get("truth") or {}).get(k, 0) or 0)) for k in ("answers", "ok", "shak", "galat")},
            "standard": {"state": "unknown", "left": 0.0},
            "margin": MARGIN,
            "reserve": RESERVE_MARGIN,
            "reset_in_s": 0,
        })
    return reports[:HIST_DAYS + 1]


def reset(clear_usage: bool = False) -> None:
    """Forget cooldowns (used by tests)."""
    _cool.clear()
    _prov_cool.clear()
    _key_cool.clear()
    _streak.clear()
    _perr.clear()
    with _slots_lock:
        _slots.clear()
        _reservation_context.clear()
        _reservation_created.clear()
        _generation_windows.clear()
    if clear_usage:
        with _usage_lock:
            _usage.clear()
            _usage.update(_fresh())
