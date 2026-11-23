"""Entry points the Android app calls through Chaquopy. No web server: Kotlin calls these directly.

Order matters: init() must run before the engine modules are imported, because health.py reads
USAGE_FILE at import time and config.py reads the process environment.
"""
import asyncio
import collections
import json
import os
import sys
import threading

# keep in sync with config.SECRET_ENVS (not imported here: config must load after init())
KEY_NAMES = ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
             "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "NVIDIA_API_KEY", "TAVILY_API_KEY")
_ready = False


def init(files_dir: str) -> str:
    """Point engine state at app-private storage. Safe to call more than once."""
    global _ready
    os.makedirs(files_dir, exist_ok=True)
    os.environ["USAGE_FILE"] = os.path.join(files_dir, "usage.json")
    os.environ["LESSONS_FILE"] = os.path.join(files_dir, "lessons.json")
    os.environ["TTS_DIR"] = os.path.join(files_dir, "tts")  # natural-voice clips (MediaPlayer plays the file)
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


def lessons(op_json: str) -> str:
    """Lessons list/add/edit/delete/clear. Plain file work: no model, no API key, no foreground service."""
    import lessons as store

    try:
        op = json.loads(op_json)
        if not isinstance(op, dict):
            raise ValueError
    except ValueError:
        return json.dumps({"ok": False, "error": "Request samajh nahi aaya."})
    return json.dumps(store.handle_op(op))


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
            "plan_problems": config.PLAN_PROBLEMS + __import__("mode_plans").PLAN_PROBLEMS,
            "python": sys.version.split()[0],
            "voice": {"gemini": bool(os.environ.get("GEMINI_API_KEY")), "groq_english": bool(os.environ.get("GROQ_API_KEY"))},
        }
    )


def diagnose() -> str:
    """One cheap GET /models per provider that has a key: checks key, network, TLS and that our model IDs exist."""
    import httpx

    import config

    lines = []
    for name, prov in config.PROVIDERS.items():
        if not prov.api_key:
            if name == "cloudflare" and (os.environ.get("CLOUDFLARE_API_TOKEN") or os.environ.get("CLOUDFLARE_ACCOUNT_ID")):
                lines.append("cloudflare: API token aur Account ID dono chahiye, ek abhi bhi missing hai")
            else:
                lines.append(f"{name}: key nahi hai")
            continue
        try:
            r = httpx.get(
                f"{prov.url}/models", headers={"Authorization": f"Bearer {prov.api_key}"}, timeout=20
            )
        except Exception as e:  # network, DNS, TLS
            lines.append(f"{name}: NETWORK FAIL {type(e).__name__}: {str(e)[:120]}")
            continue
        if r.status_code in (401, 403):
            lines.append(f"{name}: key reject hui (HTTP {r.status_code})")
            continue
        if name == "cloudflare" and r.status_code in (404, 405):
            lines.append("cloudflare: model list nahi deta, isliye key/ID ka pata pehle asli jawab me chalega")
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
            hints = []
            for mid in missing:
                tail = mid.split("/")[-1].removesuffix(":free")
                close = sorted(i for i in ids if tail and tail.lower() in i.lower())[:2]
                hints.append(mid + (f" (shayad: {', '.join(close)})" if close else ""))
            line += ". Nahi mile: " + ", ".join(hints)
        lines.append(line)
    return _text("**Connection test**\n\n" + "\n".join("- " + ln for ln in lines))


async def _run(body: dict, progress):
    import chat_adapter
    import config

    config.PROGRESS.set(progress)
    return await chat_adapter.handle(body)


# Stop in the app must stop the model calls, not only hide the answer: tokens are spent per call.
_running: dict = {}  # request id -> (event loop, main task)
_early_cancel = collections.deque(maxlen=64)  # Stop arrived before the request had registered itself
_cancel_lock = threading.Lock()


def _run_cancellable(make_coro, timeout: float, request_id):
    """asyncio.run(wait_for(make_coro(), timeout)) that cancel(request_id) can stop from another thread.
    Cancelling the main task cancels everything under it: gather children, httpx requests, backoff sleeps."""
    request_id = str(request_id) if request_id else None

    async def main():
        if request_id:
            with _cancel_lock:
                if request_id in _early_cancel:
                    _early_cancel.remove(request_id)
                    raise asyncio.CancelledError()
                _running[request_id] = (asyncio.get_running_loop(), asyncio.current_task())
        try:
            return await asyncio.wait_for(make_coro(), timeout=timeout)
        finally:
            if request_id:
                with _cancel_lock:
                    _running.pop(request_id, None)

    return asyncio.run(main())


def cancel(request_id: str) -> bool:
    """Kotlin calls this when the user taps Stop (or a native timeout fires).
    True = a running request was told to stop. False = nothing running under this id (yet); a request that
    starts later with the same id is refused."""
    request_id = str(request_id)
    with _cancel_lock:
        item = _running.get(request_id)
        if item is None:
            _early_cancel.append(request_id)
            return False
    loop, task = item
    try:
        loop.call_soon_threadsafe(task.cancel)
    except RuntimeError:  # the loop closed a moment ago: the request had just finished
        return False
    return True


def handle(request_json: str, progress=None, request_id=None) -> str:
    """UI request JSON in, reply JSON (object or list) out. Never raises, never logs keys.
    `progress` is an optional Java Consumer<String> (stage text for the UI).
    `request_id` lets cancel() stop this request while it runs."""
    import config

    try:
        body = json.loads(request_json)
        if not isinstance(body, dict):
            raise ValueError("request must be an object")
    except ValueError:
        return _text("Request samajh nahi aaya.")

    if body.get("diagnose"):
        return diagnose()

    if isinstance(body.get("lesson"), dict):  # plain file work: needs no API key
        return lessons(json.dumps(body["lesson"]))
    if isinstance(body.get("tts"), dict):  # natural voice: own short timeout, never the long chat path
        import voice
        try:
            return json.dumps(_run_cancellable(lambda: voice.handle(body["tts"]), 75, request_id))
        except asyncio.CancelledError:
            return json.dumps({"type": "error", "error": "cancelled"})
        except Exception as e:
            return json.dumps({"type": "error", "error": _scrub(f"{type(e).__name__}: {e}")[:300]})

    # Offline in-app commands and read-only self-knowledge must work even with zero model keys.
    import chat_adapter
    local = chat_adapter.local_response(body)
    if local is not None:
        return json.dumps(local)
    if not body.get("ping") and not any(v.api_key for v in config.PROVIDERS.values()):
        return _text("Koi API key set nahi hai. **Settings > API keys** me kam se kam ek key daalo (Groq, Gemini, OpenRouter, Cloudflare ya NVIDIA).")

    cb = (lambda m: progress.accept(m)) if progress is not None else None
    limit = float(os.getenv("ANDROID_TIMEOUT_S", "10000"))
    try:
        return json.dumps(_run_cancellable(lambda: _run(body, cb), limit, request_id))
    except asyncio.CancelledError:
        return _text("Rok diya gaya.")
    except asyncio.TimeoutError:
        return _text(
            f"{int(limit)} second me jawab nahi aaya, isliye rok diya. Models ya network bahut slow hain. "
            "Settings > API keys > **Test connection** chalao, wahan se pata chalega ki key, network ya model ID me kya galat hai."
        )
    except RuntimeError as e:
        return _text(f"Models se jawab nahi mila: {e}")
    except Exception as e:  # keep the app alive whatever a provider does
        return _text(f"Engine error ({type(e).__name__}): {e}")
