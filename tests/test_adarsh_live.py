"""Adarsh Live (Step 5): one Gemini Live WebSocket, spoken both ways, only while the voice screen is open.

These are source contracts: the sandbox has no Android SDK, so the Kotlin is compiled and exercised by CI.
The point is that the socket, the audio format, the model list and the key handling cannot drift silently.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KT = ROOT / "android/app/src/main/java/app/adarsh/ensemble"
LIVE = (KT / "AdarshLive.kt").read_text()
BRIDGE = (KT / "AdarshBridge.kt").read_text()
ACTIVITY = (KT / "MainActivity.kt").read_text()
VOICE = (ROOT / "ui/src/js/05-voice.js").read_text()
VIEWS = (ROOT / "ui/src/js/04-views.js").read_text()
CORE = (ROOT / "ui/src/js/01-core.js").read_text()


def test_endpoint_and_audio_format():
    assert "generativelanguage.googleapis.com" in LIVE
    assert "BidiGenerateContent" in LIVE
    assert "IN_RATE = 16000" in LIVE and "OUT_RATE = 24000" in LIVE   # documented PCM rates
    assert "MediaRecorder.AudioSource.VOICE_RECOGNITION" in LIVE
    assert "Base64.NO_WRAP" in LIVE
    assert 'put("mimeType", "audio/pcm;rate=$IN_RATE")' in LIVE


def test_setup_message_shape():
    for part in ('put("model", "models/$model")',
                 'put("responseModalities", org.json.JSONArray().put("AUDIO"))',
                 'put("prebuiltVoiceConfig"',
                 'put("systemInstruction"',
                 'put("inputAudioTranscription"',
                 'put("outputAudioTranscription"'):
        assert part in LIVE, part
    # barge-in: the model's queued audio is dropped when the user speaks
    assert 'optBoolean("interrupted")' in LIVE


def test_key_is_never_placed_in_the_url_first():
    # header first, documented ?key= form only as a fallback, and the key is read on the device
    assert 'b.header("x-goog-api-key", key)' in LIVE
    assert '"?key=" + key' in LIVE
    assert 'AdarshApp).keys.first("GEMINI_API_KEY")' in ACTIVITY
    assert "key" in ACTIVITY and "SecureKeys" not in ACTIVITY.split("fun liveStart")[1][:600]


def test_models_match_between_kotlin_and_the_ui():
    kt = set(re.findall(r'"(gemini-[a-z0-9.\-]+)"', LIVE.split("val MODELS")[1].split(")")[0]))
    js = set(re.findall(r"\['(gemini-[a-z0-9.\-]+)'", VOICE))
    assert kt and kt == js, (sorted(kt), sorted(js))
    assert "gemini-3.8-live" in kt and "gemini-3.8-live-extended-thinking" in kt


def test_bridge_and_activity_expose_the_session():
    for name in ("liveStart", "liveStop", "liveSendText", "liveStatus"):
        assert f"fun {name}(" in BRIDGE and f"fun {name}(" in ACTIVITY, name
    # the session is torn down with the screen: never background listening
    assert "live?.stop()" in ACTIVITY.split("override fun onDestroy")[1][:400]


def test_toggle_is_off_by_default_and_only_on_the_voice_screen():
    assert "adarshLive: false" in CORE
    assert "liveModel: 'gemini-3.8-live'" in CORE
    assert "'Adarsh Live'" in VIEWS
    # started from Voice.open (the screen), not from the background service or Standard text chat
    assert "S.settings.adarshLive && Live.native()" in VOICE
    assert "liveStart" not in (KT / "BackgroundVoiceService.kt").read_text()
    assert "adarshLive" not in (ROOT / "standard_agent.py").read_text()


def test_philosophy_and_personality_reach_the_live_prompt():
    block = VOICE.split("function prompt()")[1].split("function start(")[0]
    assert "S.philosophy" in block and "Sir" in block and "slice(0, 3000)" in block
