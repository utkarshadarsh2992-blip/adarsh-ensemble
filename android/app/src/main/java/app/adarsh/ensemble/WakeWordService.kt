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
import java.util.Locale

/**
 * Explicitly enabled, strictly on-device wake phrase standby. It never uses the generic SpeechRecognizer
 * factory and never sends recognized text to the page, engine, or a provider. The recognizer is destroyed
 * before any conversation starts. START_NOT_STICKY and the absence of boot receivers prevent auto-restart.
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
    private val pauseReasons = linkedSetOf<String>()
    private var restart: Runnable? = null
    private var wakeExpiry: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        live = this
        createChannel()
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
        if (Build.VERSION.SDK_INT < 31) {
            failAndStop("unsupported", "On-device wake recognition requires Android 12 or later")
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
        state = "starting"
        message = "Starting on-device wake-word standby"
        try {
            startForegroundNow()
        } catch (_: Throwable) {
            failAndStop("error", "Could not start the wake-word microphone notification")
            return
        }
        enabled = true
        failures = 0
        if (!onDeviceRecognizerAvailable(this)) {
            failAndStop("unsupported", "This device has no Android on-device speech recognizer. No online fallback was used.")
            return
        }
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

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Wake word standby", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Visible microphone notice for on-device Hey Adarsh standby"
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

    private fun buildNotification(): Notification {
        val stop = PendingIntent.getService(
            this,
            801,
            Intent(this, WakeWordService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val open = PendingIntent.getActivity(
            this,
            802,
            Intent(this, MainActivity::class.java)
                .setAction(ACTION_OPEN_WAKE)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val text = when (state) {
            "listening", "starting" -> "On-device only · say “Hey Adarsh” · tap Stop to disable"
            "triggered" -> "“Hey Adarsh” heard · tap to open Google Live"
            "paused" -> "Microphone detection paused while voice audio is active"
            else -> message.ifBlank { "Wake word standby" }
        }
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Adarsh wake word")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text + ". Ambient speech is not sent to a provider."))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    private fun listenAgain(delayMs: Long) {
        if (!enabled || !foreground || pauseReasons.isNotEmpty()) return
        cancelRestart()
        val task = Runnable {
            if (!enabled || !foreground || pauseReasons.isNotEmpty()) return@Runnable
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                failAndStop("permission_required", "Microphone permission was revoked")
                return@Runnable
            }
            if (!onDeviceRecognizerAvailable(this)) {
                failAndStop("unsupported", "The on-device speech recognizer is no longer available")
                return@Runnable
            }
            destroyRecognizer()
            val current = try {
                SpeechRecognizer.createOnDeviceSpeechRecognizer(this)
            } catch (_: Throwable) {
                failAndStop("unsupported", "Could not create the on-device recognizer; no online fallback was used")
                return@Runnable
            }
            val token = ++recognizerEpoch
            recognizer = current
            try {
                current.setRecognitionListener(listener(token))
                val request = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE, WAKE_LOCALE)
                    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                    .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                    .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                current.startListening(request)
                setState("listening", "On-device listening for Hey Adarsh")
            } catch (_: Throwable) {
                destroyRecognizer()
                retryOrStop("Could not start on-device speech recognition")
            }
        }
        restart = task
        main.postDelayed(task, delayMs)
    }

    private fun listener(token: Long) = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            if (isCurrent(token)) setState("listening", "On-device listening for Hey Adarsh")
        }
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
        override fun onPartialResults(partialResults: Bundle?) = Unit

        override fun onResults(results: Bundle?) {
            if (!isCurrent(token)) return
            val transcript = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
            destroyRecognizer()
            failures = 0
            if (WakeWordMatcher.matches(transcript)) {
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
                SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
                    failAndStop("unsupported", "The device has no offline speech model for $WAKE_LOCALE")
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> {
                    failures = 0
                    listenAgain(RESTART_AFTER_TIMEOUT_MS)
                }
                else -> retryOrStop("On-device recognizer error ($error)")
            }
        }
    }

    private fun onWakeWord() {
        if (!enabled) return
        pauseReasons.add(REASON_WAKE)
        cancelRestart()
        destroyRecognizer() // release the detector microphone before opening any conversation
        setState("triggered", "Hey Adarsh heard · tap to open Google Live")
        cancelWakeExpiry()
        val expiry = Runnable {
            wakeExpiry = null
            if (enabled && pauseReasons.remove(REASON_WAKE) && pauseReasons.isEmpty()) listenAgain(0L)
        }
        wakeExpiry = expiry
        main.postDelayed(expiry, WAKE_HOLD_MS)
        MainActivity.wakeWordEvent(JSONObject().put("type", "wake"))
    }

    private fun retryOrStop(why: String) {
        failures++
        if (failures >= MAX_FAILURES) {
            failAndStop("error", "$why. Wake-word standby stopped; no online fallback was used.")
        } else {
            setState("retrying", "$why; retrying the on-device recognizer")
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
        if (reason == REASON_WAKE) cancelWakeExpiry()
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
        .put("supported", onDeviceRecognizerAvailable(this))
        .put("onDevice", true)
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
        private const val NOTIFICATION_ID = 61
        private const val PHRASE = "Hey Adarsh"
        private const val WAKE_LOCALE = "en-IN"
        private const val REASON_WAKE = "wake"
        private const val RESTART_AFTER_RESULT_MS = 350L
        private const val RESTART_AFTER_TIMEOUT_MS = 450L
        private const val RESTART_AFTER_PAUSE_MS = 250L
        private const val RETRY_DELAY_MS = 1_500L
        private const val WAKE_HOLD_MS = 60_000L
        private const val MAX_FAILURES = 3
        @Volatile private var live: WakeWordService? = null
        @Volatile private var requested = false
        @Volatile private var lastStatus = JSONObject()
            .put("ok", true).put("enabled", false).put("active", false).put("supported", false)
            .put("onDevice", true).put("phrase", PHRASE).put("state", "off").put("message", "Wake word is off")

        private fun onDeviceRecognizerAvailable(context: Context): Boolean = try {
            Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        } catch (_: Throwable) { false }

        fun enable(context: Context): JSONObject {
            if (Build.VERSION.SDK_INT < 31 || !onDeviceRecognizerAvailable(context)) {
                requested = false
                lastStatus = JSONObject().put("ok", false).put("enabled", false).put("active", false)
                    .put("supported", false).put("onDevice", true).put("phrase", PHRASE)
                    .put("state", "unsupported")
                    .put("message", if (Build.VERSION.SDK_INT < 31) "On-device wake recognition requires Android 12 or later" else "This device has no Android on-device speech recognizer; no online fallback was used")
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
                .put("supported", true).put("onDevice", true).put("phrase", PHRASE)
                .put("state", "starting").put("message", "Starting on-device wake-word standby")
            return try {
                ContextCompat.startForegroundService(context, Intent(context, WakeWordService::class.java).setAction(ACTION_ENABLE))
                JSONObject(lastStatus.toString())
            } catch (_: Throwable) {
                requested = false
                lastStatus = JSONObject().put("ok", false).put("enabled", false).put("active", false)
                    .put("supported", true).put("onDevice", true).put("phrase", PHRASE)
                    .put("state", "error").put("message", "Android could not start the microphone foreground service")
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
                lastStatus = JSONObject().put("ok", true).put("enabled", false).put("active", false)
                    .put("supported", onDeviceRecognizerAvailable(context)).put("onDevice", true)
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
            result.put("supported", onDeviceRecognizerAvailable(context))
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
