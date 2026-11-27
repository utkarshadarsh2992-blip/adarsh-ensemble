package app.adarsh.ensemble

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Explicit, user-started native conversation outside the WebView. This service is deliberately not sticky:
 * stopping the app task, destroying the service, or any fatal microphone/foreground error ends the session.
 */
class BackgroundVoiceService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private val generation = AtomicLong(0L)
    private var config: SessionConfig? = null
    private var active = false
    private var state = "inactive"
    private var lastError = ""
    private var recognizer: SpeechRecognizer? = null
    private var recognizerFatalErrors = 0
    private var recognizerNonFatalRestarts = 0
    private var recognizerToken = 0L
    private var requestId: String? = null
    private var ttsId: String? = null
    private var outputToken = 0L
    private var wakeLock: PowerManager.WakeLock? = null
    private var speaker: Speaker? = null
    private var neural: VoiceManager? = null
    private var ttsKind = ""
    private var history = mutableListOf<HistoryTurn>()
    private var store: BackgroundVoiceStore? = null
    private var cleaned = false
    private var sessionEpoch = 0L
    /** Standby: already a foreground service (started while the voice screen was visible), not listening yet. */
    private var standby = false

    override fun onCreate() {
        super.onCreate()
        live = this
        store = BackgroundVoiceStore(this)
        // Speaker and VoiceManager are created on the service main thread, as required by Android audio APIs.
        speaker = Speaker(this) { type, id -> main.post { onOutputEvent(type, id) } }
        neural = VoiceManager(this) { type, id -> main.post { onOutputEvent(type, id) } }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            launchEpoch.incrementAndGet()
            if (standby && !active) endStandby() else stopSession("stopped")
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_PREPARE) {
            if (active) return START_NOT_STICKY
            try {
                startForegroundNow(ready = true)
                live = this
                standby = true
                cleaned = false
                standbyToken++
                val t = standbyToken
                // the voice screen re-arms after every turn; an abandoned standby ends on its own
                main.postDelayed({ if (standby && !active && t == standbyToken) endStandby() }, SESSION_LIMIT_MS)
            } catch (_: Throwable) {
                standby = false
                stopSelf()
            }
            return START_NOT_STICKY
        }
        if (intent?.action != ACTION_START || intent.getStringExtra(EXTRA_CONFIG).isNullOrBlank()) {
            stopSession("invalid_start")
            return START_NOT_STICKY
        }
        val requestedEpoch = intent.getLongExtra(EXTRA_LAUNCH_EPOCH, 0L)
        if (requestedEpoch <= 0L || requestedEpoch != launchEpoch.get()) {
            if (!active) stopSelfResult(startId)
            return START_NOT_STICKY
        }
        if (active) return START_NOT_STICKY
        beginSession(intent.getStringExtra(EXTRA_CONFIG)!!, requestedEpoch)
        return START_NOT_STICKY
    }

    /** Starts listening. From standby the service is already in the foreground (no background-start limits apply). */
    private fun beginSession(raw: String, requestedEpoch: Long) {
        if (active) return
        WakeWordService.pause(this, "background_voice")
        live = this
        sessionEpoch = requestedEpoch
        try {
            if (standby) { standby = false; standbyToken++; updateNotificationNow("Listening") } else startForegroundNow()
            val parsed = parseConfig(raw)
            pendingStartEpoch = 0L
            config = parsed
            history = parsed.history.toMutableList()
            active = true
            cleaned = false
            state = "starting"
            lastError = ""
            recognizerFatalErrors = 0
            recognizerNonFatalRestarts = 0
            // Recognizer/output IDs remain monotonic across restarts so an old callback cannot match a new turn.
            requestId = null
            ttsId = null
            ttsKind = ""
            lastSpokenText = ""
            val sessionToken = generation.incrementAndGet()
            wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:backgroundVoice")
                .apply { setReferenceCounted(false); acquire(SESSION_LIMIT_MS) }
            main.postDelayed({
                if (active && sessionToken == generation.get() && sessionEpoch == requestedEpoch) {
                    stopSession("session_timeout")
                }
            }, SESSION_LIMIT_MS)
            emitStatus()
            beginListening(sessionToken, 0L)
        } catch (e: Throwable) {
            cleaned = false   // failAndStop reports the error to the app and removes the notice
            failAndStop("Could not start voice chat: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    /** Ends a standby that never started listening (voice screen closed, app destroyed or 30 minutes idle). */
    private fun endStandby() {
        if (!standby || active) return
        standby = false
        standbyToken++
        cleaned = true   // nothing to report: no session ran
        try { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE) } catch (_: Exception) { try { stopForeground(true) } catch (_: Exception) {} }
        live = null
        stopSelf()
    }

    private fun updateNotificationNow(text: String) {
        try { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(text)) } catch (_: Exception) {}
    }

    private fun buildNotification(text: String): Notification {
        val stop = PendingIntent.getService(
            this, 42, Intent(this, BackgroundVoiceService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val open = PendingIntent.getActivity(
            this, 43, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Adarsh voice chat")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    private fun startForegroundNow(ready: Boolean = false) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Background voice", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Microphone and spoken replies for an active Adarsh voice chat"
            }
        )
        val notification = buildNotification(if (ready) "Ready: app se bahar bhi baat jaari rahegi" else "Voice chat is active")
        if (Build.VERSION.SDK_INT >= 29) {
            ServiceCompat.startForeground(
                this, NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun beginListening(token: Long, delayMs: Long) {
        if (!active || token != generation.get()) return
        main.postDelayed({
            if (!active || token != generation.get()) return@postDelayed
            if (!SpeechRecognizer.isRecognitionAvailable(this)) {
                failAndStop("Speech recognition unavailable")
                return@postDelayed
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                failAndStop("Microphone permission is required")
                return@postDelayed
            }
            destroyRecognizer()
            val r = try { SpeechRecognizer.createSpeechRecognizer(this) } catch (_: Throwable) { null }
            if (r == null) {
                failAndStop("Speech recognition unavailable")
                return@postDelayed
            }
            val localRecognizerToken = ++recognizerToken
            recognizer = r
            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) { if (isRecognizerCurrent(localRecognizerToken)) setState("listening") }
                override fun onBeginningOfSpeech() { if (isRecognizerCurrent(localRecognizerToken)) setState("hearing") }
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
                override fun onPartialResults(partialResults: Bundle?) {}

                override fun onResults(results: Bundle?) {
                    if (!isRecognizerCurrent(localRecognizerToken)) return
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
                    destroyRecognizer()
                    if (text.isBlank()) {
                        retryRecognition(token, "empty", fatal = false)
                    } else {
                        recognizerFatalErrors = 0
                        recognizerNonFatalRestarts = 0
                        handleUtterance(text, token)
                    }
                }

                override fun onError(error: Int) {
                    if (!isRecognizerCurrent(localRecognizerToken)) return
                    destroyRecognizer()
                    when (error) {
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> failAndStop("Microphone permission is required")
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT ->
                            retryRecognition(token, "no speech", fatal = false)
                        SpeechRecognizer.ERROR_AUDIO -> retryRecognition(token, "microphone audio error", fatal = true)
                        SpeechRecognizer.ERROR_CLIENT -> if (active) retryRecognition(token, "recognizer stopped", fatal = true)
                        SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_NETWORK,
                        SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER ->
                            retryRecognition(token, "recognition error", fatal = true)
                        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
                            failAndStop("Speech language is unavailable")
                        else -> retryRecognition(token, "recognition error", fatal = true)
                    }
                }
            })
            val lang = config?.lang?.ifBlank { "en-IN" } ?: "en-IN"
            val input = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            try {
                r.startListening(input)
                setState("listening")
            } catch (_: Throwable) {
                destroyRecognizer()
                retryRecognition(token, "recognizer start failed", fatal = true)
            }
        }, delayMs)
    }

    private fun retryRecognition(token: Long, reason: String, fatal: Boolean) {
        if (!active || token != generation.get()) return
        val delay: Long
        if (fatal) {
            if (recognizerFatalErrors >= MAX_RECOGNIZER_RETRIES) {
                failAndStop("Voice recognition stopped: $reason")
                return
            }
            delay = FATAL_RETRY_DELAYS_MS[recognizerFatalErrors++]
        } else {
            if (recognizerNonFatalRestarts >= MAX_NON_FATAL_RESTARTS) {
                failAndStop("Voice recognition stopped: too many silent restarts")
                return
            }
            recognizerNonFatalRestarts++
            delay = NON_FATAL_RETRY_DELAY_MS
        }
        setState("retrying")
        beginListening(token, delay)
    }

    private fun handleUtterance(text: String, token: Long) {
        if (!active || token != generation.get()) return
        val normalized = text.lowercase(Locale.ROOT).replace(Regex("[^\\p{L}\\p{N} ]+"), " ").replace(Regex("\\s+"), " ").trim()
        if (normalized == "stop voice chat" || normalized == "voice chat band karo") {
            stopSession("user_stop")
            return
        }
        val c = config ?: return
        val id = "bv-${UUID.randomUUID()}"
        requestId = id
        setState("thinking")
        // History is already filtered by the UI. Conservatively preserve provenance when a
        // sharing-enabled history could contain personal replies, so later disabling sharing excludes derived turns.
        val personalContextUsed = c.accessCurrentChat && c.localRead && c.access.optBoolean("personalOnline") && history.isNotEmpty()
        val request = JSONObject()
            .put("chat_id", c.chatId)
            .put("text", text.take(MAX_TEXT_CHARS))
            .put("mode", c.mode) // selected mode is a session snapshot; never silently changed
            .put("source", "auto")
            .put("history", historyJson(c.accessCurrentChat))
            .put("access", c.access)
            .put("meta", JSONObject().put("voice", true).put("background", true)
                .put("personal_context", "omitted"))
            .put("reply", c.reply)
        Engine.submit(id, request.toString(), { _ -> }, foreground = false) { result, error ->
            main.post {
                if (!active || token != generation.get() || requestId != id) return@post
                requestId = null
                if (error != null || result == null) {
                    completeTurn(text, JSONObject().put("type", "text").put("text", "Abhi jawab nahi aa paya. App kholkar dobara try karo."), false, personalContextUsed, token)
                } else {
                    handleReply(text, result, personalContextUsed, token)
                }
            }
        }
        // Engine has its own Python timeout; this token timeout also prevents a late callback from reviving the mic.
        main.postDelayed({
            if (active && token == generation.get() && requestId == id) {
                Engine.cancel(id)
                requestId = null
                completeTurn(text, JSONObject().put("type", "text").put("text", "Jawab mein bahut der ho rahi hai. App kholkar dobara try karo."), false, personalContextUsed, token)
            }
        }, CHAT_TIMEOUT_MS)
    }

    private fun handleReply(userText: String, raw: String, personalContextUsed: Boolean, token: Long) {
        val parsed = try {
            val t = raw.trim()
            if (t.startsWith("[")) JSONArray(t) else JSONObject(t)
        } catch (_: Exception) {
            JSONObject().put("type", "text").put("text", "Jawab samajh nahi aaya. App kholkar dobara try karo.")
        }
        val local = when (parsed) {
            is JSONArray -> parsed.optJSONObject(0)?.optString("origin") == "local-rule"
            is JSONObject -> parsed.optString("origin") == "local-rule"
            else -> false
        }
        if (local) {
            val reply = executeLocalReply(parsed)
            completeTurn(userText, reply, true, false, token)
        } else {
            val text = spokenText(parsed)
            val reply = if (parsed is JSONObject) JSONObject(parsed.toString()) else JSONArray(parsed.toString())
            completeTurn(userText, reply, false, personalContextUsed, token)
        }
    }

    /** Only Python local-rule plans in Standard mode may cross into ActionRunner; model output is never executable. */
    private fun executeLocalReply(parsed: Any): JSONObject {
        val root = when (parsed) {
            is JSONArray -> parsed.optJSONObject(0) ?: JSONObject()
            is JSONObject -> parsed
            else -> JSONObject()
        }
        val c = config ?: return blockedLocal("Background voice is not ready to execute actions.")
        if (c.mode != "standard" || root.optString("mode") != "standard" || root.optString("origin") != "local-rule") {
            return blockedLocal("Native background actions require the selected Standard mode.")
        }
        val steps = root.optJSONArray("steps")
        if (root.optBoolean("needsConfirm", false)) {
            return blockedLocal("Is action ke liye app mein wapas aakar confirmation chahiye; background mein kuch execute nahi kiya.")
        }
        if (steps == null || steps.length() == 0 || steps.length() > MAX_LOCAL_STEPS) {
            return blockedLocal("Background voice ek turn mein zyada se zyada teen safe actions chala sakta hai.")
        }
        val resultMap = JSONObject()
        var done = 0
        var failed = 0
        val messages = mutableListOf<String>()
        val readActions = setOf("task.list", "note.list", "reminder.list", "alarm.list", "work.list")
        val editActions = setOf("task.add", "task.edit", "task.done", "note.add", "note.edit", "reminder.add", "reminder.edit", "alarm.add", "alarm.edit", "timer.start", "work.add", "work.edit", "work.done", "work.log")
        val safe = readActions + editActions + setOf("phone.status")
        for (i in 0 until steps.length()) {
            val step = steps.optJSONObject(i) ?: return blockedLocal("Action plan invalid hai; app mein kholkar check karo.")
            val action = step.optString("action")
            if (action == "settings.update" || action.startsWith("memory.")) {
                return blockedLocal("Settings aur memory operations app mein hi supported hain; app dobara kholo.")
            }
            if (action !in safe) {
                return blockedLocal("Is action ke liye app mein wapas aakar confirmation chahiye; background mein kuch execute nahi kiya.")
            }
            if (action in readActions && !c.localRead || action in editActions && !c.localEdit) {
                return blockedLocal("Local read/edit access off hai; app mein Settings > AI access se allow karo.")
            }
        }
        for (i in 0 until steps.length()) {
            val sourceStep = steps.getJSONObject(i)
            val stepId = sourceStep.optString("id").trim().ifBlank { "step-${i + 1}" }
            val step = JSONObject(sourceStep.toString()).put("id", stepId)
            val result = runActionOnMain(step)
            val normalized = JSONObject(result.toString()).put("id", stepId)
            resultMap.put(stepId, normalized)
            if (normalized.optBoolean("ok", false)) done++ else failed++
            normalized.optString("message").trim().takeIf { it.isNotBlank() }?.let { messages += it }
        }
        val text = messages.joinToString(". ").ifBlank { "Background actions complete." }
        return JSONObject(root.toString())
            .put("text", text)
            .put("run", JSONObject().put("state", "done").put("results", resultMap))
            .put("done", done).put("failed", failed)
            .put("backgroundExecuted", true)
    }

    private fun blockedLocal(message: String): JSONObject = JSONObject()
        .put("type", "text").put("text", message).put("backgroundBlocked", true).put("backgroundExecuted", false)

    private fun runActionOnMain(step: JSONObject): JSONObject {
        if (Looper.myLooper() == Looper.getMainLooper()) return ActionRunner(this).run(step, false)
        var result = JSONObject().put("ok", false).put("message", "Native action timeout")
        val latch = CountDownLatch(1)
        main.post {
            try { result = ActionRunner(this).run(step, false) } catch (e: Exception) {
                result = JSONObject().put("ok", false).put("message", e.message ?: e.javaClass.simpleName)
            } finally { latch.countDown() }
        }
        latch.await(ACTION_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        return result
    }

    private fun completeTurn(userText: String, reply: Any, localOnly: Boolean, personalContext: Boolean, token: Long) {
        if (!active || token != generation.get()) return
        val c = config ?: return
        val spoken = spokenText(reply).ifBlank { "Jawab tayyar hai." }
        val record = JSONObject()
            .put("id", "reply-${UUID.randomUUID()}")
            .put("chatId", c.chatId)
            .put("text", userText.take(MAX_TEXT_CHARS))
            .put("reply", reply)
            .put("mode", c.mode)
            .put("ts", System.currentTimeMillis())
            .put("localOnly", localOnly)
            .put("personalContext", personalContext)
        try {
            store?.append(record)
        } catch (e: Exception) {
            // Do not claim delivery if private persistence failed; still let the user hear an explicit error.
            failAndStop("Could not save background reply")
            return
        }
        if (!localOnly) {
            addHistory(HistoryTurn("user", userText))
            addHistory(HistoryTurn("assistant", spoken))
        }
        emit(JSONObject().put("type", "reply").put("record", record))
        speakReply(spoken, token)
    }

    private fun speakReply(text: String, token: Long) {
        if (!active || token != generation.get()) return
        val c = config ?: return
        lastSpokenText = text
        destroyRecognizer() // never hear the service's own output
        setState("speaking")
        val voiceEngine = c.voiceEngine
        if (voiceEngine != "device") {
            val id = "tts-${UUID.randomUUID()}"
            ttsId = id
            val ttsRequest = JSONObject().put("tts", JSONObject()
                .put("text", text.take(MAX_TTS_CHARS))
                .put("voice", c.voiceName)
                .put("lang", c.lang))
            Engine.submit(id, ttsRequest.toString(), { _ -> }, foreground = false) { result, _ ->
                main.post {
                    if (!active || token != generation.get() || ttsId != id) return@post
                    ttsId = null
                    val path = result?.let { audioFile(it) }
                    if (!path.isNullOrBlank()) {
                        val outId = "out-${++outputToken}"
                        ttsId = outId
                        ttsKind = "natural"
                        speaker?.playFile(outId, path, c.rate)
                        scheduleOutputTimeout(token, outId)
                    } else {
                        speakNeuralOrDevice(text, token)
                    }
                }
            }
            main.postDelayed({
                if (active && token == generation.get() && ttsId == id) {
                    Engine.cancel(id)
                    ttsId = null
                    speakNeuralOrDevice(text, token)
                }
            }, TTS_TIMEOUT_MS)
        } else {
            speakDevice(text, token)
        }
    }

    private fun speakNeuralOrDevice(text: String, token: Long) {
        if (!active || token != generation.get()) return
        if (neural?.ready() == true) {
            val outId = "out-${++outputToken}"
            ttsId = outId
            ttsKind = "neural"
            neural?.speak(outId, text, config?.lang ?: "en-IN", config?.rate ?: 1f)
            scheduleOutputTimeout(token, outId)
        } else {
            speakDevice(text, token)
        }
    }

    private fun scheduleOutputTimeout(token: Long, outputId: String) {
        main.postDelayed({
            if (active && token == generation.get() && ttsId == outputId) {
                if (ttsKind == "natural") {
                    fallbackNeuralOrDevice(token, outputId)
                } else if (ttsKind == "neural") {
                    fallbackDevice(token, outputId)
                } else {
                    finishOutput(outputId, "timeout")
                }
            }
        }, TTS_TIMEOUT_MS)
    }

    private fun fallbackNeuralOrDevice(token: Long, oldId: String) {
        if (!active || token != generation.get() || ttsId != oldId) return
        ttsId = null
        speaker?.stopAll(silent = true)
        speakNeuralOrDevice(spokenTextFromLastReply(), token)
    }

    private fun fallbackDevice(token: Long, oldId: String) {
        if (!active || token != generation.get() || ttsId != oldId) return
        ttsId = null
        neural?.stop()
        speaker?.stopAll(silent = true)
        speakDevice(spokenTextFromLastReply(), token)
    }

    // The last spoken text is retained only for the active turn, never persisted separately.
    private var lastSpokenText = ""
    private fun spokenTextFromLastReply() = lastSpokenText

    private fun speakDevice(text: String, token: Long) {
        if (!active || token != generation.get()) return
        val c = config ?: return
        lastSpokenText = text
        val id = "out-${++outputToken}"
        ttsId = id
        ttsKind = "device"
        speaker?.wanted = c.deviceVoice.ifBlank { null }
        speaker?.speak(id, text, c.lang, c.rate)
        main.postDelayed({ if (active && token == generation.get() && ttsId == id) finishOutput(id, "timeout") }, TTS_TIMEOUT_MS)
    }

    private fun onOutputEvent(type: String, id: String) {
        if (!active || ttsId != id) return
        when (type) {
            "start" -> setState("speaking")
            "done", "error", "stopped" -> {
                if (type == "error" && ttsKind == "natural") {
                    fallbackNeuralOrDevice(generation.get(), id)
                } else if (type == "error" && ttsKind == "neural") {
                    fallbackDevice(generation.get(), id)
                } else finishOutput(id, type)
            }
        }
    }

    private fun finishOutput(id: String, outcome: String) {
        if (!active || ttsId != id) return
        ttsId = null
        ttsKind = ""
        if (outcome == "timeout") {
            speaker?.stopAll(silent = true)
            neural?.stop()
        }
        beginListening(generation.get(), 250L)
    }

    private fun audioFile(raw: String): String? = try {
        val t = raw.trim()
        val obj = if (t.startsWith("[")) JSONArray(t).optJSONObject(0) else JSONObject(t)
        if (obj?.optString("type") != "audio") null else obj.optString("file").takeIf { it.isNotBlank() }
    } catch (_: Exception) { null }

    private fun spokenText(value: Any): String = when (value) {
        is JSONObject -> value.optString("text").trim()
        is JSONArray -> (0 until value.length()).asSequence().mapNotNull { value.opt(it) }
            .map { spokenText(it) }.firstOrNull { it.isNotBlank() } ?: ""
        else -> ""
    }

    private fun historyJson(include: Boolean): JSONArray {
        val out = JSONArray()
        if (include) history.forEach { out.put(JSONObject().put("role", it.role).put("text", it.text)) }
        return out
    }

    private fun addHistory(turn: HistoryTurn) {
        history += HistoryTurn(turn.role, turn.text.take(HISTORY_TURN_CHARS))
        while (history.size > MAX_HISTORY_TURNS) history.removeAt(0)
        while (history.sumOf { it.text.length } > MAX_HISTORY_CHARS && history.isNotEmpty()) history.removeAt(0)
    }

    private fun destroyRecognizer() {
        recognizerToken++
        try { recognizer?.cancel() } catch (_: Exception) {}
        try { recognizer?.destroy() } catch (_: Exception) {}
        recognizer = null
    }

    private fun isRecognizerCurrent(token: Long) = active && token == recognizerToken && generation.get() > 0L

    private fun setState(next: String) {
        if (!active && next != "inactive") return
        state = next
        updateNotification()
        emitStatus()
    }

    private fun emitStatus() {
        val c = config
        emit(JSONObject().put("type", "status").put("ok", lastError.isBlank()).put("active", active).put("state", state)
            .put("message", if (lastError.isBlank()) stateMessage(state) else lastError)
            .put("chatId", c?.chatId ?: pendingChatId).put("mode", c?.mode ?: pendingMode)
            .put("error", lastError).put("ts", System.currentTimeMillis()))
    }

    private fun emit(payload: JSONObject) {
        // Parent-owned MainActivity forwards this to window.__adarshBackgroundVoice; notifications never contain transcripts.
        MainActivity.backgroundVoiceEvent(payload)
    }

    private fun updateNotification() {
        if (!active) return
        try {
            val nm = getSystemService(NotificationManager::class.java)
            val stop = PendingIntent.getService(this, 42, Intent(this, BackgroundVoiceService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val n = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Adarsh voice chat").setContentText(if (state == "speaking") "Speaking" else "Listening")
                .setOngoing(true).setOnlyAlertOnce(true).addAction(Notification.Action.Builder(null, "Stop", stop).build()).build()
            nm.notify(NOTIFICATION_ID, n)
        } catch (_: Exception) {}
    }

    private fun failAndStop(message: String) {
        if (cleaned) return
        lastError = message
        state = "error"
        emitStatus()
        stopSession("error")
    }

    private fun stopSession(reason: String) {
        if (cleaned) return
        cleaned = true
        active = false
        state = if (reason == "error") "error" else "stopped"
        generation.incrementAndGet()
        outputToken++
        main.removeCallbacksAndMessages(null)
        requestId?.let { Engine.cancel(it) }
        ttsId?.let { Engine.cancel(it) }
        requestId = null
        ttsId = null
        ttsKind = ""
        destroyRecognizer()
        try { speaker?.stopAll(silent = true) } catch (_: Exception) {}
        try { neural?.stop() } catch (_: Exception) {}
        wakeLock?.let { try { if (it.isHeld) it.release() } catch (_: Exception) {} }
        wakeLock = null
        emitStatus()
        WakeWordService.resume(this, "background_voice")
        try { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE) } catch (_: Exception) { try { stopForeground(true) } catch (_: Exception) {} }
        live = null
        standby = false
        if (pendingStartEpoch == sessionEpoch) pendingStartEpoch = 0L
        stopSelf()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (standby && !active) endStandby() else stopSession("task_removed")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        launchEpoch.incrementAndGet()
        stopSession("destroyed")
        try { speaker?.destroy() } catch (_: Exception) {}
        try { neural?.destroy() } catch (_: Exception) {}
        live = null
        super.onDestroy()
    }

    data class HistoryTurn(val role: String, val text: String)

    private data class SessionConfig(
        val chatId: String,
        val mode: String,
        val lang: String,
        val access: JSONObject,
        val localRead: Boolean,
        val localEdit: Boolean,
        val accessCurrentChat: Boolean,
        val history: List<HistoryTurn>,
        val reply: JSONObject,
        val voiceEngine: String,
        val voiceName: String,
        val deviceVoice: String,
        val rate: Float
    )

    companion object {
        private const val ACTION_START = "app.adarsh.ensemble.action.BACKGROUND_VOICE_START"
        private const val ACTION_STOP = "app.adarsh.ensemble.action.BACKGROUND_VOICE_STOP"
        private const val ACTION_PREPARE = "app.adarsh.ensemble.action.BACKGROUND_VOICE_PREPARE"
        private var standbyToken = 0L
        private const val EXTRA_CONFIG = "config_json"
        private const val EXTRA_LAUNCH_EPOCH = "launch_epoch"
        private const val CHANNEL = "background_voice"
        private const val NOTIFICATION_ID = 19
        private const val SESSION_LIMIT_MS = 30 * 60 * 1000L
        private const val CHAT_TIMEOUT_MS = 120 * 1000L
        private const val TTS_TIMEOUT_MS = 90 * 1000L
        private const val ACTION_TIMEOUT_MS = 8 * 1000L
        private const val MAX_TEXT_CHARS = 4000
        private const val MAX_TTS_CHARS = 1500
        private const val MAX_HISTORY_TURNS = 14
        private const val MAX_HISTORY_CHARS = 5000
        private const val HISTORY_TURN_CHARS = 700
        private const val MAX_LOCAL_STEPS = 3
        private const val MAX_RECOGNIZER_RETRIES = 3
        private const val MAX_NON_FATAL_RESTARTS = 1800
        private const val NON_FATAL_RETRY_DELAY_MS = 1200L
        private val FATAL_RETRY_DELAYS_MS = longArrayOf(800L, 1600L, 3200L)
        private val CONFIG_KEYS = setOf("chatId", "mode", "source", "lang", "access", "history", "reply", "voice")
        private val ACCESS_KEYS = setOf("localRead", "localEdit", "personalOnline", "oldChats", "currentChat", "architecture")
        private val REPLY_KEYS = setOf("lang", "depth", "think", "web", "philosophy")  // web: "on" / "off" (Settings > Built-in web search)
        private val VOICE_KEYS = setOf("engine", "name", "deviceVoice", "rate")
        private val VOICE_NAMES = setOf("Kore", "Orus", "Charon", "Sulafat", "Achird", "Iapetus", "Puck", "Aoede", "Gacrux", "Sadaltager")
        private val ALLOWED_MODES = setOf("standard", "verified", "physics", "math", "business", "coding", "v")
        @Volatile private var live: BackgroundVoiceService? = null
        private val launchEpoch = AtomicLong(0L)
        @Volatile private var pendingStartEpoch = 0L
        @Volatile private var pendingChatId = ""
        @Volatile private var pendingMode = ""

        private fun response(
            ok: Boolean, active: Boolean, state: String, message: String,
            error: String = "", chatId: String = "", mode: String = ""
        ) = JSONObject().put("ok", ok).put("active", active).put("state", state)
            .put("message", message).put("error", error).put("chatId", chatId).put("mode", mode)

        private fun stateMessage(state: String) = when (state) {
            "starting" -> "Background voice is starting"
            "listening", "hearing", "retrying" -> "Background voice is listening"
            "thinking" -> "Background voice is preparing a reply"
            "speaking" -> "Background voice is speaking"
            "stopping" -> "Background voice is stopping"
            "standby" -> "Background voice is ready"
            "stopped" -> "Background voice stopped"
            "error" -> "Background voice stopped with an error"
            else -> "Background voice is inactive"
        }

        /**
         * handoff = true: the live voice screen is moving to the background (Home, Recents, Back, screen off or
         * another app). The screen may already be pausing (still visible), and missing notification permission only
         * hides the ongoing notice (Android still lists the service in Task Manager), so neither blocks the session.
         */
        fun start(activity: MainActivity, configJson: String, handoff: Boolean = false): JSONObject {
            if (!activity.lifecycle.currentState.isAtLeast(if (handoff) Lifecycle.State.STARTED else Lifecycle.State.RESUMED)) {
                return response(false, false, "error", "Background voice start requires a resumed app screen", "Background voice start requires a resumed app screen")
            }
            if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                return response(false, false, "error", "Microphone permission is required", "Microphone permission is required")
            }
            val nm = activity.getSystemService(NotificationManager::class.java)
            if (!handoff && (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED || !nm.areNotificationsEnabled())) {
                return response(false, false, "error", "Enable notifications before starting background voice", "Enable notifications before starting background voice")
            }
            if (live?.active == true) {
                val current = live!!
                return response(false, true, current.state, "Background voice is already active", "Background voice is already active", current.config?.chatId ?: "", current.config?.mode ?: "")
            }
            val parsed = try { parseConfig(configJson) } catch (e: Exception) {
                val error = e.message ?: "Invalid background voice config"
                return response(false, false, "error", error, error)
            }
            if (pendingStartEpoch != 0L) {
                return response(true, false, "starting", "Background voice is already starting", "", pendingChatId, pendingMode)
            }
            val epoch = launchEpoch.incrementAndGet()
            pendingStartEpoch = epoch
            pendingChatId = parsed.chatId
            pendingMode = parsed.mode
            val ready = live
            if (ready != null && ready.standby && !ready.active) {
                // Already a foreground service since the voice screen opened: just start listening.
                ready.main.post { if (epoch == launchEpoch.get()) ready.beginSession(configJson, epoch) else if (pendingStartEpoch == epoch) pendingStartEpoch = 0L }
                return response(true, false, "starting", "Background voice is starting", "", parsed.chatId, parsed.mode)
            }
            val intent = Intent(activity, BackgroundVoiceService::class.java)
                .setAction(ACTION_START).putExtra(EXTRA_CONFIG, configJson).putExtra(EXTRA_LAUNCH_EPOCH, epoch)
            return try {
                ContextCompat.startForegroundService(activity, intent)
                response(true, false, "starting", "Background voice is starting", "", parsed.chatId, parsed.mode)
            } catch (e: Exception) {
                if (pendingStartEpoch == epoch) pendingStartEpoch = 0L
                val error = "Could not start background voice: ${e.message ?: e.javaClass.simpleName}"
                response(false, false, "error", error, error, parsed.chatId, parsed.mode)
            }
        }

        /**
         * Voice screen open (app visible): become a foreground service now, idle, so that leaving the app later only
         * has to start listening. Android 14 does not let a microphone service start once the app is in the background.
         */
        fun prepare(activity: MainActivity): Boolean {
            if (live?.active == true || live?.standby == true) return true
            if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return false
            if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
            return try {
                ContextCompat.startForegroundService(activity, Intent(activity, BackgroundVoiceService::class.java).setAction(ACTION_PREPARE))
                true
            } catch (_: Exception) { false }
        }

        /** Voice screen closed without leaving the app: drop the idle standby (a running session is untouched). */
        fun unprepare() {
            val s = live ?: return
            s.main.post { s.endStandby() }
        }

        fun stop(context: Context): JSONObject {
            launchEpoch.incrementAndGet()
            pendingStartEpoch = 0L
            val current = live
            val chatId = current?.config?.chatId ?: pendingChatId
            val mode = current?.config?.mode ?: pendingMode
            current?.let {
                if (Looper.myLooper() == Looper.getMainLooper()) it.stopSession("stopped")
                else it.main.post { it.stopSession("stopped") }
            }
            context.stopService(Intent(context, BackgroundVoiceService::class.java).setAction(ACTION_STOP))
            return response(true, false, "stopped", "Background voice stopped", "", chatId, mode)
        }

        fun status(): JSONObject = live?.let {
            response(it.lastError.isBlank(), it.active, it.state,
                if (it.lastError.isBlank()) stateMessage(it.state) else it.lastError,
                it.lastError, it.config?.chatId ?: "", it.config?.mode ?: "")
        } ?: if (pendingStartEpoch != 0L) {
            response(true, false, "starting", "Background voice is starting", "", pendingChatId, pendingMode)
        } else {
            response(true, false, "inactive", "Background voice is inactive")
        }

        fun peek(context: Context): JSONArray = try { BackgroundVoiceStore(context).peek() } catch (_: Exception) { JSONArray() }

        fun ack(context: Context, ids: JSONArray): JSONObject = try { BackgroundVoiceStore(context).ack(ids) } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName)
        }

        private fun parseConfig(json: String): SessionConfig {
            val raw = JSONObject(json)
            for (key in raw.keys()) require(key in CONFIG_KEYS) { "Unsupported background voice config field '$key'" }
            val source = raw.optString("source", "")
            require(source == "auto") { "Background voice requires source=auto; original source '$source' was not changed" }
            val mode = raw.optString("mode", "").trim()
            require(mode in ALLOWED_MODES) { "Background voice requires an existing selected mode" }
            val chatId = raw.optString("chatId", "background").trim()
            require(chatId.isNotBlank() && chatId.length <= 200) { "chatId must be a non-empty bounded string" }
            val lang = raw.optString("lang", "en-IN").trim().ifBlank { "en-IN" }
            require(lang.length <= 32) { "lang is too long" }

            val access = raw.optJSONObject("access") ?: JSONObject()
            for (key in access.keys()) require(key in ACCESS_KEYS) { "Unsupported access field '$key'" }
            val normalizedAccess = JSONObject()
            ACCESS_KEYS.forEach { key ->
                val value = if (access.has(key)) access.opt(key) else false
                require(value is Boolean) { "access.$key must be boolean" }
                normalizedAccess.put(key, value)
            }
            val history = mutableListOf<HistoryTurn>()
            val historyInput = raw.optJSONArray("history") ?: JSONArray()
            for (i in 0 until historyInput.length().coerceAtMost(MAX_HISTORY_TURNS)) {
                val h = historyInput.optJSONObject(i) ?: continue
                val role = h.optString("role")
                val text = h.optString("text").trim()
                if (role in setOf("user", "assistant") && text.isNotBlank()) history += HistoryTurn(role, text.take(HISTORY_TURN_CHARS))
            }
            while (history.sumOf { it.text.length } > MAX_HISTORY_CHARS && history.isNotEmpty()) history.removeAt(0)

            val reply = raw.optJSONObject("reply") ?: JSONObject()
            for (key in reply.keys()) require(key in REPLY_KEYS) { "Unsupported reply field '$key'" }
            val normalizedReply = JSONObject()
            reply.keys().forEach { key ->
                val value = reply.opt(key)
                require(value is String) { "reply.$key must be a string" }
                normalizedReply.put(key, value)
            }
            val voice = raw.optJSONObject("voice") ?: JSONObject()
            for (key in voice.keys()) require(key in VOICE_KEYS) { "Unsupported voice field '$key'" }
            val voiceEngine = voice.optString("engine", "auto")
            require(voiceEngine in setOf("auto", "natural", "device")) { "voice.engine must be auto, natural, or device" }
            val voiceName = voice.optString("name", "Orus")
            require(voiceName in VOICE_NAMES) { "Unsupported natural voice name" }
            val deviceVoice = voice.optString("deviceVoice", "").take(200)
            val rateValue = voice.opt("rate")
            val rate = when (rateValue) {
                null, JSONObject.NULL -> 1f
                is Number -> rateValue.toFloat().coerceIn(0.5f, 2f)
                else -> throw IllegalArgumentException("voice.rate must be a number")
            }
            return SessionConfig(chatId, mode, lang, normalizedAccess,
                normalizedAccess.optBoolean("localRead"), normalizedAccess.optBoolean("localEdit"),
                normalizedAccess.optBoolean("currentChat"), history, normalizedReply,
                voiceEngine, voiceName, deviceVoice, rate)
        }
    }
}
