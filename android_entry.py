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
    os.environ.setdefault("CHAT_MODE", "fast")  # phone default: fewer models, less quota; change in env if wanted
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


def handle(request_json: str) -> str:
    """UI request JSON in, reply JSON (object or list) out. Never raises, never logs keys."""
    import chat_adapter
    import config

    try:
        body = json.loads(request_json)
        if not isinstance(body, dict):
            raise ValueError("request must be an object")
    except ValueError:
        return json.dumps({"type": "text", "text": "Request samajh nahi aaya."})

    if not body.get("ping") and not any(v.api_key for v in config.PROVIDERS.values()):
        return json.dumps(
            {"type": "text", "text": "Koi API key set nahi hai. **Settings > API keys** me kam se kam ek key daalo (Groq, Gemini ya OpenRouter)."}
        )
    try:
        return json.dumps(asyncio.run(chat_adapter.handle(body)))
    except RuntimeError as e:
        return json.dumps({"type": "text", "text": _scrub(f"Models se jawab nahi mila: {e}")[:1500]})
    except Exception as e:  # keep the app alive whatever a provider does
        return json.dumps({"type": "text", "text": _scrub(f"Engine error ({type(e).__name__}): {e}")[:1500]})
