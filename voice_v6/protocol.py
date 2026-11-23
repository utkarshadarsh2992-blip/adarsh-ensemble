"""Request validation + dispatch for {"tts": {"v6": <action>, ...}} messages."""
from __future__ import annotations
import asyncio
from . import voice_router as r
from .providers import local_tts

ACTIONS = {"plan", "chunk", "control", "status", "install"}


def validate(req: dict) -> str | None:
    act = req.get("v6")
    if act not in ACTIONS:
        return f"unknown v6 action '{act}'"
    if act == "plan" and not str(req.get("text") or "").strip():
        return "text required"
    if act in ("chunk",) and not req.get("response_id"):
        return "response_id required"
    if act == "control" and req.get("action") not in ("pause", "resume", "stop"):
        return "action must be pause|resume|stop"
    return None


async def handle(req: dict, remote=None) -> dict:
    err = validate(req)
    if err:
        return {"type": "error", "error": err, "response_id": req.get("response_id")}
    act = req["v6"]
    if act == "plan":
        return await r.speak(req)
    if act == "chunk":
        return await r.chunk(req, remote)
    if act == "control":
        return r.control(req)
    if act == "install":
        r.reset()
        return {"type": "voice_install", "result": await asyncio.to_thread(local_tts.install), "status": r.status()}
    return r.status()
