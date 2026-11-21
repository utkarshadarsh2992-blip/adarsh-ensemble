"""Entry points the Android app calls through Chaquopy. No web server: Kotlin calls these directly.

Order matters: init() must run before the engine modules are imported, because health.py reads
USAGE_FILE at import time and config.py reads the process environment.
"""
import asyncio
import json
import os
import sys

KEY_NAMES = ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY")
_ready = False


def init(files_dir: str) -> str:
    """Point engine state at app-private storage. Safe to call more than once."""
    global _ready
    os.makedirs(files_dir, exist_ok=True)
    os.environ["USAGE_FILE"] = os.path.join(files_dir, "usage.json")
    os.environ.setdefault("CHAT_MODE", "fast")  # phone default: fewer models, less quota
    _ready = True
    return "ok"


def set_key(name: str, value: str) -> bool:
    if name not in KEY_NAMES:
        return False
    if value:
        os.environ[name] = value.strip()
    else:
        os.environ.pop(name, None)
    return True


def _scrub(text: str) -> str:
    for n in KEY_NAMES:
        v = os.environ.get(n)
        if v and len(v) > 6:
            text = text.replace(v, "***")
    return text


def _text(msg: str) -> str:
    return json.dumps({"type": "text", "text": _scrub(msg)[:3000]})


def status() -> str:
    import config

    return json.dumps(
        {
            "ready": _ready,
            "android": config.ON_ANDROID,
            "code_proofs": config.CODE_EXEC_SUPPORTED,
            "providers": {k: bool(v.api_key) for k, v in config.PROVIDERS.items()},
            "plan_problems": config.PLAN_PROBLEMS,
            "python": sys.version.split()[0],
        }
    )


def diagnose() -> str:
    """One cheap GET /models per provider that has a key: checks key, network, TLS and that our model IDs exist."""
    import httpx

    import config

    lines = []
    for name, prov in config.PROVIDERS.items():
        if not prov.api_key:
            lines.append(f"{name}: key nahi hai")
            continue
        try:
            r = httpx.get(
                f"{prov.base_url}/models", headers={"Authorization": f"Bearer {prov.api_key}"}, timeout=20
            )
        except Exception as e:  # network, DNS, TLS
            lines.append(f"{name}: NETWORK FAIL {type(e).__name__}: {str(e)[:120]}")
            continue
        if r.status_code in (401, 403):
            lines.append(f"{name}: key reject hui (HTTP {r.status_code})")
            continue
        if r.status_code != 200:
            lines.append(f"{name}: HTTP {r.status_code} {r.text[:80]}")
            continue
        try:
            ids = {str(m.get("id", "")).removeprefix("models/") for m in r.json().get("data", [])}
        except Exception:
            lines.append(f"{name}: OK (HTTP 200), par model list padh nahi paya")
            continue
        ours = [m for m in config.REGISTRY.values() if m.provider == name]
        missing = [m.model for m in ours if m.model not in ids]
        line = f"{name}: key OK, {len(ours) - len(missing)}/{len(ours)} configured models mile"
        if missing:
            line += ". Nahi mile: " + ", ".join(missing)
        lines.append(line)
    return _text("**Connection test**\n\n" + "\n".join("- " + ln for ln in lines))


async def _run(body: dict, progress):
    import chat_adapter
    import config

    config.PROGRESS.set(progress)
    return await chat_adapter.handle(body)


def handle(request_json: str, progress=None) -> str:
    """UI request JSON in, reply JSON (object or list) out. Never raises, never logs keys.
    `progress` is an optional Java Consumer<String> (stage text for the UI)."""
    import config

    try:
        body = json.loads(request_json)
        if not isinstance(body, dict):
            raise ValueError("request must be an object")
    except ValueError:
        return _text("Request samajh nahi aaya.")

    if body.get("diagnose"):
        return diagnose()

    if not body.get("ping") and not any(v.api_key for v in config.PROVIDERS.values()):
        return _text("Koi API key set nahi hai. **Settings > API keys** me kam se kam ek key daalo (Groq, Gemini ya OpenRouter).")

    cb = (lambda m: progress.accept(m)) if progress is not None else None
    limit = float(os.getenv("ANDROID_TIMEOUT_S", "300"))
    try:
        return json.dumps(asyncio.run(asyncio.wait_for(_run(body, cb), timeout=limit)))
    except asyncio.TimeoutError:
        return _text(
            f"{int(limit)} second me jawab nahi aaya, isliye rok diya. Models ya network bahut slow hain. "
            "Settings > API keys > **Test connection** chalao, wahan se pata chalega ki key, network ya model ID me kya galat hai."
        )
    except RuntimeError as e:
        return _text(f"Models se jawab nahi mila: {e}")
    except Exception as e:  # keep the app alive whatever a provider does
        return _text(f"Engine error ({type(e).__name__}): {e}")
