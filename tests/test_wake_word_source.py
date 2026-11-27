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


def test_service_uses_only_the_api31_on_device_recognizer_and_has_no_network_or_audio_upload_path():
    assert "SpeechRecognizer.createOnDeviceSpeechRecognizer(this)" in SERVICE
    assert "SpeechRecognizer.isOnDeviceRecognitionAvailable(context)" in SERVICE
    assert "SpeechRecognizer.createSpeechRecognizer(" not in SERVICE
    assert "EXTRA_PREFER_OFFLINE" in SERVICE
    assert "EXTRA_LANGUAGE, WAKE_LOCALE" in SERVICE
    for forbidden in ("AudioRecord(", "NvidiaBnrClient", "Engine.submit", "Backend.", "OkHttpClient", "HttpURLConnection"):
        assert forbidden not in SERVICE
    # The recognizer callback only emits state and a fixed wake event, never the recognized transcript.
    assert "put(\"transcript\"" not in SERVICE
    assert "MainActivity.wakeWordEvent(JSONObject().put(\"type\", \"wake\"))" in SERVICE
    assert 'val transcript = results?.getStringArrayList' in SERVICE
    assert "WakeWordMatcher.matches(transcript)" in SERVICE


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


def test_matcher_is_phrase_specific_and_stale_recognizer_callbacks_are_invalidated():
    assert 'words[0] == "hey" && words[1] == "adarsh"' in MATCHER
    assert "private fun isCurrent(token: Long)" in SERVICE
    assert "token == recognizerEpoch && recognizer != null" in SERVICE
    assert "private fun destroyRecognizer()" in SERVICE
    destroy = SERVICE.split("private fun destroyRecognizer()", 1)[1].split("private fun cancelRestart()", 1)[0]
    assert destroy.index("recognizerEpoch++") < destroy.index("old?.cancel()") < destroy.index("old?.destroy()")
    assert "if (!isCurrent(token)) return" in SERVICE
    assert "MAX_FAILURES = 3" in SERVICE


def test_wake_event_uses_notification_tap_while_backgrounded_and_never_starts_an_activity():
    event = ACTIVITY.split("fun wakeWordEvent(value: JSONObject)", 1)[1].split("fun deliverPendingWakeWordOpen()", 1)[0]
    assert "a.resumed && pageTrusted" in event
    assert "startActivity(" not in event
    assert "pendingWakeOpen = true" not in event  # only ACTION_OPEN_WAKE/tap may queue a deferred open
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
    assert "never silently switch a wake trigger to generic speech recognition" in VOICE
