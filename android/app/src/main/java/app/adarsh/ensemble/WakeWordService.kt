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
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Explicitly enabled "Hey Adarsh" standby. The Android on-device recognizer is preferred; when the phone has no
 * on-device recognizer (common on Oppo/Realme/Vivo builds) or no offline model for any wake locale, the phone's
 * default speech service is used with EXTRA_PREFER_OFFLINE, and Settings states that engine plainly.
 * Recognized text is only matched locally and is never sent to the page, engine, or a provider.
 * The recognizer is destroyed before any conversation starts. START_NOT_STICKY and the absence of boot receivers
 * prevent auto-restart.
 */
class WakeWordService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var enabled = false
    private var foreground = false
    private var state = "off"
    private var message = "Wake word is off"
    private var recognizerEpoch = 0L
    private var failures = 0
    private var engine = ENGINE_ON_DEVICE
    private var localeIndex = 0
    private var modelDownloadRequested = false
    private var preferOffline = true
    private val pauseReasons = linkedSetOf<String>()
    private var restart: Runnable? = null
    private var wakeExpiry: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        live = this
        createChannels()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopStandby("off", "Wake word disabled")
            ACTION_ENABLE -> startStandby()
            ACTION_OPEN_WAKE -> MainActivity.deliverPendingWakeWordOpen()
            else -> stopStandby("off", "Wake word is off")
        }
        return START_NOT_STICKY
    }

    private fun startStandby() {
        if (enabled && foreground) {
            if (pauseReasons.isEmpty() && recognizer == null) listenAgain(0L)
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            failAndStop("permission_required", "Microphone permission is required")
            return
        }
        if (!notificationPermissionGranted() || !notificationsEnabled()) {
            failAndStop("notification_required", "Enable notifications to show the microphone standby control")
            return
        }
        val chosen = preferredEngine(this)
        if (chosen == null) {
            failAndStop("unsupported", "Is phone par koi speech recognizer nahi mila. Google app / Speech Services install ya enable karo.")
            return
        }
        engine = chosen
        localeIndex = 0
        preferOffline = true
        state = "starting"
        message = "Starting wake-word standby"
        try {
            startForegroundNow()
        } catch (_: Throwable) {
            failAndStop("error", "Could not start the wake-word microphone notification")
            return
        }
        enabled = true
        failures = 0
        if (pauseReasons.isNotEmpty()) {
            setState("paused", "Wake word paused while voice audio is active")
        } else {
            listenAgain(0L)
        }
    }

    private fun startForegroundNow() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        foreground = true
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Wake word standby", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Visible microphone notice for Hey Adarsh standby"
                }
            )
            nm.createNotificationChannel(
                NotificationChannel(ALERT_CHANNEL_ID, "Hey Adarsh heard", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Opens Adarsh voice after the wake phrase is heard"
                    setSound(null, null)
                    enableVibration(true)
                }
            )
        }
    }

    private fun notificationPermissionGranted(): Boolean =
        Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun notificationsEnabled(): Boolean {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager == null || !manager.areNotificationsEnabled()) return false
        return Build.VERSION.SDK_INT < 26 || manager.getNotificationChannel(CHANNEL_ID)?.importance != NotificationManager.IMPORTANCE_NONE
    }

    private fun openWakeIntent(requestCode: Int): PendingIntent = PendingIntent.getActivity(
        this,
        requestCode,
        Intent(this, MainActivity::class.java)
            .setAction(ACTION_OPEN_WAKE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    private fun buildNotification(): Notification {
        val stop = PendingIntent.getService(
            this,
            801,
            Intent(this, WakeWordService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val text = when (state) {
            "listening", "starting" -> "“Hey Adarsh” bolo · " + engineLabel() + " · Stop se band"
            "triggered" -> "“Hey Adarsh” suna · tap karke bolo"
            "paused" -> "Voice chal rahi hai, wake word ruka hua hai"
            else -> message.ifBlank { "Wake word standby" }
        }
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Adarsh wake word")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text + ". Sirf wake phrase phone par match hota hai; baaki baat kahin nahi bheji jaati."))
            .setContentIntent(openWakeIntent(802))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    private fun engineLabel(): String =
        if (engine == ENGINE_ON_DEVICE) "on-device" else "phone speech service"

    private fun currentLocale(): String? = WAKE_LOCALES.getOrNull(localeIndex)

    private fun listenAgain(delayMs: Long) {
        if (!enabled || !foreground || pauseReasons.isNotEmpty()) return
        cancelRestart()
        val task = Runnable {
            if (!enabled || !foreground || pauseReasons.isNotEmpty()) return@Runnable
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                failAndStop("permission_required", "Microphone permission was revoked")
                return@Runnable
            }
            if (engine == ENGINE_ON_DEVICE && !onDeviceRecognizerAvailable(this)) engine = ENGINE_SYSTEM
            if (engine == ENGINE_SYSTEM && !systemRecognizerAvailable(this)) {
                failAndStop("unsupported", "Speech recognizer ab available nahi hai")
                return@Runnable
            }
            destroyRecognizer()
            val current = try {
                if (engine == ENGINE_ON_DEVICE && Build.VERSION.SDK_INT >= 31) {
                    SpeechRecognizer.createOnDeviceSpeechRecognizer(this)
                } else {
                    SpeechRecognizer.createSpeechRecognizer(this)
                }
            } catch (_: Throwable) {
                if (engine == ENGINE_ON_DEVICE && systemRecognizerAvailable(this)) {
                    switchToSystem()
                } else {
                    failAndStop("unsupported", "Could not create a speech recognizer")
                }
                return@Runnable
            }
            val token = ++recognizerEpoch
            recognizer = current
            try {
                current.setRecognitionListener(listener(token))
                current.startListening(recognizeIntent())
                setState("listening", "Listening for Hey Adarsh · " + engineLabel())
            } catch (_: Throwable) {
                destroyRecognizer()
                retryOrStop("Could not start speech recognition")
            }
        }
        restart = task
        main.postDelayed(task, delayMs)
    }

    private fun recognizeIntent(): Intent {
        val request = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2_500L)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2_500L)
        currentLocale()?.let { request.putExtra(RecognizerIntent.EXTRA_LANGUAGE, it) }
        return request
    }

    private fun listener(token: Long) = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            if (isCurrent(token)) {
                failures = 0
                setState("listening", "Listening for Hey Adarsh · " + engineLabel())
            }
        }
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
        override fun onPartialResults(partialResults: Bundle?) {
            if (!isCurrent(token)) return
            val partial = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            if (WakeWordMatcher.matchesAny(partial)) {
                destroyRecognizer()
                failures = 0
                onWakeWord()
            }
        }
        override fun onResults(results: Bundle?) {
            if (!isCurrent(token)) return
            val transcript = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            destroyRecognizer()
            failures = 0
            if (WakeWordMatcher.matchesAny(transcript)) {
                onWakeWord()
            } else {
                listenAgain(RESTART_AFTER_RESULT_MS)
            }
        }
        override fun onError(error: Int) {
            if (!isCurrent(token)) return
            destroyRecognizer()
            when (error) {
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
                    failAndStop("permission_required", "Microphone permission was revoked")
                SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
                SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> languageUnavailable()
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> {
                    failures = 0
                    listenAgain(RESTART_AFTER_TIMEOUT_MS)
                }
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
                SpeechRecognizer.ERROR_CLIENT -> {
                    // Another app/screen holds the recognizer or a cancelled session settled late.
                    failures++
                    if (failures >= MAX_FAILURES) retryOrStop("Speech recognizer busy ($error)")
                    else listenAgain(BUSY_RETRY_MS)
                }
                else -> retryOrStop("Recognizer error ($error)")
            }
        }
    }

    /** No model for this locale: ask for the model once, try the next locale, then the phone speech service. */
    private fun languageUnavailable() {
        if (engine == ENGINE_ON_DEVICE && !modelDownloadRequested && Build.VERSION.SDK_INT >= 33) {
            modelDownloadRequested = true
            try {
                val r = SpeechRecognizer.createOnDeviceSpeechRecognizer(this)
                r.triggerModelDownload(recognizeIntent())
                main.postDelayed({ try { r.destroy() } catch (_: Throwable) {} }, 5_000L)
            } catch (_: Throwable) {}
        }
        if (localeIndex + 1 < WAKE_LOCALES.size) {
            localeIndex++
            listenAgain(RESTART_AFTER_TIMEOUT_MS)
            return
        }
        if (engine == ENGINE_ON_DEVICE && systemRecognizerAvailable(this)) {
            switchToSystem()
            return
        }
        if (engine == ENGINE_SYSTEM && preferOffline) {
            // No offline pack on the phone speech service: let it use its normal (online) model.
            preferOffline = false
            localeIndex = 0
            setState("retrying", "Offline speech model nahi mila · phone speech service online model use karega")
            listenAgain(RESTART_AFTER_TIMEOUT_MS)
            return
        }
        failAndStop("unsupported", "Is phone par wake phrase ke liye speech model nahi mila")
    }

    private fun switchToSystem() {
        engine = ENGINE_SYSTEM
        localeIndex = 0
        preferOffline = true
        failures = 0
        setState("retrying", "On-device model nahi mila · phone speech service par switch")
        listenAgain(RESTART_AFTER_TIMEOUT_MS)
    }

    private fun onWakeWord() {
        if (!enabled) return
        pauseReasons.add(REASON_WAKE)
        cancelRestart()
        destroyRecognizer() // release the detector microphone before opening any conversation
        setState("triggered", "Hey Adarsh suna · voice khul rahi hai")
        cancelWakeExpiry()
        val expiry = Runnable {
            wakeExpiry = null
            clearWakeAlert(this)
            if (enabled && pauseReasons.remove(REASON_WAKE) && pauseReasons.isEmpty()) listenAgain(0L)
        }
        wakeExpiry = expiry
        main.postDelayed(expiry, WAKE_HOLD_MS)
        if (MainActivity.isOnScreen()) {
            MainActivity.wakeWordEvent(JSONObject().put("type", "wake"))
        } else {
            bringAppForward()
        }
    }

    /**
     * App is in the background or closed: Android blocks most background Activity starts, so a high-priority
     * notification with a full-screen intent opens voice (screen off/locked) or shows a heads-up tap card.
     * A direct start is also attempted; it succeeds where Android allows it (e.g. display-over-apps granted).
     */
    private fun bringAppForward() {
        val open = openWakeIntent(803)
        try {
            val builder = Notification.Builder(this, ALERT_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Hey Adarsh suna")
                .setContentText("Tap karo · Adarsh voice khulegi")
                .setCategory(Notification.CATEGORY_CALL)
                .setContentIntent(open)
                .setAutoCancel(true)
                .setTimeoutAfter(WAKE_HOLD_MS)
                .setFullScreenIntent(open, true)
            getSystemService(NotificationManager::class.java).notify(ALERT_ID, builder.build())
        } catch (_: Throwable) {}
        try {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .setAction(ACTION_OPEN_WAKE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            )
        } catch (_: Throwable) {}
    }

    private fun retryOrStop(why: String) {
        failures++
        if (failures >= MAX_FAILURES) {
            if (engine == ENGINE_ON_DEVICE && systemRecognizerAvailable(this)) {
                switchToSystem()
                return
            }
            failAndStop("error", "$why. Wake-word standby ruk gaya; Settings se dobara on karo.")
        } else {
            setState("retrying", "$why; dobara koshish")
            listenAgain(RETRY_DELAY_MS)
        }
    }

    private fun isCurrent(token: Long): Boolean =
        enabled && foreground && pauseReasons.isEmpty() && token == recognizerEpoch && recognizer != null

    private fun destroyRecognizer() {
        recognizerEpoch++
        val old = recognizer
        recognizer = null
        try { old?.cancel() } catch (_: Throwable) {}
        try { old?.destroy() } catch (_: Throwable) {}
    }

    private fun cancelRestart() {
        restart?.let { main.removeCallbacks(it) }
        restart = null
    }

    private fun cancelWakeExpiry() {
        wakeExpiry?.let { main.removeCallbacks(it) }
        wakeExpiry = null
    }

    private fun pauseFor(reason: String) {
        if (!enabled || reason.isBlank()) return
        if (pauseReasons.add(reason)) {
            cancelRestart()
            destroyRecognizer()
            setState("paused", "Wake-word detection paused while voice audio is active")
        }
    }

    private fun resumeFor(reason: String) {
        if (reason.isBlank() || !pauseReasons.remove(reason)) return
        if (reason == REASON_WAKE) {
            cancelWakeExpiry()
            clearWakeAlert(this)
        }
        if (enabled && pauseReasons.isEmpty()) listenAgain(RESTART_AFTER_PAUSE_MS)
        else if (enabled) setState("paused", "Wake-word detection paused while voice audio is active")
    }

    private fun stopStandby(next: String, why: String) {
        requested = false
        enabled = false
        cancelRestart()
        cancelWakeExpiry()
        main.removeCallbacksAndMessages(null)
        destroyRecognizer()
        pauseReasons.clear()
        clearWakeAlert(this)
        state = next
        message = why
        publish()
        if (foreground) {
            try { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE) }
            catch (_: Throwable) { try { stopForeground(true) } catch (_: Throwable) {} }
        }
        foreground = false
        stopSelf()
    }

    private fun failAndStop(next: String, why: String) {
        requested = false
        enabled = false
        cancelRestart()
        cancelWakeExpiry()
        destroyRecognizer()
        pauseReasons.clear()
        state = next
        message = why
        publish()
        if (foreground) {
            try { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE) }
            catch (_: Throwable) { try { stopForeground(true) } catch (_: Throwable) {} }
        }
        foreground = false
        stopSelf()
    }

    private fun setState(next: String, why: String) {
        state = next
        message = why
        if (foreground) {
            try { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification()) }
            catch (_: Throwable) {}
        }
        publish()
    }

    private fun publish() {
        val json = snapshot()
        lastStatus = JSONObject(json.toString())
        MainActivity.wakeWordEvent(json.put("type", "status"))
    }

    private fun snapshot() = JSONObject()
        .put("ok", state !in setOf("error", "unsupported", "permission_required", "notification_required"))
        .put("enabled", enabled || requested)
        .put("active", foreground)
        .put("supported", preferredEngine(this) != null)
        .put("onDevice", engine == ENGINE_ON_DEVICE)
        .put("engine", engine)
        .put("phrase", PHRASE)
        .put("state", state)
        .put("message", message)

    override fun onDestroy() {
        cancelRestart()
        cancelWakeExpiry()
        destroyRecognizer()
        enabled = false
        foreground = false
        if (live === this) live = null
        if (requested) {
            requested = false
            if (state !in setOf("unsupported", "permission_required", "notification_required", "error")) {
                state = "stopped"
                message = "Wake-word service stopped; enable it again from Settings"
                lastStatus = snapshot()
            }
        }
        super.onDestroy()
    }

    companion object {
        const val ACTION_OPEN_WAKE = "app.adarsh.ensemble.action.OPEN_WAKE_WORD"
        private const val ACTION_ENABLE = "app.adarsh.ensemble.action.ENABLE_WAKE_WORD"
        private const val ACTION_STOP = "app.adarsh.ensemble.action.STOP_WAKE_WORD"
        private const val CHANNEL_ID = "wake_word_standby"
        private const val ALERT_CHANNEL_ID = "wake_word_alert"
        private const val NOTIFICATION_ID = 61
        private const val ALERT_ID = 62
        private const val PHRASE = "Hey Adarsh"
        const val ENGINE_ON_DEVICE = "on_device"
        const val ENGINE_SYSTEM = "system"
        /** null = the recognizer's own default language. */
        private val WAKE_LOCALES = listOf("en-IN", "en-US", "hi-IN", null)
        private const val REASON_WAKE = "wake"
        private const val RESTART_AFTER_RESULT_MS = 250L
        private const val RESTART_AFTER_TIMEOUT_MS = 300L
        private const val RESTART_AFTER_PAUSE_MS = 250L
        private const val BUSY_RETRY_MS = 900L
        private const val RETRY_DELAY_MS = 1_500L
        private const val WAKE_HOLD_MS = 60_000L
        private const val MAX_FAILURES = 5

        @Volatile private var live: WakeWordService? = null
        @Volatile private var requested = false
        @Volatile private var lastStatus = JSONObject()
            .put("ok", true).put("enabled", false).put("active", false).put("supported", false)
            .put("onDevice", true).put("engine", ENGINE_ON_DEVICE).put("phrase", PHRASE)
            .put("state", "off").put("message", "Wake word is off")

        private fun onDeviceRecognizerAvailable(context: Context): Boolean = try {
            Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        } catch (_: Throwable) { false }

        private fun systemRecognizerAvailable(context: Context): Boolean = try {
            SpeechRecognizer.isRecognitionAvailable(context)
        } catch (_: Throwable) { false }

        /** On-device first; otherwise the phone's default speech service (offline preferred). */
        private fun preferredEngine(context: Context): String? = when {
            onDeviceRecognizerAvailable(context) -> ENGINE_ON_DEVICE
            systemRecognizerAvailable(context) -> ENGINE_SYSTEM
            else -> null
        }

        fun supported(context: Context): Boolean = preferredEngine(context) != null

        fun clearWakeAlert(context: Context) {
            try { context.getSystemService(NotificationManager::class.java)?.cancel(ALERT_ID) } catch (_: Throwable) {}
        }

        fun enable(context: Context): JSONObject {
            val chosen = preferredEngine(context)
            if (chosen == null) {
                requested = false
                lastStatus = JSONObject().put("ok", false).put("enabled", false).put("active", false)
                    .put("supported", false).put("onDevice", false).put("engine", "none").put("phrase", PHRASE)
                    .put("state", "unsupported")
                    .put("message", "Is phone par koi speech recognizer nahi mila. Google app / Speech Services install ya enable karo.")
                return JSONObject(lastStatus.toString())
            }
            requested = true
            val service = live
            if (service != null) {
                if (Looper.myLooper() == Looper.getMainLooper()) service.startStandby()
                else service.main.post { service.startStandby() }
                return service.snapshot()
            }
            lastStatus = JSONObject().put("ok", true).put("enabled", true).put("active", false)
                .put("supported", true).put("onDevice", chosen == ENGINE_ON_DEVICE).put("engine", chosen)
                .put("phrase", PHRASE).put("state", "starting").put("message", "Starting wake-word standby")
            return try {
                ContextCompat.startForegroundService(context, Intent(context, WakeWordService::class.java).setAction(ACTION_ENABLE))
                JSONObject(lastStatus.toString())
            } catch (_: Throwable) {
                requested = false
                lastStatus = JSONObject().put("ok", false).put("enabled", false).put("active", false)
                    .put("supported", true).put("onDevice", chosen == ENGINE_ON_DEVICE).put("engine", chosen)
                    .put("phrase", PHRASE).put("state", "error")
                    .put("message", "Android could not start the microphone foreground service")
                JSONObject(lastStatus.toString())
            }
        }

        fun disable(context: Context): JSONObject {
            requested = false
            val service = live
            if (service != null) {
                if (Looper.myLooper() == Looper.getMainLooper()) service.stopStandby("off", "Wake word disabled")
                else service.main.post { service.stopStandby("off", "Wake word disabled") }
            } else {
                clearWakeAlert(context)
                lastStatus = JSONObject().put("ok", true).put("enabled", false).put("active", false)
                    .put("supported", supported(context)).put("onDevice", onDeviceRecognizerAvailable(context))
                    .put("engine", preferredEngine(context) ?: "none")
                    .put("phrase", PHRASE).put("state", "off").put("message", "Wake word is off")
            }
            return status(context)
        }

        fun status(context: Context): JSONObject {
            val service = live
            if (service != null) return service.snapshot()
            val result = JSONObject(lastStatus.toString())
            // A process/service restart never auto-starts the microphone; the next explicit status is off.
            if (!requested && result.optBoolean("enabled")) {
                result.put("enabled", false).put("active", false).put("state", "stopped")
            }
            result.put("supported", supported(context))
            return result
        }

        fun pause(context: Context, reason: String) {
            val safe = reason.take(80)
            if (safe.isBlank()) return
            live?.let { service ->
                if (Looper.myLooper() == Looper.getMainLooper()) service.pauseFor(safe)
                else service.main.post { service.pauseFor(safe) }
            }
        }

        fun resume(context: Context, reason: String) {
            val safe = reason.take(80)
            if (safe.isBlank()) return
            live?.let { service ->
                if (Looper.myLooper() == Looper.getMainLooper()) service.resumeFor(safe)
                else service.main.post { service.resumeFor(safe) }
            }
        }
    }
}
