from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "android/app/src/main/java/app/adarsh/ensemble"


def source(name: str) -> str:
    return (NATIVE / name).read_text(encoding="utf-8")


def test_service_exposes_explicit_api_and_foreground_contract():
    service = source("BackgroundVoiceService.kt")
    for signature in (
        "fun start(activity: MainActivity, configJson: String): JSONObject",
        "fun stop(context: Context): JSONObject",
        "fun status(): JSONObject",
        "fun peek(context: Context): JSONArray",
        "fun ack(context: Context, ids: JSONArray): JSONObject",
    ):
        assert signature in service
    assert "Lifecycle.State.RESUMED" in service
    assert "RECORD_AUDIO" in service and "POST_NOTIFICATIONS" in service
    assert "ContextCompat.startForegroundService" in service
    assert "ServiceCompat.startForeground" in service
    assert "FOREGROUND_SERVICE_TYPE_MICROPHONE" in service
    assert "FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK" in service
    assert "return START_NOT_STICKY" in service
    assert "onTaskRemoved" in service and "onDestroy" in service


def test_config_is_allowlisted_and_manual_source_is_not_rewritten():
    service = source("BackgroundVoiceService.kt")
    assert 'CONFIG_KEYS = setOf("chatId", "mode", "source", "lang", "access", "history", "reply", "voice")' in service
    assert 'source == "auto"' in service
    assert "original source" in service
    assert 'mode in ALLOWED_MODES' in service
    assert 'voiceEngine in setOf("auto", "natural", "device")' in service
    assert 'VOICE_NAMES = setOf(' in service
    assert 'put("mode", c.mode)' in service
    assert 'put("source", "auto")' in service


def test_inbox_is_peek_then_ack_bounded_and_atomic():
    store = source("BackgroundVoiceStore.kt")
    service = source("BackgroundVoiceService.kt")
    for field in ('"id"', '"chatId"', '"text"', '"reply"', '"mode"', '"ts"', '"localOnly"', '"personalContext"'):
        assert field in store
    assert "fun peek(): JSONArray" in store
    assert "fun ack(ids: JSONArray): JSONObject" in store
    assert "MAX_RECORDS = 64" in store
    assert "ATOMIC_MOVE" in store
    assert "stream.fd.sync()" in store
    assert "BackgroundVoiceStore(context).peek()" in service
    assert "BackgroundVoiceStore(context).ack(ids)" in service
    # Reply persistence precedes the UI event; ack is a separate bridge operation.
    assert service.index("store?.append(record)") < service.index('emit(JSONObject().put("type", "reply")')


def test_engine_request_and_voice_output_are_native_and_token_guarded():
    service = source("BackgroundVoiceService.kt")
    assert 'Engine.submit(id, request.toString()' in service
    assert 'foreground = false' in service
    assert 'put("meta", JSONObject().put("voice", true)' in service
    assert 'JSONObject().put("tts", JSONObject()' in service
    assert 'audioFile(it)' in service
    assert 'VoiceManager(this)' in service and 'Speaker(this)' in service
    assert 'voiceEngine != "device"' in service
    assert 'ttsKind = "neural"' in service and 'ttsKind = "device"' in service
    assert 'token != generation.get()' in service
    assert 'Engine.cancel(id)' in service


def test_background_local_action_policy_is_strict_and_does_not_run_model_actions():
    service = source("BackgroundVoiceService.kt")
    assert 'optString("origin") == "local-rule"' in service
    assert 'c.mode != "standard"' in service
    assert 'root.optString("mode") != "standard"' in service
    assert "MAX_LOCAL_STEPS = 3" in service
    assert "ActionRunner(this).run(step, false)" in service
    assert 'action == "settings.update"' in service
    assert 'action.startsWith("memory.")' in service
    assert "confirmation chahiye" in service
    assert "model output is never executable" in service
    assert 'personal_context", "omitted")' in service
    assert 'put("run", JSONObject().put("state", "done").put("results", resultMap))' in service
    assert '.put("done", done).put("failed", failed)' in service
    assert 'put("actionResults", results)' not in service
    assert 'put("type", "text").put("text", message)' in service


def test_recognition_silence_is_nonfatal_and_session_tokens_guard_delayed_work():
    service = source("BackgroundVoiceService.kt")
    assert "recognizerFatalErrors" in service
    assert "recognizerNonFatalRestarts" in service
    assert "fatal = false" in service
    assert "MAX_NON_FATAL_RESTARTS" in service
    assert "NON_FATAL_RETRY_DELAY_MS" in service
    assert "sessionToken == generation.get()" in service
    assert "recognizerFatalErrors = 0" in service
    assert "recognizerNonFatalRestarts = 0" in service
    start = service.split("override fun onStartCommand", 1)[1].split("private fun startForegroundNow", 1)[0]
    assert "recognizerToken = 0L" not in start
    assert "outputToken = 0L" not in start


def test_voice_fallback_covers_synthesis_and_playback_timeouts():
    service = source("BackgroundVoiceService.kt")
    assert "speakNeuralOrDevice(text, token)" in service
    assert "fallbackNeuralOrDevice(token, outputId)" in service
    assert "fallbackDevice(token, outputId)" in service
    assert "scheduleOutputTimeout(token, outId)" in service
    assert "ttsKind == \"natural\"" in service
    assert "ttsKind == \"neural\"" in service


def test_launch_epoch_and_status_are_cancellable_and_stable():
    service = source("BackgroundVoiceService.kt")
    assert "EXTRA_LAUNCH_EPOCH" in service
    assert "requestedEpoch != launchEpoch.get()" in service
    assert "launchEpoch.incrementAndGet()" in service
    assert "pendingStartEpoch" in service
    assert 'response(true, false, "starting"' in service
    assert 'response(true, false, "stopped", "Background voice stopped"' in service
    for field in ('"ok"', '"active"', '"state"', '"message"', '"error"', '"chatId"', '"mode"'):
        assert f'put({field}' in service


def test_recognition_and_session_lifecycle_are_bounded():
    service = source("BackgroundVoiceService.kt")
    assert "SpeechRecognizer" in service
    assert "MAX_RECOGNIZER_RETRIES = 3" in service
    assert "RETRY_DELAYS_MS" in service
    assert "ERROR_INSUFFICIENT_PERMISSIONS" in service
    assert "ERROR_AUDIO" in service
    assert "SESSION_LIMIT_MS = 30 * 60 * 1000L" in service
    assert "acquire(SESSION_LIMIT_MS)" in service
    assert "wakeLock" in service and "release()" in service
    assert 'normalized == "stop voice chat"' in service
    assert 'normalized == "voice chat band karo"' in service
    assert "destroyRecognizer()" in service
    assert "speaker?.stopAll(silent = true)" in service
    assert "neural?.stop()" in service


def test_permission_grants_resume_only_visible_uncancelled_start():
    activity = source("MainActivity.kt")
    assert "private data class PendingBackground" in activity
    assert "pending.token == backgroundNotificationToken" in activity
    assert "token != backgroundGeneration" in activity
    assert "pendingBackground?.token != token" in activity
    assert "if (!resumed || backgroundAwaitingPermission) return waiting" in activity
    assert "web.post { if (resumed && !destroyed && pendingBackground != null)" in activity
    stop = activity.split("fun backgroundVoiceStop(): String", 1)[1].split("fun backgroundVoicePeek", 1)[0]
    assert "backgroundGeneration++" in stop and "pendingBackground = null" in stop


def test_background_history_derived_turns_keep_personal_context_provenance():
    service = source("BackgroundVoiceService.kt")
    assert 'val personalContextUsed = c.accessCurrentChat && c.localRead && c.access.optBoolean("personalOnline") && history.isNotEmpty()' in service
    assert "handleReply(text, result, personalContextUsed, token)" in service
    assert "completeTurn(userText, reply, false, personalContextUsed, token)" in service
    assert '.put("personalContext", personalContext)' in service
