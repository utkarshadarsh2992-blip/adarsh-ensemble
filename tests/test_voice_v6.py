import asyncio, os, wave, io, shutil, pytest
import voice
from voice_v6 import language_detector as ld, text_normalizer as tn, hinglish_processor as hp
from voice_v6 import voice_router as r, protocol, voice_config as cfg
from voice_v6.providers import local_tts
from voice_v6.speech_queue import SpeechQueue

MODELS = "/tmp/tts_eval/models"
HAVE = os.path.exists(f"{MODELS}/en_US-ryan-medium.onnx") and os.path.exists(f"{MODELS}/hi_IN-rohan-medium.onnx")
try:
    import piper  # noqa
except Exception:
    HAVE = False
needs_piper = pytest.mark.skipif(not HAVE, reason="piper models not present")
run = asyncio.run


@pytest.fixture(autouse=True)
def clean(monkeypatch, tmp_path):
    r.reset(); local_tts._voices.clear()
    monkeypatch.setenv("PIPER_DIR", str(tmp_path / "none"))
    monkeypatch.delenv("TTS_DIR", raising=False)
    for k in ("GEMINI_API_KEY", "GROQ_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    from voice_v6.speech_queue import QUEUE
    QUEUE.items.clear(); QUEUE.active = None
    yield
    r.reset()


def test_detect():
    assert ld.detect("Newton's second law") == "en"
    assert ld.detect("सर, एन्ट्रॉपी का मतलब क्या होता है?") == "hi"
    assert ld.detect("Sir, entropy ka matlab kya hota hai?") == "hinglish"
    assert ld.word_lang("is") == "en" and ld.word_lang("hai") == "hi"


def test_normalize():
    assert tn.normalize("It is 42%") == "It is forty two percent"
    assert tn.normalize("1,250 items") == "one thousand two hundred fifty items"
    assert tn.normalize("pi is 3.14") == "pi is three point one four"
    assert tn.normalize("२०२४ में", hindi_digits=True) == "२०२४ में"
    assert tn.normalize("TCP/IP and API") == "TCP/IP and API"  # technical terms untouched


def test_sentences_and_spans():
    ss = hp.sentences("Pehli line hai. Doosri line? तीसरी।\nChauthi")
    assert len(ss) == 4
    assert len(hp.sentences("word " * 120)) >= 3
    sp = hp.spans("Machine learning ek statistical approach hai")
    assert [s.lang for s in sp] == ["hi"]  # Hinglish -> Hindi voice (benchmarked: reads English terms right)
    assert [s.lang for s in hp.spans("Newton's second law states F = ma")] == ["en"]
    mixed = hp.spans("Gradient descent optimization algorithm is iterative. Isko samajh lo bhai")
    assert [s.lang for s in mixed] == ["en", "hi"]
    assert "".join(s.text for s in sp) == "Machine learning ek statistical approach hai"
    # tiny English island inside Hindi stays Hindi (no choppy switch)
    assert [s.lang for s in hp.spans("यह API बहुत अच्छा है")] == ["hi"]


def test_plan_numbers_and_empty():
    p = hp.plan("Total 5 items. Done.")
    assert p[0]["text"] == "Total five items." and len(p) == 2
    assert hp.plan("   ") == []


def test_profile_clamps():
    p = cfg.VoiceProfile.of({"rate": 9, "pause_ms": -5, "junk": 1})
    assert p.rate == 2.0 and p.pause_ms == 0 and p.gender == "male"


def test_queue_duplicate_interrupt_controls():
    q = SpeechQueue()
    assert q.start("a", [1, 2]) and not q.start("a", [1])
    assert q.pause("a") and q.state("a") == "paused" and not q.alive("a")
    assert q.resume("a") and q.alive("a")
    assert q.start("b", [1]) and q.state("a") == "interrupted"
    assert q.stop("b") and q.state("b") == "stopped" and not q.stop("b")


def test_protocol_validation():
    for bad in ({"v6": "nope"}, {"v6": "plan", "text": " "}, {"v6": "chunk"}, {"v6": "control", "action": "x"}):
        assert run(protocol.handle(bad))["type"] == "error"


def _fail(*a, **k):
    raise voice.VoiceError("down")


async def _plan_and_chunk(text, remote, **kw):
    pl = await protocol.handle({"v6": "plan", "text": text, "response_id": "r1"})
    out = [await protocol.handle({"v6": "chunk", "response_id": "r1", "index": i, **kw}, remote) for i in range(pl["count"])]
    return pl, out


def test_everything_down_falls_to_android():
    async def dead(t, v): raise voice.VoiceError("429")
    pl, out = run(_plan_and_chunk("Pehla vakya. Doosra vakya.", dead))
    assert pl["count"] == 2
    assert all(o["type"] == "device_chunk" and o["engine"] == "android" for o in out)
    assert out[1]["last"] and not out[0]["last"]
    assert r.is_dead("remote") and r.is_dead("local")


def test_dead_provider_not_retried():
    calls = []
    async def dead(t, v): calls.append(t); raise voice.VoiceError("429")
    run(_plan_and_chunk("One. Two. Three.", dead))
    assert len(calls) == 1  # remote tried once, then skipped


def test_remote_success_and_cancel():
    async def ok(t, v): return b"RIFFfake", "gemini-x"
    pl, out = run(_plan_and_chunk("One. Two.", ok))
    assert all(o["type"] == "audio_chunk" and o["engine"] == "remote:gemini-x" and o["b64"] for o in out)

    async def go():
        await protocol.handle({"v6": "plan", "text": "A. B.", "response_id": "r2"})
        c = await protocol.handle({"v6": "control", "action": "stop", "response_id": "r2"})
        n = await protocol.handle({"v6": "chunk", "response_id": "r2", "index": 0}, ok)
        d = await protocol.handle({"v6": "plan", "text": "A. B.", "response_id": "r2"})
        return c, n, d
    c, n, d = run(go())
    assert c["ok"] and n["type"] == "cancelled" and d["type"] == "duplicate"


def test_voice_handle_dispatch_and_old_path_intact():
    assert run(voice.handle({"v6": "status"}))["type"] == "voice_v6"
    assert run(voice.handle({"status": True}))["type"] == "voice"
    e = run(voice.handle({"text": "hello"}))
    assert e["type"] == "error"  # no keys, no models -> clean error, same as before


def test_install_with_fake_fetch(tmp_path, monkeypatch):
    monkeypatch.setenv("PIPER_DIR", str(tmp_path / "p"))
    def fetch(u, d): open(d, "wb").write(b"x")
    assert local_tts.install(fetch=fetch) == {"hi": "installed", "en": "installed"}
    assert local_tts.install(fetch=fetch) == {"hi": "present", "en": "present"}
    bad = local_tts.install(("en",), fetch=lambda u, d: (_ for _ in ()).throw(OSError("net")))
    assert bad == {"en": "present"}


@needs_piper
def test_piper_real_synthesis(monkeypatch):
    monkeypatch.setenv("PIPER_DIR", MODELS)
    for f in ("hi_IN-rohan-medium", "en_US-ryan-medium"):  # ensure .onnx.json naming
        assert os.path.exists(f"{MODELS}/{f}.onnx.json")
    async def dead(t, v): raise voice.VoiceError("offline")
    pl, out = run(_plan_and_chunk("Sir, entropy ka matlab kya hota hai? Newton's second law is F equals m a.", dead))
    assert [o["engine"] for o in out] == ["piper", "piper"]
    # OFFLINE whole-text path through voice.synth (no keys at all)
    wavb, label = run(voice.synth("मशीन लर्निंग एक approach है।"))
    assert label == "piper-offline"
    w = wave.open(io.BytesIO(wavb)); assert w.getnframes() > 8000 and w.getnchannels() == 1
