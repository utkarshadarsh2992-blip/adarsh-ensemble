from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android/app/src/main"
SERVICE = (ANDROID / "java/app/adarsh/ensemble/WakeWordService.kt").read_text()
MATCHER = (ANDROID / "java/app/adarsh/ensemble/WakeWordMatcher.kt").read_text()
ACTIVITY = (ANDROID / "java/app/adarsh/ensemble/MainActivity.kt").read_text()
BRIDGE = (ANDROID / "java/app/adarsh/ensemble/AdarshBridge.kt").read_text()
MANIFEST = (ANDROID / "AndroidManifest.xml").read_text()
VOICE = (ROOT / "ui/src/js/05-voice.js").read_text()
DEFAULTS = (ROOT / "ui/src/js/01-core.js").read_text()
BACKGROUND = (ANDROID / "java/app/adarsh/ensemble/BackgroundVoiceService.kt").read_text()


def test_service_prefers_on_device_recognizer_with_disclosed_system_fallback_and_no_upload_path():
    assert "SpeechRecognizer.createOnDeviceSpeechRecognizer(this)" in SERVICE
    assert "SpeechRecognizer.isOnDeviceRecognitionAvailable(context)" in SERVICE
    # Phones without an on-device recognizer (Oppo/Realme/Vivo) use the default speech service, offline preferred.
    assert "SpeechRecognizer.createSpeechRecognizer(this)" in SERVICE
    assert "SpeechRecognizer.isRecognitionAvailable(context)" in SERVICE
    assert "onDeviceRecognizerAvailable(context) -> ENGINE_ON_DEVICE" in SERVICE
    assert "EXTRA_PREFER_OFFLINE, preferOffline" in SERVICE
    assert 'listOf("en-IN", "en-US", "hi-IN", null)' in SERVICE
    assert "triggerModelDownload" in SERVICE
    assert '.put("engine", engine)' in SERVICE
    for forbidden in ("AudioRecord(", "NvidiaBnrClient", "Engine.submit", "Backend.", "OkHttpClient", "HttpURLConnection"):
        assert forbidden not in SERVICE
    # The recognizer callback only emits state and a fixed wake event, never the recognized transcript.
    assert "put(\"transcript\"" not in SERVICE
    assert "MainActivity.wakeWordEvent(JSONObject().put(\"type\", \"wake\"))" in SERVICE
    assert "WakeWordMatcher.matchesAny(transcript)" in SERVICE
    assert "WakeWordMatcher.matchesAny(partial)" in SERVICE
    assert "EXTRA_PARTIAL_RESULTS, true" in SERVICE


def test_service_is_opt_in_visible_and_not_started_by_boot_or_task_restart():
    assert 'android:name=".WakeWordService"' in MANIFEST
    assert 'android:exported="false"' in MANIFEST
    assert 'android:foregroundServiceType="microphone"' in MANIFEST
    assert "ACTION_BOOT_COMPLETED" not in SERVICE
    assert "START_NOT_STICKY" in SERVICE
    assert ".setOngoing(true)" in SERVICE
    assert '.addAction(Notification.Action.Builder(null, "Stop", stop).build())' in SERVICE
    assert "FOREGROUND_SERVICE_TYPE_MICROPHONE" in SERVICE
    assert "RECORD_AUDIO" in SERVICE and "POST_NOTIFICATIONS" in ACTIVITY
    assert "startForegroundService(context, Intent(context, WakeWordService::class.java).setAction(ACTION_ENABLE))" in SERVICE
    assert "ACTION_STOP -> stopStandby(\"off\"" in SERVICE


def test_matcher_is_tolerant_but_needs_greeting_and_stale_callbacks_are_invalidated():
    assert '"hey", "hay"' in MATCHER and '"hi"' in MATCHER and '"हे"' in MATCHER
    assert "distance(token, NAME) <= 2" in MATCHER
    assert "if (w !in GREETINGS) continue" in MATCHER
    assert "nameLike(one + two)" in MATCHER
    assert "private fun isCurrent(token: Long)" in SERVICE
    assert "token == recognizerEpoch && recognizer != null" in SERVICE
    assert "private fun destroyRecognizer()" in SERVICE
    destroy = SERVICE.split("private fun destroyRecognizer()", 1)[1].split("private fun cancelRestart()", 1)[0]
    assert destroy.index("recognizerEpoch++") < destroy.index("old?.cancel()") < destroy.index("old?.destroy()")
    assert "if (!isCurrent(token)) return" in SERVICE
    assert "MAX_FAILURES = 5" in SERVICE


def test_wake_event_opens_voice_in_foreground_and_raises_app_from_background():
    event = ACTIVITY.split("fun wakeWordEvent(value: JSONObject)", 1)[1].split("fun deliverPendingWakeWordOpen()", 1)[0]
    assert "a.resumed && pageTrusted" in event
    assert "pendingWakeOpen = true" not in event  # only ACTION_OPEN_WAKE intents queue a deferred open
    wake = SERVICE.split("private fun onWakeWord()", 1)[1].split("private fun retryOrStop", 1)[0]
    assert "MainActivity.isOnScreen()" in wake and "bringAppForward()" in wake
    assert ".setFullScreenIntent(open, true)" in SERVICE
    assert "NotificationManager.IMPORTANCE_HIGH" in SERVICE
    assert ".setAction(ACTION_OPEN_WAKE)" in SERVICE
    assert "android.permission.USE_FULL_SCREEN_INTENT" in MANIFEST
    assert "WakeWordService.clearWakeAlert(this)" in ACTIVITY
    assert "ACTION_OPEN_WAKE" in ACTIVITY
    assert "dispatchPendingWakeWordOpen()" in ACTIVITY
    assert "android:launchMode=\"singleTask\"" in MANIFEST


def test_bridge_has_only_nonsecret_settings_api_and_voice_modes_pause_detector():
    for api in ("fun wakeWordSet(enabled: Boolean)", "fun wakeWordStatus()", "fun wakeWordPause(reason: String)", "fun wakeWordResume(reason: String)"):
        assert api in BRIDGE
    assert 'WakeWordService.pause(a, "dictation")' in ACTIVITY
    assert 'WakeWordService.pause(a, "live")' in ACTIVITY or 'WakeWordService.pause(this, "live")' in ACTIVITY
    assert 'WakeWordService.pause(this, "background_voice")' in ACTIVITY
    assert 'WakeWordService.pause(applicationContext, "tts:$id")' in ACTIVITY
    assert 'WakeWordService.pause(this, "background_voice")' in BACKGROUND
    assert 'WakeWordService.resume(this, "background_voice")' in BACKGROUND
    assert "wakeWordEnabled: false" in DEFAULTS
    assert "window.__adarshWakeWord = (event)" in VOICE
    assert "Voice.open({ wakeWord: true, listen: true })" in VOICE
    assert "WakeWord.pause('voice')" in VOICE and "WakeWord.resume('voice')" in VOICE
    assert "if (opts.wakeWord === true)" in VOICE
    assert "if (S.settings.adarshLive && Live.native())" in VOICE
    assert "if (STT.supported()) { caption('', 'Haan Sir, bolo" in VOICE
