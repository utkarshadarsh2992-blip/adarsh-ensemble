package app.adarsh.ensemble

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.content.ContentValues
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.provider.MediaStore
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Base64
import android.util.Size
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var loading: View
    private lateinit var error: View
    @Volatile private var destroyed = false

    private val notifPermission = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission()
    ) { ok ->
        val wakeToken = pendingWakeWordNotificationToken
        if (wakeToken >= 0) {
            pendingWakeWordNotificationToken = -1
            if (wakeToken == wakeWordGeneration) {
                if (ok) startWakeWordAfterPermission(wakeToken)
                else publishWakeWordPermissionError("notification_required", "Enable notifications before turning on wake word")
                return@registerForActivityResult
            }
        }
        val pending = pendingBackground
        if (pending != null && pending.token == backgroundNotificationToken) {
            backgroundPermissionResult(pending.token, ok, "Notification permission is required. Enable app notifications and tap Start again.")
        }
    }

    private var micCallback: ((Boolean) -> Unit)? = null
    private val micPermission = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission()
    ) { ok -> val cb = micCallback; micCallback = null; cb?.invoke(ok) }
    @Volatile private var liveCameraGeneration = 0
    private var pendingLiveCameraToken: Int? = null
    private var grantedLiveCameraToken: Int? = null
    private val liveCameraPermission = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission()
    ) { granted ->
        val token = pendingLiveCameraToken
        pendingLiveCameraToken = null
        if (token == null || token != liveCameraGeneration) return@registerForActivityResult
        if (!granted) {
            liveCameraEvent("error", "Camera permission nahi mili. Live voice chalu rahegi.")
        } else if (!destroyed && pageTrusted && live?.canReceiveVideo() == true) {
            if (resumed) startLiveCameraNow(token) else grantedLiveCameraToken = token
        } else {
            liveCameraEvent("off", "Live session band ho chuka hai; camera start nahi hua.")
        }
    }
    private val dictation by lazy { Dictation(this) }
    private var speaker: Speaker? = null
    private var neural: VoiceManager? = null
    @Volatile private var live: AdarshLive? = null
    private var pendingLive: JSONObject? = null
    private var updater: UpdateManager? = null
    private var actions: ActionRunner? = null
    @Volatile private var resumed = false
    private var backgroundGeneration = 0
    private data class PendingBackground(val token: Int, val json: String)
    private var pendingBackground: PendingBackground? = null
    private var backgroundAwaitingPermission = false
    private var backgroundNotificationToken = -1
    private var wakeWordGeneration = 0
    private var pendingWakeWordPermission = -1
    private var pendingWakeWordNotificationToken = -1
    private var dictationWakePaused = false
    // Live voice handoff: while the in-app voice screen is open in Standard mode the page keeps a ready
    // session config here. Back/Home starts the 30-minute background session while this screen is still
    // resumed, which Android requires for a microphone foreground service.
    @Volatile private var handoffConfig: String? = null
    private var handoffNotifAsked = false
    // True while one of our own system screens (permission dialog, file picker, save dialog) is in front.
    @Volatile private var awaitingResult = false
    // <input type=file> (Import data, attachments): the WebView needs a chooser from the app, or the tap does nothing.
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraFile: File? = null
    @Volatile private var liveCameraActive = false
    private var liveCameraPreviewView: PreviewView? = null
    private var liveCameraProvider: ProcessCameraProvider? = null
    private var liveCameraPreviewUseCase: Preview? = null
    private var liveCameraAnalysisUseCase: ImageAnalysis? = null
    private var liveCameraExecutor: ExecutorService? = null
    private val lastLiveCameraFrameAt = AtomicLong(0L)
    private val cameraCapture = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
    ) { resultCode ->
        val cb = fileCallback; fileCallback = null
        val source = cameraFile; cameraFile = null
        awaitingResult = false
        val saved = resultCode.resultCode == RESULT_OK
        val result = if (saved && source != null && source.isFile && source.length() > 0L) compressCameraPhoto(source) else null
        val uri = try { result?.let { FileProvider.getUriForFile(this, "$packageName.updates", it) } } catch (_: Exception) { null }
        if (uri == null) {
            source?.delete()
            if (result != source) result?.delete()
        } else if (result != source) source?.delete()
        cb?.onReceiveValue(uri?.let { arrayOf(it) })
    }
    private val filePicker = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
    ) { r ->
        val cb = fileCallback; fileCallback = null
        val data = r.data
        val uris: Array<Uri>? = if (r.resultCode != RESULT_OK || data == null) null else {
            val clip = data.clipData
            if (clip != null && clip.itemCount > 0) Array(clip.itemCount) { clip.getItemAt(it).uri }
            else data.data?.let { arrayOf(it) }
        }
        cb?.onReceiveValue(uris)
    }

    /** Store camera output privately, apply EXIF rotation, and bound both decoded memory and upload size. */
    private fun compressCameraPhoto(source: File): File? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(source.absolutePath, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 1600) sample *= 2
            val decoded = BitmapFactory.decodeFile(source.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
            val orientation = try {
                android.media.ExifInterface(source.absolutePath).getAttributeInt(
                    android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL
                )
            } catch (_: Exception) { android.media.ExifInterface.ORIENTATION_NORMAL }
            val matrix = Matrix()
            when (orientation) {
                android.media.ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
                android.media.ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
                android.media.ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
                android.media.ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
                android.media.ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
                android.media.ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
                android.media.ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(270f); matrix.postScale(-1f, 1f) }
            }
            val oriented = if (matrix.isIdentity) decoded else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
            if (oriented !== decoded) decoded.recycle()
            val scale = minOf(1f, 1600f / maxOf(oriented.width, oriented.height).toFloat())
            val resized = if (scale < 1f) Bitmap.createScaledBitmap(oriented,
                (oriented.width * scale).toInt().coerceAtLeast(1), (oriented.height * scale).toInt().coerceAtLeast(1), true) else oriented
            if (resized !== oriented) oriented.recycle()
            val output = File(source.parentFile, "camera-vision-${System.nanoTime()}.jpg")
            val ok = FileOutputStream(output).use { resized.compress(Bitmap.CompressFormat.JPEG, 82, it) }
            if (resized !== oriented) resized.recycle() else oriented.recycle()
            if (ok && output.length() > 0L) output else { output.delete(); null }
        } catch (_: Exception) { null }
    }

    /* The manifest declares CAMERA for Live vision, so Android refuses ACTION_IMAGE_CAPTURE until it is granted. */
    private val captureCameraPermission = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission()
    ) { granted ->
        awaitingResult = false
        val cb = fileCallback ?: return@registerForActivityResult
        if (granted && !destroyed) startCameraCaptureIntent(cb)
        else { fileCallback = null; cb.onReceiveValue(null); if (!granted) toastCameraDenied() }
    }

    private fun toastCameraDenied() {
        try { android.widget.Toast.makeText(this, "Camera permission nahi mili.", android.widget.Toast.LENGTH_SHORT).show() } catch (_: Exception) { }
    }

    /** Always returns true: once WebView's callback is owned here, returning false makes WebView crash. */
    private fun launchCameraCapture(cb: ValueCallback<Array<Uri>>): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = cb
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            return try {
                awaitingResult = true
                captureCameraPermission.launch(Manifest.permission.CAMERA)
                true
            } catch (_: Exception) {
                awaitingResult = false
                fileCallback = null
                cb.onReceiveValue(null)
                true
            }
        }
        startCameraCaptureIntent(cb)
        return true
    }

    private fun startCameraCaptureIntent(cb: ValueCallback<Array<Uri>>) {
        val output = File(File(cacheDir, "updates").apply { mkdirs() }, "camera-input-${System.nanoTime()}.jpg")
        try {
            cameraFile = output
            val uri = FileProvider.getUriForFile(this, "$packageName.updates", output)
            awaitingResult = true
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                clipData = ClipData.newUri(contentResolver, "ADARSH camera photo", uri)
            }
            cameraCapture.launch(intent)
        } catch (_: Exception) {
            cameraFile = null
            fileCallback = null
            output.delete()
            awaitingResult = false
            cb.onReceiveValue(null)
        }
    }
    // Export data: "Save file" writes the JSON wherever the user picks (Downloads, Drive...).
    private var pendingSave: String? = null
    private val saver = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.CreateDocument("application/json")
    ) { uri ->
        val text = pendingSave; pendingSave = null
        var ok = false
        if (uri != null && text != null) {
            ok = try { contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) }; true } catch (_: Exception) { false }
        }
        js("window.__adarshSaved&&window.__adarshSaved(${if (uri == null) "null" else ok.toString()})")
    }
    private fun js(code: String) { if (!destroyed) web.evaluateJavascript(code, null) }
    private var bootBarsOn = false
    private var bootAnimator: ObjectAnimator? = null

    /** The native loading frame breathes while the page loads: the same "A" and accent the web boot layer uses, so a
     *  cold start animates from the first frame instead of showing an empty black window. */
    private fun bootPulse(on: Boolean) {
        val logo = findViewById<View?>(R.id.bootLogo) ?: return
        if (!on) { bootAnimator?.cancel(); bootAnimator = null; logo.alpha = 1f; logo.scaleX = 1f; logo.scaleY = 1f; return }
        if (bootAnimator == null) {
            bootAnimator = ObjectAnimator.ofPropertyValuesHolder(
                logo,
                PropertyValuesHolder.ofFloat(View.ALPHA, 1f, 0.55f),
                PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 0.96f),
                PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 0.96f)
            ).apply {
                duration = 900
                repeatCount = ObjectAnimator.INFINITE
                repeatMode = ObjectAnimator.REVERSE
                interpolator = AccelerateDecelerateInterpolator()
            }
        }
        bootAnimator?.start()
    }
    /** Startup animation: the status and navigation bars take its dark ground (#05070B) while it plays, then the
     *  theme colours again. The page asks for both (AdarshNative.bootBars); a cold start begins dark. */
    private fun setBootBars(dark: Boolean) {
        if (destroyed || dark == bootBarsOn) return
        bootBarsOn = dark
        val c = getColor(if (dark) R.color.adarsh_boot else R.color.adarsh_bg)
        window.statusBarColor = c
        window.navigationBarColor = c
    }

    /** Ask for the microphone (the system dialog) and report the answer. Used the first time voice typing starts. */
    /** The notification permission dialog pauses the screen; awaitingResult keeps that pause from a voice handoff. */
    fun askNotifications() { awaitingResult = true; notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }
    fun askMic(cb: (Boolean) -> Unit) { micCallback = cb; awaitingResult = true; micPermission.launch(Manifest.permission.RECORD_AUDIO) }

    private fun backgroundPermissionResult(token: Int, granted: Boolean, denied: String) {
        if (destroyed || token != backgroundGeneration || pendingBackground?.token != token) return
        backgroundAwaitingPermission = false
        if (!granted) {
            pendingBackground = null
            backgroundVoiceEvent(JSONObject().put("ok", false).put("active", false).put("state", "error").put("message", denied))
        } else resumeBackgroundStart()
    }

    /** A grant received before onResume remains pending; never starts a mic foreground service from a paused screen. */
    private fun resumeBackgroundStart(): JSONObject {
        val pending = pendingBackground ?: return BackgroundVoiceService.status()
        val waiting = JSONObject().put("ok", true).put("active", false).put("state", "permission_required")
            .put("message", "Allow microphone and notification access; stay in the app while the session starts.")
        if (destroyed || pending.token != backgroundGeneration) { pendingBackground = null; return waiting }
        if (!resumed || backgroundAwaitingPermission) return waiting
        return try {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                backgroundAwaitingPermission = true
                askMic { ok -> backgroundPermissionResult(pending.token, ok, "Microphone permission is required. Tap Start again after allowing it.") }
                waiting
            } else if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                backgroundAwaitingPermission = true
                backgroundNotificationToken = pending.token
                askNotifications()
                waiting
            } else {
                pendingBackground = null
                dictationWakePaused = false
                WakeWordService.resume(this, "dictation")
                WakeWordService.pause(this, "background_voice")
                dictation.destroy(); speaker?.stopAll(silent = true); neural?.stop()
                BackgroundVoiceService.start(this, pending.json).also {
                    if (!it.optBoolean("ok")) WakeWordService.resume(this, "background_voice")
                    backgroundVoiceEvent(it)
                }
            }
        } catch (_: Exception) {
            pendingBackground = null
            backgroundAwaitingPermission = false
            JSONObject().put("ok", false).put("active", false).put("state", "error")
                .put("message", "Could not request voice permissions. Reopen the app and tap Start again.")
                .also { backgroundVoiceEvent(it) }
        }
    }

    private fun notificationsReady(): Boolean {
        val nm = getSystemService(NotificationManager::class.java)
        val granted = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        return granted && nm?.areNotificationsEnabled() == true
    }

    private fun wakeWordError(state: String, message: String) = JSONObject()
        .put("ok", false).put("enabled", false).put("active", false)
        .put("supported", WakeWordService.supported(this))
        .put("onDevice", WakeWordService.status(this).optBoolean("onDevice")).put("phrase", "Hey Adarsh").put("state", state).put("message", message)

    private fun publishWakeWordPermissionError(state: String, message: String) {
        MainActivity.wakeWordEvent(wakeWordError(state, message).put("type", "status"))
    }

    /** A wake service may start only from an explicit, resumed-screen switch action after both permissions exist. */
    private fun continueWakeWordStart(token: Int): JSONObject {
        if (destroyed || token != wakeWordGeneration) return wakeWordError("off", "Wake word was cancelled")
        if (!WakeWordService.supported(this)) {
            return wakeWordError("unsupported", "Is phone par koi speech recognizer nahi mila. Google app / Speech Services install ya enable karo.")
        }
        if (!resumed || awaitingResult) return wakeWordError("permission_required", "Keep Adarsh open while wake-word permissions are requested")
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingWakeWordPermission = token
            askMic { granted ->
                if (token != wakeWordGeneration) return@askMic
                pendingWakeWordPermission = -1
                if (granted) startWakeWordAfterPermission(token)
                else publishWakeWordPermissionError("permission_required", "Microphone permission was not granted")
            }
            return wakeWordError("permission_required", "Microphone permission is required")
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            pendingWakeWordNotificationToken = token
            askNotifications()
            return wakeWordError("notification_required", "Notification permission is required for the microphone standby notice")
        }
        if (!notificationsReady()) return wakeWordError("notification_required", "Enable Adarsh notifications to show the microphone standby control")
        if (pendingBackground != null || BackgroundVoiceService.status().optBoolean("active") || live?.active() == true || dictationWakePaused) {
            return wakeWordError("busy", "Stop the active voice or dictation session before enabling wake word")
        }
        return WakeWordService.enable(this)
    }

    private fun startWakeWordAfterPermission(token: Int) {
        val result = continueWakeWordStart(token)
        if (result.optString("state") in setOf("unsupported", "permission_required", "notification_required", "busy", "error")) {
            MainActivity.wakeWordEvent(result.put("type", "status"))
        }
    }

    private fun dispatchPendingWakeWordOpen() {
        if (!pendingWakeOpen || !resumed || destroyed || !pageTrusted) return
        pendingWakeOpen = false
        WakeWordService.clearWakeAlert(this)
        js("window.__adarshWakeWord&&window.__adarshWakeWord({type:'wake',source:'notification'})")
    }

    /**
     * Called on Back and Home (still resumed) and from onPause for every other way of leaving the screen: power
     * button / screen off, tapping another app's notification, an app the assistant opened. A pause caused by our
     * own system pickers or permission dialogs (awaitingResult) never hands off. True when the session started.
     */
    private fun handoffToBackground(): Boolean {
        val cfg = handoffConfig ?: return false
        if (destroyed || !resumed || awaitingResult || backgroundAwaitingPermission || micCallback != null) return false
        if (pendingBackground != null || BackgroundVoiceService.status().optBoolean("active")) return false
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
        handoffConfig = null
        backgroundGeneration++
        stopLiveCamera(message = "Camera sharing Live screen se bahar jaate hi band hui.")
        live?.stop() // release the Live AudioRecord before the background voice service claims the microphone
        dictation.destroy(); speaker?.stopAll(silent = true); neural?.stop()
        WakeWordService.pause(this, "background_voice")
        val out = BackgroundVoiceService.start(this, cfg, handoff = true)
        if (!out.optBoolean("ok")) WakeWordService.resume(this, "background_voice")
        else WakeWordService.resume(this, "voice")
        out.put("handoff", true)
        js("window.__adarshVoiceHandoff&&window.__adarshVoiceHandoff($out)")
        return out.optBoolean("ok")
    }

    override fun onUserLeaveHint() {
        handoffToBackground()   // Home / Recents: the voice chat keeps going in the background
        super.onUserLeaveHint()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        if (savedInstanceState == null) {
            setBootBars(true)   // the startup animation follows; the page turns the bars back (fallback below)
            window.decorView.postDelayed({ setBootBars(false) }, 9000)
        }
        web = findViewById(R.id.web)
        loading = findViewById(R.id.loading)
        error = findViewById(R.id.error)
        bootPulse(true)
        findViewById<Button>(R.id.retry).setOnClickListener { load() }

        val loader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/media/", WebViewAssetLoader.PathHandler { path ->
                val match = Regex("^([a-f0-9]{32})\\.(jpg|mp4)$").matchEntire(path) ?: return@PathHandler null
                val file = java.io.File(filesDir, "engine/generated_media/${match.value}")
                if (!file.isFile || file.length() <= 0L) {
                    WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), null)
                } else {
                    val mime = if (match.groupValues[2] == "jpg") "image/jpeg" else "video/mp4"
                    WebResourceResponse(mime, null, 200, "OK", mapOf("Content-Length" to file.length().toString()), file.inputStream())
                }
            })
            .build()

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true            // chats, memory and tasks live in localStorage of this origin
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false)
            mediaPlaybackRequiresUserGesture = false   // spoken replies start after the answer arrives, not on a tap
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.isForMainFrame) pageTrusted = isAppOrigin(request.url)
                val response = loader.shouldInterceptRequest(request.url)
                if (request.isForMainFrame && response != null) {
                    val headers = response.responseHeaders?.toMutableMap() ?: mutableMapOf()
                    headers["Content-Security-Policy"] = "frame-ancestors 'none'"
                    response.responseHeaders = headers
                }
                return response
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                // M1: the bridge answers only while the top document is the bundled page.
                pageTrusted = url != null && isAppOrigin(Uri.parse(url))
                super.onPageStarted(view, url, favicon)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                if (request.url.scheme == "https" || request.url.scheme == "http") {
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {}
                }
                return true   // nothing outside the bundled page ever loads inside this WebView
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (error.visibility != View.VISIBLE) { bootPulse(false); loading.visibility = View.GONE }
                dispatchPendingWakeWordOpen()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, e: WebResourceError) {
                if (request.isForMainFrame) {
                    findViewById<TextView>(R.id.errorText).text = getString(R.string.load_failed)
                    setBootBars(false)
                    bootPulse(false)
                    loading.visibility = View.GONE
                    error.visibility = View.VISIBLE
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                val types = params.acceptTypes.filter { it.isNotBlank() && it.contains('/') }
                if (params.isCaptureEnabled && types.any { it.startsWith("image/") }) return launchCameraCapture(cb)
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                // "application/json" greys out .json files in many file managers: only images are filtered by type
                val type = if (types.size == 1 && types[0].startsWith("image/")) types[0] else "*/*"
                val i = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType(type)
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                return try { awaitingResult = true; filePicker.launch(Intent.createChooser(i, null)); true } catch (_: ActivityNotFoundException) {
                    awaitingResult = false; fileCallback = null; cb.onReceiveValue(null); true
                }
            }
        }
        appCtx = applicationContext
        speaker = Speaker(this) { type, id ->
            if (type == "start") WakeWordService.pause(applicationContext, "tts:$id")
            else if (type in setOf("done", "error", "stopped")) WakeWordService.resume(applicationContext, "tts:$id")
            runOnUiThread { js("window.__adarshTts&&window.__adarshTts(${JSONObject.quote(type)},${JSONObject.quote(id)})") }
        }
        actions = ActionRunner(this)
        neural = VoiceManager(this) { type, id ->
            if (type == "start") WakeWordService.pause(applicationContext, "tts:$id")
            else if (type in setOf("done", "error", "stopped")) WakeWordService.resume(applicationContext, "tts:$id")
            runOnUiThread { js("window.__adarshTts&&window.__adarshTts(${JSONObject.quote(type)},${JSONObject.quote(id)})") }
        }
        launchTarget = intent?.getStringExtra(UpdateCheckJob.EXTRA_OPEN)
        UpdateCheckJob.schedule(this)
        updater = UpdateManager(this) { value -> runOnUiThread { js("window.__adarshUpdate&&window.__adarshUpdate($value)") } }
        val adarshApp = application as AdarshApp
        web.addJavascriptInterface(AdarshBridge(adarshApp.keys, Companion::progress, Companion::deliver), "AdarshNative")

        // Back never closes the app mid-request: it sends it to the background.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // an open "Kisne kya socha" page closes first; otherwise the app goes to the background
                web.evaluateJavascript("(window.__adarshBack&&window.__adarshBack())") { r ->
                    if (r != "true") { handoffToBackground(); moveTaskToBack(true) }
                }
            }
        })

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) askNotifications()

        current = this
        if (intent?.action == WakeWordService.ACTION_OPEN_WAKE) pendingWakeOpen = true
        if (intent?.action == BriefingScheduler.ACTION_OPEN) BriefingScheduler.pendingOpen = true   // notification tap on a cold start
        NewsFcm.openTarget(intent ?: Intent()).let { target -> if (target != null) BriefingScheduler.pendingNewsOpen = target }
        if (savedInstanceState == null) load() else web.restoreState(savedInstanceState)
    }
    /** Night briefing notification while the app is already running (singleTask): the page starts the briefing
     *  after the lock screen; if the page is not loaded yet it takes the flag itself (AdarshNative.takeOpen). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == WakeWordService.ACTION_OPEN_WAKE) {
            pendingWakeOpen = true
            dispatchPendingWakeWordOpen()
            return
        }
        if (intent.action == BriefingScheduler.ACTION_OPEN) {
            BriefingScheduler.pendingOpen = true
            if (pageTrusted) js("window.__adarshOpen&&window.__adarshOpen('briefing')")
            return
        }
        val target = NewsFcm.openTarget(intent)
        if (target != null) {
            BriefingScheduler.pendingNewsOpen = target
            if (pageTrusted) js("window.__adarshOpen&&window.__adarshOpen(${JSONObject.quote(target)})")
            return
        }
        val updateTarget = intent.getStringExtra(UpdateCheckJob.EXTRA_OPEN)
        if (updateTarget != null) {
            launchTarget = updateTarget
            if (updateTarget == UpdateCheckJob.OPEN_UPDATES && pageTrusted) js("window.__adarshOpen&&window.__adarshOpen('updates')")
        }
    }

    private fun load() {
        error.visibility = View.GONE
        loading.visibility = View.VISIBLE
        bootPulse(true)
        web.loadUrl("https://$HOST/assets/index.html")
    }

    private fun flush() {
        if (destroyed) return
        val iter = Engine.undelivered.entries.iterator()
        while (iter.hasNext()) {
            val e = iter.next()
            val (res, err) = e.value
            val js = "window.__adarshResult(${JSONObject.quote(e.key)}," +
                "${res?.let { JSONObject.quote(it) } ?: "null"},${err?.let { JSONObject.quote(it) } ?: "null"})"
            web.evaluateJavascript(js, null)
            iter.remove()
        }
    }

    /** Notification target retained for the page bridge on cold start. */
    private var launchTarget: String? = null
    override fun onResume() {
        super.onResume()
        resumed = true
        awaitingResult = false   // our own permission dialog / picker has closed
        grantedLiveCameraToken?.let { token ->
            grantedLiveCameraToken = null
            if (token == liveCameraGeneration && !destroyed && live?.canReceiveVideo() == true) startLiveCameraNow(token)
        }
        getSystemService(NotificationManager::class.java)?.cancel(REPLY_ID)
        web.onResume()
        flush()   // answers that arrived while the app was in the background
        web.post { dispatchPendingWakeWordOpen() }
        web.post { if (resumed && !destroyed && pendingBackground != null) backgroundVoiceEvent(resumeBackgroundStart()) }
    }

    override fun onPause() {
        // Camera is always foreground-only. Audio-only handoff is started after the Live socket releases its mic.
        if (liveCameraActive) stopLiveCamera(message = "Camera sharing app background mein jaane par band hui.")
        val handedOff = if (!isChangingConfigurations) handoffToBackground() else false
        if (!handedOff && !awaitingResult) live?.stop()
        resumed = false
        // Runtime permission dialogs can pause the activity before BNR capture starts; that pending
        // permission path is left alone. Active BNR capture/transcription is foreground-only.
        dictation.cancelBnrForBackground()
        super.onPause()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    /** Runs on the UI thread: starts the Live session and pushes its first status to the page. */
    private fun startLiveNow(cfg: JSONObject): JSONObject {
        stopLiveCamera(notify = false)
        WakeWordService.pause(this, "live")
        dictationWakePaused = false
        WakeWordService.resume(this, "dictation")
        dictation.destroy()
        speaker?.stopAll(silent = true); neural?.stop()
        val session = live ?: AdarshLive(this) { ev ->
            liveEvent(ev)
        }.also { live = it }
        val out = session.start(cfg)
        if (!out.optBoolean("ok")) WakeWordService.resume(this, "live")
        js("window.__adarshLive&&window.__adarshLive(${JSONObject().put("type", "state").put("state", out.optString("state", "connecting"))})")
        return out
    }

    private fun liveEvent(ev: JSONObject) {
        when (ev.optString("type")) {
            "error", "closed" -> {
                stopLiveCamera(message = "Live band hua; camera sharing bhi band hui.")
                WakeWordService.resume(applicationContext, "live")
            }
            "role" -> if (ev.optString("role") in setOf("translate", "transcribe") && liveCameraActive) {
                stopLiveCamera(message = "Is audio-only Live mode mein camera sharing pause hui.")
            }
        }
        js("window.__adarshLive&&window.__adarshLive($ev)")
    }

    private fun liveCameraEvent(state: String, message: String? = null) {
        val event = JSONObject().put("type", "camera").put("state", state)
        if (!message.isNullOrBlank()) event.put("message", message.take(180))
        js("window.__adarshLive&&window.__adarshLive($event)")
    }

    /** Only called from an explicit Live camera control; camera permission is separate from microphone permission. */
    private fun startLiveCamera(): JSONObject {
        if (destroyed || !resumed || !pageTrusted) return JSONObject().put("ok", false).put("state", "error")
            .put("message", "Live screen visible hone par camera chalu karein.")
        val session = live ?: return JSONObject().put("ok", false).put("state", "error").put("message", "Pehle Adarsh Live chalu karein.")
        if (!session.canReceiveVideo()) return JSONObject().put("ok", false).put("state", "error")
            .put("message", "Gemini Live connect hone ke baad camera chalu karein.")
        if (liveCameraActive) return JSONObject().put("ok", true).put("state", "on")
        if (pendingLiveCameraToken != null) return JSONObject().put("ok", true).put("state", "permission_required")
        val token = ++liveCameraGeneration
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            pendingLiveCameraToken = token
            return try {
                awaitingResult = true
                liveCameraPermission.launch(Manifest.permission.CAMERA)
                JSONObject().put("ok", true).put("state", "permission_required")
            } catch (_: Exception) {
                pendingLiveCameraToken = null
                awaitingResult = false
                JSONObject().put("ok", false).put("state", "error").put("message", "Camera permission request nahi khul saki.")
            }
        }
        return startLiveCameraNow(token)
    }

    private fun startLiveCameraNow(token: Int): JSONObject {
        val session = live
        if (destroyed || !resumed || !pageTrusted || token != liveCameraGeneration || session?.canReceiveVideo() != true) {
            return JSONObject().put("ok", false).put("state", "error").put("message", "Live session ab active nahi hai.")
        }
        val root = web.parent as? FrameLayout
            ?: return JSONObject().put("ok", false).put("state", "error").put("message", "Camera preview available nahi hai.")
        val previewView = liveCameraPreviewView ?: PreviewView(this).also { view ->
            view.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            view.scaleType = PreviewView.ScaleType.FILL_CENTER
            view.setBackgroundColor(Color.BLACK)
            view.background = GradientDrawable().apply { setColor(Color.BLACK); cornerRadius = dp(14).toFloat() }
            view.clipToOutline = true
            view.contentDescription = "Camera preview shared with Gemini Live while camera is on"
            view.elevation = dp(12).toFloat()
            val params = FrameLayout.LayoutParams(dp(132), dp(176), Gravity.TOP or Gravity.END).apply {
                topMargin = dp(72)
                marginEnd = dp(14)
            }
            root.addView(view, params)
            liveCameraPreviewView = view
        }
        previewView.visibility = View.VISIBLE
        val executor = Executors.newSingleThreadExecutor()
        liveCameraExecutor = executor
        val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
        val analysis = ImageAnalysis.Builder()
            .setTargetResolution(Size(640, 480))
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(executor) { image ->
            try {
                val now = SystemClock.elapsedRealtime()
                val previous = lastLiveCameraFrameAt.get()
                if (liveCameraActive && token == liveCameraGeneration && resumed && session.canReceiveVideo() &&
                    now - previous >= LIVE_CAMERA_FRAME_INTERVAL_MS && lastLiveCameraFrameAt.compareAndSet(previous, now)) {
                    encodeLiveCameraFrame(image)?.let { session.sendVideoFrame(it) }
                }
            } catch (_: Exception) {
                // Camera frames are best-effort; a single bad frame must not interrupt the Live audio session.
            } finally {
                image.close()
            }
        }
        lastLiveCameraFrameAt.set(0L)
        return try {
            val future = ProcessCameraProvider.getInstance(applicationContext)
            future.addListener({
                if (destroyed || !resumed || token != liveCameraGeneration || !pageTrusted || live !== session || !session.canReceiveVideo()) {
                    executor.shutdownNow()
                    if (liveCameraExecutor === executor) liveCameraExecutor = null
                    previewView.visibility = View.GONE
                    return@addListener
                }
                try {
                    val provider = future.get()
                    provider.unbindAll()
                    provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                    liveCameraProvider = provider
                    liveCameraPreviewUseCase = preview
                    liveCameraAnalysisUseCase = analysis
                    liveCameraActive = true
                    liveCameraEvent("on")
                } catch (_: Exception) {
                    analysis.clearAnalyzer()
                    executor.shutdownNow()
                    if (liveCameraExecutor === executor) liveCameraExecutor = null
                    previewView.visibility = View.GONE
                    liveCameraEvent("error", "Camera start nahi hua. Permission aur camera availability check karein.")
                }
            }, ContextCompat.getMainExecutor(this))
            JSONObject().put("ok", true).put("state", "starting")
        } catch (_: Exception) {
            analysis.clearAnalyzer()
            executor.shutdownNow()
            liveCameraExecutor = null
            previewView.visibility = View.GONE
            JSONObject().put("ok", false).put("state", "error").put("message", "Camera start nahi hua.")
        }
    }

    private fun encodeLiveCameraFrame(image: ImageProxy): ByteArray? {
        val source = try { image.toBitmap() } catch (_: Exception) { return null }
        val rotation = image.imageInfo.rotationDegrees
        val rotated = if (rotation == 0) source else try {
            Bitmap.createBitmap(source, 0, 0, source.width, source.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
        } catch (_: Exception) { source }
        val scale = minOf(1f, 640f / maxOf(rotated.width, rotated.height).toFloat())
        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(rotated,
            (rotated.width * scale).toInt().coerceAtLeast(1), (rotated.height * scale).toInt().coerceAtLeast(1), true) else rotated
        return try {
            val bytes = ByteArrayOutputStream()
            if (!scaled.compress(Bitmap.CompressFormat.JPEG, 62, bytes) || bytes.size() > MAX_LIVE_CAMERA_FRAME_BYTES) null
            else bytes.toByteArray()
        } catch (_: Exception) { null }
        finally {
            if (scaled !== rotated) scaled.recycle()
            if (rotated !== source) rotated.recycle()
            source.recycle()
        }
    }

    private fun stopLiveCamera(message: String? = null, notify: Boolean = true): JSONObject {
        val wasActive = liveCameraActive || pendingLiveCameraToken != null || liveCameraProvider != null
        liveCameraGeneration++
        pendingLiveCameraToken = null
        grantedLiveCameraToken = null
        liveCameraActive = false
        val analysis = liveCameraAnalysisUseCase
        val preview = liveCameraPreviewUseCase
        val provider = liveCameraProvider
        liveCameraAnalysisUseCase = null
        liveCameraPreviewUseCase = null
        liveCameraProvider = null
        try { analysis?.clearAnalyzer() } catch (_: Exception) { }
        try {
            if (provider != null) {
                if (analysis != null) provider.unbind(analysis)
                if (preview != null) provider.unbind(preview)
            }
        } catch (_: Exception) { }
        liveCameraExecutor?.shutdownNow()
        liveCameraExecutor = null
        liveCameraPreviewView?.visibility = View.GONE
        if (notify && wasActive) liveCameraEvent("off", message)
        return JSONObject().put("ok", true).put("state", "off")
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    override fun onDestroy() {
        destroyed = true
        stopLiveCamera(notify = false)
        backgroundGeneration++
        pendingBackground = null
        if (current === this) current = null
        handoffConfig = null
        BackgroundVoiceService.unprepare()
        dictation.destroy()
        live?.stop()
        live = null
        pendingLive = null
        speaker?.destroy()
        neural?.destroy()
        updater?.destroy()
        web.removeJavascriptInterface("AdarshNative")
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val HOST = "appassets.androidplatform.net"
        private const val LIVE_CAMERA_FRAME_INTERVAL_MS = 1_000L
        private const val MAX_LIVE_CAMERA_FRAME_BYTES = 256 * 1024
        /** M1: true only while the main frame is https://appassets.androidplatform.net (set on the UI/IO thread). */
        @Volatile private var pageTrusted = false
        @Volatile private var pendingWakeOpen = false
        private fun isAppOrigin(u: Uri?): Boolean = u != null && u.scheme == "https" && u.host == HOST
        /** Called by AdarshBridge before every method; the page also sets CSP frame-src 'none' so no frame can load. */
        fun pageTrusted(): Boolean = pageTrusted && current?.destroyed == false
        private const val REPLY_CHANNEL = "replies"
        private const val REPLY_ID = 8
        @Volatile var current: MainActivity? = null
        @Volatile private var appCtx: Context? = null
        private fun prefs(c: Context) = c.getSharedPreferences("adarsh_ui", Context.MODE_PRIVATE)
        private fun ui(f: (MainActivity) -> Unit) { current?.let { a -> a.runOnUiThread { if (!a.destroyed) f(a) } } }

        /** Foreground wake goes straight to the page. Background wake is raised by WakeWordService (full-screen /
         *  heads-up notice + direct start where Android allows); its ACTION_OPEN_WAKE intent queues the open. */
        fun wakeWordEvent(value: JSONObject) {
            if (value.optString("type") == "wake") {
                val a = current
                if (a == null) return
                a.runOnUiThread {
                    if (a.destroyed) return@runOnUiThread
                    if (a.resumed && pageTrusted) {
                        pendingWakeOpen = false
                        a.js("window.__adarshWakeWord&&window.__adarshWakeWord({type:'wake',source:'foreground'})")
                    }
                }
            } else {
                ui { a -> if (a.resumed && pageTrusted) a.js("window.__adarshWakeWord&&window.__adarshWakeWord($value)") }
            }
        }

        fun deliverPendingWakeWordOpen() = ui { it.dispatchPendingWakeWordOpen() }

        /** Settings API: asks permissions while visible, then explicitly starts or stops the local detector. */
        fun wakeWordSet(enabled: Boolean): String = onMain {
            val a = current!!
            if (!enabled) {
                a.wakeWordGeneration++
                a.pendingWakeWordPermission = -1
                a.pendingWakeWordNotificationToken = -1
                WakeWordService.disable(a).toString()
            } else {
                if (!a.resumed) return@onMain JSONObject().put("ok", false).put("enabled", false)
                    .put("active", false).put("state", "permission_required")
                    .put("message", "Open Adarsh before turning on wake word").toString()
                val token = ++a.wakeWordGeneration
                a.pendingWakeWordPermission = token
                a.continueWakeWordStart(token).toString()
            }
        }
        fun wakeWordStatus(): String = onMain { WakeWordService.status(current!!).toString() }
        fun wakeWordPause(reason: String): String = onMain {
            WakeWordService.pause(current!!, reason)
            WakeWordService.status(current!!).toString()
        }
        fun wakeWordResume(reason: String): String = onMain {
            WakeWordService.resume(current!!, reason)
            WakeWordService.status(current!!).toString()
        }

        // These are user UI controls, not AI action capabilities. Never included in the action allowlist.
        fun isOnScreen(): Boolean = current?.let { it.resumed && !it.destroyed } == true
        /** Read once by the page at boot; a cold start from the update notification opens App updates. */
        fun launchTarget(): String = onMain { val a = current!!; val t = a.launchTarget ?: ""; a.launchTarget = null; t }
        /** "" reads the switch; "on"/"off" changes it. Turning it on asks for notification permission once. */
        fun updateNotify(value: String): String = onMain {
            val a = current!!
            if (value == "on" || value == "off") UpdateCheckJob.setEnabled(a, value == "on")
            val on = UpdateCheckJob.enabled(a)
            if (value == "on" && Build.VERSION.SDK_INT >= 33 &&
                a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) a.askNotifications()
            JSONObject().put("ok", true).put("on", on).put("notifications", a.notificationsReady()).toString()
        }
        fun updateStatus(): String = onMain { current!!.updater!!.status().toString() }
        fun updateCheck(force: Boolean): String = onMain { current!!.updater!!.check(force).toString() }
        fun updateDownload(): String = onMain { current!!.updater!!.download().toString() }
        fun updateInstall(): String = onMain { current!!.updater!!.install().toString() }
        fun bootBars(dark: Boolean) = ui { a -> a.setBootBars(dark) }
        /** Installed build for the Settings footer; empty when the package cannot be read. */
        fun appVersion(): String {
            val c = appCtx ?: return ""
            return try {
                val p = c.packageManager.getPackageInfo(c.packageName, 0)
                p.versionName + " (" + p.versionCode + ")"
            } catch (e: Exception) { "" }
        }
        fun backgroundVoiceStatus(): String = onMain {
            if (current!!.pendingBackground != null) JSONObject().put("ok", true).put("active", false).put("state", "permission_required")
                .put("message", "Voice start is waiting for permissions. Stay in the app or tap Stop to cancel.").toString()
            else BackgroundVoiceService.status().toString()
        }
        fun backgroundVoiceStart(json: String): String = onMain {
            val a = current!!
            if (!a.resumed) return@onMain JSONObject().put("ok", false).put("active", false).put("state", "error").put("message", "Open the app before starting background voice.").toString()
            if (a.pendingBackground != null || BackgroundVoiceService.status().optBoolean("active")) return@onMain backgroundVoiceStatus()
            a.pendingBackground = PendingBackground(++a.backgroundGeneration, json)
            a.backgroundAwaitingPermission = false
            a.resumeBackgroundStart().toString()
        }
        fun backgroundVoiceStop(): String = onMain {
            val a = current!!
            a.backgroundGeneration++; a.pendingBackground = null; a.backgroundAwaitingPermission = false; a.handoffConfig = null
            BackgroundVoiceService.stop(a).toString()
        }
        fun backgroundVoiceArm(json: String): String = onMain {
            val a = current!!
            a.handoffConfig = json.trim().ifBlank { null }
            val armed = a.handoffConfig != null
            // Become a foreground service while the screen is visible; leaving the app then only starts listening.
            val ready = if (armed) BackgroundVoiceService.prepare(a) else { BackgroundVoiceService.unprepare(); false }
            val notif = a.notificationsReady()
            // Ask once, while the user is looking at the voice screen; leaving the app cannot show a dialog.
            if (armed && !notif && Build.VERSION.SDK_INT >= 33 && a.resumed && !a.handoffNotifAsked &&
                a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                a.handoffNotifAsked = true
                a.askNotifications()
            }
            JSONObject().put("ok", true).put("armed", armed).put("ready", ready).put("notifications", notif).toString()
        }
        fun backgroundVoicePeek(): String = onMain { BackgroundVoiceService.peek(current!!).toString() }
        fun backgroundVoiceAck(json: String): String = onMain {
            try { BackgroundVoiceService.ack(current!!, org.json.JSONArray(json)).toString() }
            catch (_: Exception) { JSONObject().put("ok", false).toString() }
        }
        fun backgroundVoiceEvent(value: JSONObject) = ui { a -> a.js("window.__adarshBackgroundVoice&&window.__adarshBackgroundVoice($value)") }

        // ---- Adarsh Live (AdarshLive.kt): one Gemini Live socket, spoken both ways, only while the voice screen is open
        fun liveStatus(): String = onMain {
            JSONObject().put("ok", true).put("active", current?.live?.active() ?: false).toString()
        }
        /** cfg: {model, voice, prompt}. The Gemini key never leaves the phone: it is read here from SecureKeys. */
        fun liveStart(json: String): String = onMain {
            val a = current!!
            val cfg = try { JSONObject(json) } catch (_: Exception) { JSONObject() }
            val key = (a.applicationContext as AdarshApp).keys.first("GEMINI_API_KEY")
            if (key.isNullOrBlank()) return@onMain JSONObject().put("ok", false).put("state", "error")
                .put("message", "Gemini API key nahi mili. Controller > Keys & settings me daalo.").toString()
            WakeWordService.pause(a, "live")
            a.stopLiveCamera(notify = false)
            cfg.put("key", key)
            val session = a.live ?: AdarshLive(a) { ev -> a.liveEvent(ev) }.also { a.live = it }
            if (session.active()) session.stop()
            if (a.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                a.pendingLive = cfg
                a.askMic { ok ->
                    val pending = a.pendingLive ?: return@askMic
                    a.pendingLive = null
                    if (!ok) { WakeWordService.resume(a, "live"); a.js("window.__adarshLive&&window.__adarshLive(${JSONObject().put("type", "error").put("message", "Microphone permission nahi mili.")})"); return@askMic }
                    a.startLiveNow(pending)
                }
                return@onMain JSONObject().put("ok", true).put("state", "permission_required").toString()
            }
            a.startLiveNow(cfg).toString()
        }
        /** Settings > Test Adarsh Live: first a plain HTTPS key/network check, then the socket itself. */
        fun liveProbe(): String = onMain {
            val a = current!!
            AdarshLive.probe(a) { ev -> a.js("window.__adarshLive&&window.__adarshLive($ev)") }
            JSONObject().put("ok", true).toString()
        }
        /** Auto role routing: move the same live conversation to another Live model (main / think / translate / ...). */
        fun liveSwitch(role: String): String = onMain {
            val session = current?.live
                ?: return@onMain JSONObject().put("ok", false).put("message", "live band hai").toString()
            session.switchTo(role).toString()
        }
        fun liveSendText(text: String): String = onMain {
            JSONObject().put("ok", current?.live?.sendText(text) ?: false).toString()
        }
        fun liveCameraStart(): String = onMain {
            current?.startLiveCamera()?.toString()
                ?: JSONObject().put("ok", false).put("state", "error").put("message", "App active nahi hai.").toString()
        }
        fun liveCameraStop(): String = onMain {
            current?.stopLiveCamera()?.toString()
                ?: JSONObject().put("ok", true).put("state", "off").toString()
        }
        /** A generated report: Downloads/Adarsh on Q+, else the app's own reports folder. Falls back to the app folder
         *  when the MediaStore insert is refused (some OEMs), so a report is never lost. */
        fun savePdf(name: String, base64: String): String = onMain {
            val a = current!!
            val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(60).ifBlank { "adarsh-report.pdf" }
            val bytes = try { Base64.decode(base64, Base64.DEFAULT) } catch (e: Exception) {
                return@onMain JSONObject().put("ok", false).put("message", "PDF data kharab hai").toString()
            }
            fun appFolder(): String {
                val dir = File(a.getExternalFilesDir(null) ?: a.filesDir, "reports").apply { mkdirs() }
                val f = File(dir, safe)
                f.writeBytes(bytes)
                return f.absolutePath
            }
            val where = try {
                if (Build.VERSION.SDK_INT >= 29) {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, safe)
                        put(MediaStore.Downloads.MIME_TYPE, "application/pdf")
                        put(MediaStore.Downloads.RELATIVE_PATH, "Download/Adarsh")
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val uri = a.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: return@onMain JSONObject().put("ok", true).put("name", safe).put("path", appFolder()).toString()
                    a.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0)
                    a.contentResolver.update(uri, values, null, null)
                    "Download/Adarsh/" + safe
                } else {
                    appFolder()
                }
            } catch (e: Exception) {
                try { appFolder() } catch (e2: Exception) {
                    return@onMain JSONObject().put("ok", false).put("message", e2.message ?: "save nahi hua").toString()
                }
            }
            JSONObject().put("ok", true).put("name", safe).put("path", where).toString()
        }
        fun liveStop(): String = onMain {
            val a = current!!
            a.pendingLive = null
            a.stopLiveCamera(message = "Live session band hui; camera sharing bhi band hui.")
            a.live?.stop()
            WakeWordService.resume(a, "live")
            JSONObject().put("ok", true).toString()
        }

        // ---- speech out (Speaker.kt). Results come back as window.__adarshTts(type, id)
        fun ttsAvailable(): Boolean = current?.speaker?.let { !it.failed } ?: false
        fun ttsSpeak(id: String, text: String, lang: String, rate: Float) = ui { WakeWordService.pause(it, "tts:$id"); it.speaker?.speak(id, text, lang, rate) }
        fun ttsPlayFile(id: String, path: String, rate: Float) = ui { WakeWordService.pause(it, "tts:$id"); it.speaker?.playFile(id, path, rate) }
        fun ttsStop() = ui { it.speaker?.stopAll(silent = true); it.neural?.stop() }
        /** Phone voices the user can choose from (Settings > Voice & language > Phone voice). */
        fun ttsVoices(): String = onMain { current?.speaker?.voiceList() ?: "[]" }
        fun ttsSetVoice(name: String) = ui { it.speaker?.wanted = name.ifBlank { null } }

        /** Open a source in the phone browser; reject every non-HTTP(S) scheme before creating the intent. */
        fun openExternal(url: String): Boolean {
            val uri = try { Uri.parse(url.trim()) } catch (_: Exception) { return false }
            val scheme = uri.scheme?.lowercase()
            if ((scheme != "http" && scheme != "https") || uri.host.isNullOrBlank()) return false
            return onMainBool {
                try { current?.startActivity(Intent(Intent.ACTION_VIEW, uri)); true } catch (_: Exception) { false }
            }
        }

        // ---- Standard-mode actions (ActionRunner.kt). Called from JS; must answer synchronously.
        private fun onMain(block: () -> String): String {
            val a = current ?: return """{"error":"no screen"}"""
            fun safeBlock(): String = try {
                if (a.destroyed || current !== a) """{"ok":false,"error":"no screen"}""" else block()
            } catch (_: Exception) { """{"ok":false,"error":"Native operation failed"}""" }
            if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return safeBlock()
            var out = """{"error":"timeout"}"""
            val latch = java.util.concurrent.CountDownLatch(1)
            a.runOnUiThread { try { out = safeBlock() } finally { latch.countDown() } }
            latch.await(6, java.util.concurrent.TimeUnit.SECONDS)
            return out
        }
        private fun onMainBool(block: () -> Boolean): Boolean {
            val a = current ?: return false
            fun safeBlock(): Boolean = try {
                if (a.destroyed || current !== a) false else block()
            } catch (_: Exception) { false }
            if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return safeBlock()
            var out = false
            val latch = java.util.concurrent.CountDownLatch(1)
            a.runOnUiThread { try { out = safeBlock() } finally { latch.countDown() } }
            latch.await(6, java.util.concurrent.TimeUnit.SECONDS)
            return out
        }

        private val SENSITIVE = setOf("message.draft", "call.dial")
        /**
         * H5: the page can no longer self-confirm a call or message. The JS "confirmed" flag only means the user
         * tapped Confirm in chat; the step still runs only after a native dialog that shows the exact number/text
         * from the same parsed step object that is executed (so the page cannot swap the arguments afterwards).
         */
        private fun nativeConfirm(step: JSONObject): Boolean {
            val a = current ?: return false
            if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper() || !a.resumed) return false
            val action = step.optString("action")
            val args = step.optJSONObject("args") ?: JSONObject()
            val to = args.optString("to")
            val text = args.optString("text")
            // What the dialog shows must be exactly what runs: inputs too long to show in full are refused.
            if (to.length > 64 || text.length > 2000) return false
            val msg = if (action == "call.dial") "Dialer kholun is number ke saath?\n\n$to"
                else (if (args.optString("channel").equals("whatsapp", true)) "WhatsApp" else "SMS") +
                    " draft kholun?\n\n" + (if (to.isNotBlank()) "To: $to\n" else "") + text
            val latch = java.util.concurrent.CountDownLatch(1)
            val yes = java.util.concurrent.atomic.AtomicBoolean(false)
            val expired = java.util.concurrent.atomic.AtomicBoolean(false)
            val dialog = java.util.concurrent.atomic.AtomicReference<AlertDialog?>(null)
            a.runOnUiThread {
                if (a.destroyed || a.isFinishing || current !== a) { latch.countDown(); return@runOnUiThread }
                try {
                    dialog.set(AlertDialog.Builder(a)
                        .setTitle("ADARSH: confirm karo")
                        .setMessage(msg)
                        .setPositiveButton("Haan") { _, _ -> if (!expired.get()) yes.set(true) }
                        .setNegativeButton("Nahi", null)
                        .setOnDismissListener { latch.countDown() }
                        .show())
                } catch (_: Exception) { latch.countDown() }
            }
            val answered = latch.await(60, java.util.concurrent.TimeUnit.SECONDS)
            if (!answered) {
                expired.set(true)
                a.runOnUiThread { try { dialog.get()?.dismiss() } catch (_: Exception) {} }
            }
            return answered && yes.get() && !expired.get()
        }
        fun runActions(json: String): String {
            val bad = { m: String -> JSONObject().put("ok", false).put("error", m).put("results", org.json.JSONArray()).toString() }
            val req = try { JSONObject(json) } catch (_: Exception) { return bad("Invalid request") }
            val mode = if (!req.has("mode") || req.isNull("mode")) "standard" else req.opt("mode")
            if (mode !is String || mode != "standard") return bad("Native actions require mode=standard")
            val asked = if (!req.has("confirmed") || req.isNull("confirmed")) false else {
                if (req.opt("confirmed") !is Boolean) return bad("confirmed must be boolean")
                req.getBoolean("confirmed")
            }
            val steps = req.optJSONArray("steps") ?: return bad("steps must be an array")
            if (steps.length() > 20) return bad("Too many steps")
            val parsed = ArrayList<JSONObject>()
            for (i in 0 until steps.length()) parsed.add(steps.optJSONObject(i) ?: return bad("steps[$i] must be an object"))
            // Native confirmation happens on this bridge thread (not the UI thread) so the dialog can be answered.
            val approved = BooleanArray(parsed.size)
            val declined = BooleanArray(parsed.size)
            for ((i, step) in parsed.withIndex()) {
                if (step.optString("action") in SENSITIVE && asked) {
                    approved[i] = nativeConfirm(step)
                    declined[i] = !approved[i]
                }
            }
            return onMain {
                try {
                    val results = org.json.JSONArray()
                    for ((i, step) in parsed.withIndex()) {
                        if (declined[i]) {
                            results.put(JSONObject().put("id", step.optString("id", "step")).put("ok", false)
                                .put("message", "Cancel kar diya: phone par confirm nahi hua"))
                            continue
                        }
                        results.put(current!!.actions!!.run(step, approved[i]))
                    }
                    JSONObject().put("ok", true).put("results", results).toString()
                } catch (e: Exception) {
                    JSONObject().put("ok", false).put("error", (e.message ?: e.javaClass.simpleName).take(200)).toString()
                }
            }
        }
        /** Unified native records API. The JS side no longer needs separate note/reminder stores. */
        fun recordsList(): String = onMain {
            try {
                val arr = org.json.JSONArray()
                ActionStore(current!!).all().forEach { arr.put(it) }
                JSONObject().put("records", arr).toString()
            } catch (e: Exception) {
                JSONObject().put("records", org.json.JSONArray()).put("ok", false).put("error", e.message ?: e.javaClass.simpleName).toString()
            }
        }

        /** Imports only {records:[...]} and never deletes records absent from the import. */
        fun recordsImport(json: String): String = onMain {
            try {
                val req = JSONObject(json)
                val records = req.optJSONArray("records") ?: return@onMain JSONObject().put("ok", false).put("error", "records must be an array").toString()
                val store = ActionStore(current!!)
                val result = store.importRecords(records)
                // Import may contain future task/reminder/alarm/timer records; rearm from the
                // persisted source so the receiver uses the imported title/kind, not JS extras.
                current!!.actions!!.rearmAll()
                val all = org.json.JSONArray()
                store.all().forEach { all.put(it) }
                JSONObject().put("ok", true).put("imported", result.imported).put("skipped", result.skipped).put("records", all).toString()
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName).toString()
            }
        }

        /** Manual-only deletion endpoint; action steps can never delete or clear records. */
        fun recordsDelete(id: String): String = onMain {
            try {
                if (id.isBlank()) return@onMain JSONObject().put("ok", false).put("error", "id must be non-empty").toString()
                val deleted = current!!.actions!!.deleteRecord(id)
                if (!deleted) JSONObject().put("ok", false).put("error", "No record has id '$id'")
                else JSONObject().put("ok", true).put("detail", id).put("message", "Record deleted")
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName)
            }.toString()
        }

        // Legacy note API retained for existing UI callers.
        fun listNotes(): String = onMain {
            val arr = org.json.JSONArray()
            ActionStore(current!!).notes().forEach { arr.put(it) }
            JSONObject().put("notes", arr).toString()
        }

        fun deleteNote(id: String): String = onMain {
            val record = ActionStore(current!!).find(id)
            val result = if (record == null || record.optString("kind") != "note") JSONObject().put("ok", false).put("error", "Note not found")
            else {
                val deleted = current!!.actions!!.deleteRecord(id)
                JSONObject().put("ok", deleted)
            }
            result.toString()
        }
        fun actionInfo(): String = onMain {
            val a = current!!
            val nm = a.getSystemService(NotificationManager::class.java)
            val am = a.getSystemService(android.app.AlarmManager::class.java)
            JSONObject()
                .put("notify", Build.VERSION.SDK_INT < 33 || a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                .put("exact", Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms())
                .put("dnd", nm.isNotificationPolicyAccessGranted)
                .put("enabled", nm.areNotificationsEnabled())
                .toString()
        }

        // ---- V6 offline neural voice (VoiceManager.kt)
        fun neuralReady(): Boolean = current?.neural?.ready() ?: false
        fun neuralStatus(): String = current?.neural?.status() ?: """{"hi":false,"en":false,"installing":false,"progress":0,"error":""}"""
        fun neuralInstall() = ui { a ->
            a.neural?.install { ok -> a.runOnUiThread { a.js("window.__adarshNeural&&window.__adarshNeural($ok)") } }
        }
        fun neuralSpeak(id: String, text: String, lang: String, rate: Float) = ui { WakeWordService.pause(it, "tts:$id"); it.speaker?.stopAll(silent = true); it.neural?.speak(id, text, lang, rate) }
        fun neuralPause() = ui { it.neural?.pause() }
        fun neuralResume() = ui { it.neural?.resume() }

        // ---- small native helpers the WebView cannot do itself
        // WebView.performHapticFeedback is silently dropped when the phone's "touch vibration" setting is off,
        // so the in-app Haptics switch drives the vibrator directly and only falls back to the View API.
        fun haptic(ms: Int) {
            val c = appCtx
            val strong = ms >= 25
            try {
                val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= 31) {
                    c?.getSystemService(VibratorManager::class.java)?.defaultVibrator
                } else {
                    @Suppress("DEPRECATION")
                    c?.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                }
                if (vibrator != null && vibrator.hasVibrator()) {
                    val effect = if (Build.VERSION.SDK_INT >= 29) {
                        VibrationEffect.createPredefined(if (strong) VibrationEffect.EFFECT_HEAVY_CLICK else VibrationEffect.EFFECT_CLICK)
                    } else {
                        VibrationEffect.createOneShot(ms.coerceIn(10, 60).toLong(), VibrationEffect.DEFAULT_AMPLITUDE)
                    }
                    vibrator.vibrate(effect)
                    return
                }
            } catch (_: Exception) {
            }
            ui { it.web.performHapticFeedback(if (strong) HapticFeedbackConstants.LONG_PRESS else HapticFeedbackConstants.VIRTUAL_KEY) }
        }
        fun copyText(text: String): Boolean {
            val c = appCtx ?: return false
            return try {
                val cm = c.getSystemService(ClipboardManager::class.java)
                cm.setPrimaryClip(ClipData.newPlainText("Adarsh", text)); true
            } catch (_: Exception) { false }
        }
        fun shareText(text: String) = ui { a ->
            val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            try { a.startActivity(Intent.createChooser(i, null)) } catch (_: Exception) {}
        }
        fun saveFile(name: String, text: String) = ui { a ->
            a.pendingSave = text
            try { a.awaitingResult = true; a.saver.launch(name) } catch (_: Exception) { a.pendingSave = null; a.js("window.__adarshSaved&&window.__adarshSaved(false)") }
        }

        // ---- reply notifications: the WebView has no Notification API, so the app posts them itself
        /** "granted" | "asked" (system dialog shown) | "denied" | "off" */
        /** Night briefing schedule {on, time, ask}; `ask` (a Settings change) may show the notification permission dialog. */
        fun briefingSet(json: String): String {
            val c = appCtx ?: return "{\"ok\":false,\"error\":\"not ready\"}"
            val out = BriefingScheduler.configure(c, json)
            val ask = try { JSONObject(json).optBoolean("ask", false) && JSONObject(json).optBoolean("on", true) } catch (_: Exception) { false }
            if (ask && Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ui { it.notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }
            }
            return out
        }
        fun briefingStatus(): String = appCtx?.let { BriefingScheduler.status(it).toString() } ?: "{\"ok\":false,\"error\":\"not ready\"}"
        fun takeOpen(): String = BriefingScheduler.takeOpen()
        fun newsStatus(): String = appCtx?.let { NewsFcm.newsStatus(it).toString() }
            ?: "{\"configured\":false,\"url\":\"\"}"
        fun newsCall(id: String, json: String) {
            val c = appCtx ?: return
            NewsFcm.newsCall(c, id, json) { result ->
                ui { a -> a.js("window.__adarshNews&&window.__adarshNews(${JSONObject.quote(id)},$result)") }
            }
        }
        fun setNotify(on: Boolean): String {
            val c = appCtx ?: return "denied"
            prefs(c).edit().putBoolean("notify", on).apply()
            if (!on) return "off"
            if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ui { it.askNotifications() }
                return "asked"
            }
            return if (c.getSystemService(NotificationManager::class.java).areNotificationsEnabled()) "granted" else "denied"
        }
        private fun replySnippet(result: String?): String {
            if (result == null) return "Jawab aa gaya."
            return try {
                val t = result.trim()
                val o = if (t.startsWith("[")) org.json.JSONArray(t).optJSONObject(0) else JSONObject(t)
                val txt = (o?.optString("text") ?: "").replace(Regex("[*#`>_]"), "").trim()
                if (txt.isEmpty()) "Jawab aa gaya." else txt.take(160)
            } catch (_: Exception) { "Jawab aa gaya." }
        }
        private fun maybeNotify(id: String, result: String?) {
            val c = appCtx ?: return
            if (!id.startsWith("r") || current?.resumed == true || !prefs(c).getBoolean("notify", false)) return
            if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            try {
                val nm = c.getSystemService(NotificationManager::class.java)
                nm.createNotificationChannel(NotificationChannel(REPLY_CHANNEL, "Replies", NotificationManager.IMPORTANCE_DEFAULT))
                val open = PendingIntent.getActivity(
                    c, 1, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
                val text = replySnippet(result)
                val n = Notification.Builder(c, REPLY_CHANNEL)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle("Adarsh ka jawab tayyar hai")
                    .setContentText(text)
                    .setStyle(Notification.BigTextStyle().bigText(text))
                    .setContentIntent(open)
                    .setAutoCancel(true)
                    .build()
                nm.notify(REPLY_ID, n)
            } catch (_: Exception) {}
        }

        fun bnrSupported(): Boolean = Build.VERSION.SDK_INT >= 33
        fun speechStart(lang: String, useBnr: Boolean = false, functionId: String = "", apiKey: String = "") {
            current?.let { a -> a.runOnUiThread {
                if (!a.destroyed) {
                    a.dictationWakePaused = true
                    WakeWordService.pause(a, "dictation")
                    a.dictation.start(lang, useBnr, functionId, apiKey)
                }
            } }
        }
        fun speechStop() { current?.let { a -> a.runOnUiThread {
            if (!a.destroyed) {
                a.dictation.stop()
                a.dictationWakePaused = false
                WakeWordService.resume(a, "dictation")
            }
        } } }

        /** Dictation -> page. */
        fun speech(type: String, text: String) {
            current?.let { a ->
                a.runOnUiThread {
                    if (type in setOf("final", "state", "error")) {
                        a.dictationWakePaused = false
                        WakeWordService.resume(a, "dictation")
                    }
                    if (!a.destroyed) a.web.evaluateJavascript(
                        "window.__adarshSpeech&&window.__adarshSpeech(${JSONObject.quote(type)},${JSONObject.quote(text)})", null
                    )
                }
            }
        }

        /** Stage text ("Falsifiers galtiyan dhoondh rahe hain") shown under Thinking. Dropped if no screen is attached. */
        fun progress(id: String, msg: String) {
            current?.let { a ->
                a.runOnUiThread {
                    if (!a.destroyed) a.web.evaluateJavascript(
                        "window.__adarshProgress(${JSONObject.quote(id)},${JSONObject.quote(msg)})", null
                    )
                }
            }
        }

        /** Engine thread -> page. Parked in Engine.undelivered if no screen is attached; flushed on the next resume. */
        fun deliver(id: String, result: String?, err: String?) {
            Engine.undelivered[id] = Pair(result, err)
            maybeNotify(id, result)
            current?.let { a -> a.runOnUiThread { a.flush() } }
        }
    }
}
