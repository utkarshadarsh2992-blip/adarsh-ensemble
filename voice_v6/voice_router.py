"""Hybrid router: best neural (existing Gemini/Groq) -> Piper local -> Android native.
Dead providers are remembered for a cool-down so a failing one is not retried every sentence."""
from __future__ import annotations
import asyncio, base64, os, re, time, uuid
from . import hinglish_processor as hp
from . import voice_config as cfg
from .providers import local_tts, android_tts
from .speech_queue import QUEUE

COOLDOWN = 120.0
_dead: dict[str, float] = {}
_SAFE_RESPONSE_ID = re.compile(r"^(?:[0-9a-f]{8,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", re.I)


def mark_dead(name: str):
    _dead[name] = time.time() + COOLDOWN


def is_dead(name: str) -> bool:
    return _dead.get(name, 0) > time.time()


def reset():
    _dead.clear()


def _store(wav: bytes, rid: str, i: int) -> dict:
    d = os.environ.get("TTS_DIR")
    if not d:
        return {"mime": "audio/wav", "b64": base64.b64encode(wav).decode()}
    # Response IDs are client-controlled. Never put an unvalidated value in a
    # filesystem path; invalid IDs still work through the inline response.
    if not _SAFE_RESPONSE_ID.fullmatch(rid):
        return {"mime": "audio/wav", "b64": base64.b64encode(wav).decode()}
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, f"v6_{rid[:12]}_{i}.wav")
    with open(p, "wb") as f:
        f.write(wav)
    return {"file": p}


def _chunk_snapshot(rid: str, index: int):
    """Read a chunk and its queue state atomically under SpeechQueue's lock."""
    with QUEUE._lock:
        item = QUEUE.items.get(rid)
        if not item:
            return None
        chunks = item.get("chunks") or []
        if item.get("state") != "playing":
            return {"state": item.get("state", "unknown"), "length": len(chunks)}
        if index < 0 or index >= len(chunks):
            return {"bad_index": True, "length": len(chunks)}
        return {"state": "playing", "chunk": dict(chunks[index]), "length": len(chunks)}


def local_wav(sentence: dict, profile: cfg.VoiceProfile) -> bytes:
    """One sentence -> one WAV; Hindi/English spans use their own Piper model, joined with short silence."""
    parts, rate = [], 22050
    for sp in sentence["spans"]:
        try:
            data, rate = local_tts.pcm(sp["text"], sp["lang"], profile.rate)
        except local_tts.VoiceUnavailable:
            other = "en" if sp["lang"] == "hi" else "hi"   # one model missing: let the other read it
            data, rate = local_tts.pcm(sp["text"], other, profile.rate)
        parts.append(data)
    gap = b"\x00\x00" * int(rate * 0.05)
    return local_tts.wav_bytes(gap.join(parts), rate)


async def speak(req: dict, remote=None) -> dict:
    """req: {text, voice, response_id, rate, ...}. Returns the whole plan with one audio entry per sentence
    (chunks generated in order so playback of #0 can start while the rest is produced by `chunk`)."""
    text = str(req.get("text") or "")
    rid = str(req.get("response_id") or uuid.uuid4().hex)
    profile = cfg.VoiceProfile.of(req.get("profile") or {"rate": req.get("rate", 1.0)})
    plan = hp.plan(text)
    if not plan:
        return {"type": "error", "error": "bolne ko kuch nahi", "response_id": rid}
    if not QUEUE.start(rid, plan):
        return {"type": "duplicate", "response_id": rid}
    return {"type": "voice_plan", "response_id": rid, "count": len(plan), "language": plan[0]["lang"],
            "profile": profile.dict(), "sentences": [{"index": p["index"], "text": p["text"], "lang": p["lang"]} for p in plan]}


async def chunk(req: dict, remote=None) -> dict:
    """Generate sentence `index` of response `response_id`. Order: remote neural -> local Piper -> device."""
    rid = str(req.get("response_id") or "")
    try:
        i = int(req.get("index", 0))
    except (TypeError, ValueError):
        return {"type": "error", "error": "bad index", "response_id": rid}
    snapshot = _chunk_snapshot(rid, i)
    if snapshot is None:
        return {"type": "error", "error": "unknown response_id", "response_id": rid}
    if snapshot.get("state") != "playing":
        return {"type": "cancelled", "response_id": rid, "state": snapshot["state"]}
    if snapshot.get("bad_index"):
        return {"type": "error", "error": "bad index", "response_id": rid}
    s = snapshot["chunk"]
    last = i == snapshot["length"] - 1
    profile = cfg.VoiceProfile.of(req.get("profile") or {"rate": req.get("rate", 1.0)})
    base = {"response_id": rid, "index": i, "last": last, "text": s["text"], "lang": s["lang"]}
    tried = []
    if remote and not is_dead("remote") and not req.get("offline"):
        try:
            wav, label = await asyncio.wait_for(remote(s["text"], str(req.get("voice") or "Kore")), 25)
            if last:
                QUEUE.finish(rid)
            return {**base, "type": "audio_chunk", "engine": "remote:" + label, **_store(wav, rid, i)}
        except Exception as e:
            tried.append(f"remote: {str(e)[:80]}")
            mark_dead("remote")
    if profile.fallback and not is_dead("local"):
        try:
            wav = await asyncio.to_thread(local_wav, s, profile)
            if last:
                QUEUE.finish(rid)
            return {**base, "type": "audio_chunk", "engine": "piper", "tried": tried, **_store(wav, rid, i)}
        except Exception as e:
            tried.append(f"piper: {str(e)[:80]}")
            if isinstance(e, local_tts.VoiceUnavailable):
                mark_dead("local")
    if last:
        QUEUE.finish(rid)
    return {**base, **android_tts.directive(s["text"], s["lang"]), "type": "device_chunk", "engine": "android", "tried": tried}


def control(req: dict) -> dict:
    rid = str(req.get("response_id") or "")
    act = str(req.get("action") or "")
    ok = {"pause": QUEUE.pause, "resume": QUEUE.resume}.get(act, lambda r: QUEUE.stop(r or None))(rid)
    return {"type": "voice_control", "action": act, "response_id": rid, "ok": ok, "state": QUEUE.state(rid or (QUEUE.active or ""))}


def status() -> dict:
    return {"type": "voice_v6", "local": local_tts.available(), "dead": [k for k in _dead if is_dead(k)],
            "profile": cfg.VoiceProfile().dict()}
