"""Natural voice for replies: text -> WAV.

1. Gemini TTS (needs GEMINI_API_KEY). Speaks English, Hindi and Hinglish naturally. Models are tried in order;
   one that is missing (404/400) is skipped for the rest of the process, one out of quota (429) rests a while.
2. Groq Orpheus (needs GROQ_API_KEY), English only, small free quota: last resort for English text.
If both fail the UI falls back to the phone's own voice (Android TextToSpeech), so speech never just stops.

Request (UI -> engine): {"tts": {"text": "...", "voice": "Kore", "lang": "hi-IN"}}
Reply: {"type": "audio", "file": "/path.wav"} on Android (TTS_DIR set), else {"type": "audio", "b64": ..., "mime": "audio/wav"};
on failure {"type": "error", "error": "..."}.
"""
import base64
import hashlib
import os
import re
import struct
import time

import httpx

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Newest first. 3.8 models read the text verbatim (no style prefix); older previews follow a short spoken direction.
GEMINI_MODELS = [m.strip() for m in os.getenv(
    "TTS_MODELS", "gemini-3.8-flash-lite-tts,gemini-3.8-flash-tts,gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts"
).split(",") if m.strip()]
STYLE = "Say this in a confident, warm and natural voice, at a steady conversational pace"
GROQ_URL = "https://api.groq.com/openai/v1/audio/speech"
GROQ_MODEL = os.getenv("TTS_GROQ_MODEL", "canopylabs/orpheus-v1-english")
GROQ_VOICE = os.getenv("TTS_GROQ_VOICE", "troy")
GROQ_CHARS = 200  # Orpheus input limit per request

# name -> what it sounds like (Gemini prebuilt voices). The first is the default.
VOICES = {
    "Kore": "firm, confident (female)",
    "Orus": "firm, confident (male)",
    "Charon": "informative, calm (male)",
    "Sulafat": "warm (female)",
    "Achird": "friendly (male)",
    "Iapetus": "clear (male)",
    "Puck": "upbeat (male)",
    "Aoede": "breezy (female)",
    "Gacrux": "mature (female)",
    "Sadaltager": "knowledgeable (male)",
}
DEFAULT_VOICE = "Kore"
MAX_CHARS = 1500
RATE = 24000

_dead: set[str] = set()          # models that do not exist for this key
_rest: dict[str, float] = {}     # model -> time it may be tried again
_cache: dict[str, bytes] = {}    # small in-memory cache when there is no TTS_DIR


class VoiceError(Exception):
    pass


def clean(text: str) -> str:
    """What a person would say out loud: no markdown, code, links, citations or confidence lines."""
    t = re.sub(r"```.*?```", " ", text or "", flags=re.S)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"https?://\S+", " ", t)
    t = re.sub(r"\[S\d+[^\]]*\]", "", t)
    t = re.sub(r"\[(PROVEN[^\]]*|REASONED|ASSUMED|UNSURE|VERIFIED)[^\]]*\]", "", t, flags=re.I)
    t = re.sub(r"(?im)^\s*confidence\s*:.*$", "", t)
    t = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", t)
    t = re.sub(r"(?m)^\s*[-*+]\s+", "", t)
    t = re.sub(r"(?m)^\s*\|.*\|\s*$", "", t)
    t = re.sub(r"[*_~>#]+", "", t)
    t = re.sub(r"\s*\n\s*", ". ", t.strip())
    t = re.sub(r"\.(\s*\.)+", ".", t)
    return re.sub(r"\s{2,}", " ", t).strip()[:MAX_CHARS]


def wav(pcm: bytes, rate: int = RATE, channels: int = 1, bits: int = 16) -> bytes:
    """Raw little-endian PCM -> a playable WAV file."""
    block = channels * bits // 8
    head = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    head += b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, rate, rate * block, block, bits)
    return head + b"data" + struct.pack("<I", len(pcm)) + pcm


def pcm_of(data: bytes) -> bytes:
    """The sample bytes of a WAV (or the bytes as they are, if they are raw PCM)."""
    if data[:4] != b"RIFF":
        return data
    i = 12
    while i + 8 <= len(data):
        cid, size = data[i:i + 4], struct.unpack("<I", data[i + 4:i + 8])[0]
        if cid == b"data":
            return data[i + 8:i + 8 + size]
        i += 8 + size + (size & 1)
    return data[44:]


def _rate_of(mime: str) -> int:
    m = re.search(r"rate=(\d+)", mime or "")
    return int(m.group(1)) if m else RATE


def _env_keys(base: str) -> list[tuple[int, str]]:
    """[(slot, key)] for BASE, BASE_2, BASE_3 (Settings > API keys has 3 slots per provider). Duplicates are dropped."""
    out, seen = [], set()
    for slot, name in ((1, base), (2, f"{base}_2"), (3, f"{base}_3")):
        v = (os.environ.get(name) or "").strip()
        if v and v not in seen:
            seen.add(v)
            out.append((slot, v))
    return out


def _tag(model: str, slot: int) -> str:
    """Rest/quota tag of one model on one key: key 1 keeps the plain model name."""
    return model if slot <= 1 else f"{model}#{slot}"


def _available(model: str, slots=None) -> bool:
    if model in _dead:
        return False
    now = time.time()
    return any(_rest.get(_tag(model, s), 0) <= now for s in (slots or [1]))


async def _gemini(client: httpx.AsyncClient, text: str, voice: str) -> tuple[bytes, str]:
    keys = _env_keys("GEMINI_API_KEY")
    if not keys:
        raise VoiceError("Gemini key nahi hai")
    last = "koi Gemini TTS model nahi bacha"
    for model in GEMINI_MODELS:
        if model in _dead:
            continue
        said = text if "3.8" in model else f"{STYLE}: {text}"
        body = {
            "contents": [{"parts": [{"text": said}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
            },
        }
        # key 1, then key 2, then key 3 for the same model: a key that is out of quota (429), rejected (401/403)
        # or meets a server error moves on to the next key; a missing model (400/404) skips the model.
        for slot, key in keys:
            tag = _tag(model, slot)
            if _rest.get(tag, 0) > time.time():
                continue
            try:
                r = await client.post(GEMINI_URL.format(model=model), json=body, headers={"x-goog-api-key": key}, timeout=60)
            except httpx.HTTPError as e:
                last = f"{model}: network {type(e).__name__}"
                continue
            if r.status_code == 429:
                daily = "day" in r.text.lower() or "per_day" in r.text.lower()
                _rest[tag] = time.time() + (6 * 3600 if daily else 90)
                last = f"{model}: quota (429)"
                continue
            if r.status_code in (401, 402, 403):
                _rest[tag] = time.time() + 3600
                last = f"{model}: key {slot} HTTP {r.status_code}"
                continue
            if r.status_code in (400, 404):
                _dead.add(model)
                last = f"{model}: HTTP {r.status_code}"
                break
            if r.status_code != 200:
                last = f"{model}: HTTP {r.status_code}"
                continue
            try:
                part = r.json()["candidates"][0]["content"]["parts"][0]["inlineData"]
                raw = base64.b64decode(part["data"])
            except (KeyError, IndexError, ValueError, TypeError):
                last = f"{model}: audio nahi mila"
                break
            if not raw:
                break
            audio = raw if raw[:4] == b"RIFF" else wav(raw, _rate_of(part.get("mimeType", "")))
            return audio, model
    raise VoiceError(last)


def chunks(text: str, limit: int) -> list[str]:
    """Split at sentence ends (then at spaces) into pieces of at most `limit` characters."""
    pieces, cur = [], ""
    for word in text.split():
        while len(word) > limit:
            if cur:
                pieces.append(cur)
                cur = ""
            pieces.append(word[:limit])
            word = word[limit:]
        if cur and len(cur) + 1 + len(word) > limit:
            # prefer ending the piece at the last sentence end inside it
            cut = max(cur.rfind(". "), cur.rfind("? "), cur.rfind("! "))
            if cut > limit // 2:
                pieces.append(cur[:cut + 1])
                cur = cur[cut + 2:]
            else:
                pieces.append(cur)
                cur = ""
        cur = f"{cur} {word}".strip()
    if cur:
        pieces.append(cur)
    return pieces


def _english(text: str) -> bool:
    return not re.search(r"[\u0900-\u097F]", text)


async def _groq(client: httpx.AsyncClient, text: str) -> tuple[bytes, str]:
    now = time.time()
    keys = [(s, k) for s, k in _env_keys("GROQ_API_KEY") if _rest.get(_tag(GROQ_MODEL, s), 0) <= now]
    if not keys or not _english(text) or GROQ_MODEL in _dead:
        raise VoiceError("Groq voice nahi chal sakta")
    pieces = chunks(text, GROQ_CHARS)
    pcm, ki, last = b"", 0, "Groq voice nahi chal sakta"
    for p in pieces[:6]:
        while True:  # this piece with the current key; on quota / bad key / server error: the next key
            if ki >= len(keys):
                raise VoiceError(last)
            slot, key = keys[ki]
            try:
                r = await client.post(GROQ_URL, headers={"Authorization": f"Bearer {key}"}, timeout=60,
                                      json={"model": GROQ_MODEL, "voice": GROQ_VOICE, "input": p, "response_format": "wav"})
            except httpx.HTTPError as e:
                last, ki = f"Groq voice network {type(e).__name__}", ki + 1
                continue
            if r.status_code == 200:
                pcm += pcm_of(r.content)
                break
            if r.status_code == 429:
                _rest[_tag(GROQ_MODEL, slot)] = time.time() + 3600
                last, ki = "Groq voice quota (429)", ki + 1
                continue
            if r.status_code in (400, 404):
                _dead.add(GROQ_MODEL)
                raise VoiceError(f"Groq voice HTTP {r.status_code}")
            if r.status_code in (401, 402, 403):
                _rest[_tag(GROQ_MODEL, slot)] = time.time() + 3600
            last, ki = f"Groq voice HTTP {r.status_code}", ki + 1
    return wav(pcm, RATE), GROQ_MODEL


async def synth(text: str, voice: str = DEFAULT_VOICE, offline: bool = True) -> tuple[bytes, str]:
    """(wav bytes, model label). Raises VoiceError when no natural voice is available."""
    text = clean(text)
    if not text:
        raise VoiceError("bolne ko kuch nahi")
    voice = voice if voice in VOICES else DEFAULT_VOICE
    errors = []
    async with httpx.AsyncClient() as client:
        for fn in (lambda: _gemini(client, text, voice), lambda: _groq(client, text)):
            try:
                return await fn()
            except VoiceError as e:
                errors.append(str(e))
    if not offline:
        raise VoiceError("; ".join(errors))
    try:  # V6 offline fallback (Piper). Silent when not installed.
        from voice_v6 import offline
        return await offline.synth(text)
    except VoiceError:
        raise
    except Exception as e:
        errors.append(f"offline: {str(e)[:80]}")
    raise VoiceError("; ".join(errors))


def _store(key: str, audio: bytes) -> dict:
    d = os.environ.get("TTS_DIR")
    if not d:
        _cache[key] = audio
        while len(_cache) > 30:
            _cache.pop(next(iter(_cache)))
        return {"type": "audio", "mime": "audio/wav", "b64": base64.b64encode(audio).decode()}
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, key + ".wav")
    with open(path, "wb") as f:
        f.write(audio)
    files = sorted((os.path.join(d, n) for n in os.listdir(d) if n.endswith(".wav")), key=os.path.getmtime)
    for old in files[:-40]:  # keep the 40 newest clips
        try:
            os.remove(old)
        except OSError:
            pass
    return {"type": "audio", "file": path}


def _cached(key: str) -> dict | None:
    d = os.environ.get("TTS_DIR")
    if d:
        path = os.path.join(d, key + ".wav")
        if os.path.exists(path):
            os.utime(path)
            return {"type": "audio", "file": path, "cached": True}
        return None
    if key in _cache:
        return {"type": "audio", "mime": "audio/wav", "b64": base64.b64encode(_cache[key]).decode(), "cached": True}
    return None


def status() -> dict:
    return {
        "gemini": bool(_env_keys("GEMINI_API_KEY")),
        "groq_english": bool(_env_keys("GROQ_API_KEY")),
        "models": [m for m in GEMINI_MODELS if _available(m, [s for s, _ in _env_keys("GEMINI_API_KEY")])],
        "voices": VOICES,
    }


async def handle(req: dict) -> dict:
    if req.get("v6"):  # V6 streaming protocol (additive)
        from voice_v6 import protocol
        return await protocol.handle(req, remote=lambda t, v: synth(t, v, offline=False))
    if req.get("status"):
        return {"type": "voice", **status()}
    text = str(req.get("text") or "")
    voice = str(req.get("voice") or DEFAULT_VOICE)
    key = hashlib.sha1(f"{voice}|{clean(text)}".encode()).hexdigest()[:20]
    hit = _cached(key)
    if hit:
        return hit
    try:
        audio, model = await synth(text, voice)
    except VoiceError as e:
        return {"type": "error", "error": str(e)[:300]}
    out = _store(key, audio)
    out["model"] = model
    return out
