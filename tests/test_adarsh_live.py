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
    # the service name needs its separator: ".../google.ai.generativelanguage." + api + ".GenerativeService..."
    # without the trailing dot every attempt is answered with HTTP 404 (this shipped once and broke Live)
    assert 'google.ai.generativelanguage."' in LIVE
    assert 'METHOD = ".GenerativeService.BidiGenerateContent"' in LIVE
    assert "IN_RATE = 16000" in LIVE and "OUT_RATE = 24000" in LIVE   # documented PCM rates
    assert "MediaRecorder.AudioSource.VOICE_RECOGNITION" in LIVE
    assert "Base64.NO_WRAP" in LIVE
    assert 'put("mimeType", "audio/pcm;rate=$IN_RATE")' in LIVE


def test_setup_message_shape():
    for part in ('put("model", "models/$model")',
                 'put("responseModalities", JSONArray().put("AUDIO"))',
                 'put("prebuiltVoiceConfig"',
                 'put("systemInstruction"',
                 'put("inputAudioTranscription"',
                 'put("outputAudioTranscription"'):
        assert part in LIVE, part
    # barge-in: the model's queued audio is dropped when the user speaks
    assert 'optBoolean("interrupted")' in LIVE
    # the real reason arrives in the close frame, so it must reach the page (this is what looked like "connect nahi hua")
    assert 'override fun onClosing(webSocket: WebSocket, code: Int, reason: String)' in LIVE
    assert 'put("type", "error")' in LIVE and '"Live nahi chala — "' in LIVE
    # a refused model falls back instead of leaving the screen on "Connecting…"
    assert "FALLBACK" in LIVE and "next()" in LIVE


def test_every_endpoint_and_auth_variant_is_tried():
    # the Gemini 3.8 Live docs use v1alpha, the WebSocket guide uses v1beta; both auth forms are documented
    assert 'Variant("v1beta", true), Variant("v1alpha", true)' in LIVE
    assert 'Variant("v1beta", false), Variant("v1alpha", false)' in LIVE
    # each attempt is time-boxed and its outcome is kept, so the failure message says which one failed and why
    assert "SETUP_TIMEOUT_MS = 8_000L" in LIVE
    assert 'note("timeout")' in LIVE and 'trace.takeLast(3).joinToString(" | ")' in LIVE
    # Settings > Test Adarsh Live checks key + network with plain HTTPS before blaming the socket
    assert 'fun probe(ctx: Context, emit: (JSONObject) -> Unit)' in LIVE
    assert "https://generativelanguage.googleapis.com/v1beta/models/" in LIVE


def test_replies_are_read_from_binary_frames_too():
    # Gemini Live answers in binary frames; reading only text frames made every reply vanish ("no setup reply")
    assert "override fun onMessage(webSocket: WebSocket, bytes: ByteString)" in LIVE
    assert "take(bytes.utf8())" in LIVE and "override fun onMessage(webSocket: WebSocket, text: String)" in LIVE
    # the setup turn goes out after the handshake, with a 900 ms safety net for the identity-guard race
    assert "sendSetup(webSocket)" in LIVE and "!setupSent && !gotSetup" in LIVE
    # two payload shapes are tried: the official example (top-level responseModalities) first, nested second
    assert 'setup.put("responseModalities", JSONArray().put("AUDIO"))' in LIVE
    assert 'put("generationConfig", JSONObject()' in LIVE and "shape == 0" in LIVE


def test_key_is_never_placed_in_the_url_first():
    # header first, documented ?key= form only as a fallback, and the key is read on the device
    assert 'b.header("x-goog-api-key", key)' in LIVE
    assert '"?key=" + key' in LIVE
    assert 'AdarshApp).keys.first("GEMINI_API_KEY")' in ACTIVITY
    assert "keys.first(\"GEMINI_API_KEY\")" in ACTIVITY


def test_a_dead_network_fails_fast_instead_of_burning_every_timeout():
    # the host is resolved once, with a 6 s watchdog, before any socket is opened
    assert "DNS_TIMEOUT_MS = 6_000L" in LIVE and "InetAddress.getAllByName(HOST_NAME)" in LIVE
    assert "preflight()" in LIVE and '"Internet/DNS theek nahi — "' in LIVE
    # a network failure ends the sweep immediately; only endpoint/model answers move on to the next attempt
    assert "isNetwork(t)" in LIVE and "SETUP_TIMEOUT_MS = 8_000L" in LIVE
    # six attempts at most: the chosen model on all four endpoints, the fallbacks on the documented one
    assert "Triple(VARIANTS[0], model, 0)" in LIVE and "FALLBACK.map { Triple(VARIANTS[0], it, 0) }" in LIVE
    # the page shows which attempt is running
    assert 'put("attempt", step + 1).put("total", plans.size)' in LIVE
    assert "onState(ev.state, ev.model, ev)" in VOICE and "'Connecting…' + n" in VOICE


def test_auto_routing_roles_match_between_kotlin_and_the_ui():
    kt = dict(re.findall(r'"(\w+)" to "(gemini-[a-z0-9.\-]+)"', LIVE.split("val ROLE_MODEL")[1].split(")")[0]))
    js_block = VOICE.split("const LIVE_ROLES = {")[1].split("};")[0]
    js = dict(re.findall(r"(\w+): \['(gemini-[a-z0-9.\-]+)'", js_block))
    assert kt and kt == js, (kt, js)
    assert kt["main"] == "gemini-3.8-live" and kt["think"] == "gemini-3.8-live-extended-thinking"
    # the conversation moves to another model without losing it: resumption handle, else the recent transcript
    assert "fun switchTo(asked: String)" in LIVE
    assert 'put("sessionResumption"' in LIVE and "sessionResumptionUpdate" in LIVE
    assert "Pichli baat" in LIVE
    # auto is the default choice in Settings, and the classifier runs on the device
    assert "['auto', 'Auto" in VOICE and "function roleFor(text, current)" in VOICE


def test_models_match_between_kotlin_and_the_ui():
    kt = set(re.findall(r'"(gemini-[a-z0-9.\-]+)"', LIVE.split("val MODELS")[1].split(")")[0]))
    js = set(re.findall(r"\['(gemini-[a-z0-9.\-]+)'", VOICE))
    assert kt and kt == js, (sorted(kt), sorted(js))
    assert "gemini-3.8-live" in kt and "gemini-3.8-live-extended-thinking" in kt


def test_bridge_and_activity_expose_the_session():
    for name in ("liveStart", "liveStop", "liveSendText", "liveStatus", "liveProbe", "liveSwitch"):
        assert f"fun {name}(" in BRIDGE and f"fun {name}(" in ACTIVITY, name
    # the session is torn down with the screen: never background listening
    assert "live?.stop()" in ACTIVITY.split("override fun onDestroy")[1][:400]


def test_toggle_is_off_by_default_and_only_on_the_voice_screen():
    assert "adarshLive: false" in CORE
    assert "liveModel: 'auto'" in CORE
    assert "'Adarsh Live'" in VIEWS
    # started from Voice.open (the screen), not from the background service or Standard text chat
    assert "S.settings.adarshLive && Live.native()" in VOICE
    assert "liveStart" not in (KT / "BackgroundVoiceService.kt").read_text()
    assert "adarshLive" not in (ROOT / "standard_agent.py").read_text()


def test_philosophy_and_personality_reach_the_live_prompt():
    block = VOICE.split("function prompt()")[1].split("function start(")[0]
    assert "S.philosophy" in block and "Sir" in block and "slice(0, 3000)" in block

# Build note: this file is also a trigger for the Android APK workflow (tests/**).
