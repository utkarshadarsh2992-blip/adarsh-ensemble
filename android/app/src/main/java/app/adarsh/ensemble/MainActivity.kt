package app.adarsh.ensemble

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
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
import android.widget.Button
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var loading: View
    private lateinit var error: View
    @Volatile private var destroyed = false

    private val notifPermission = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission()
    ) { ok ->
        val pending = pendingBackground
        if (pending != null && pending.token == backgroundNotificationToken) {
            backgroundPermissionResult(pending.token, ok, "Notification permission is required. Enable app notifications and tap Start again.")
        }
    }

    private var micCallback: ((Boolean) -> Unit)? = null
    private val micPermission = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission()
    ) { ok -> val cb = micCallback; micCallback = null; cb?.invoke(ok) }
    private val dictation by lazy { Dictation(this) }
    private var speaker: Speaker? = null
    private var neural: VoiceManager? = null
    private var live: AdarshLive? = null
    private var pendingLive: JSONObject? = null
    private var updater: UpdateManager? = null
    private var actions: ActionRunner? = null
    @Volatile private var resumed = false
    private var backgroundGeneration = 0
    private data class PendingBackground(val token: Int, val json: String)
    private var pendingBackground: PendingBackground? = null
    private var backgroundAwaitingPermission = false
    private var backgroundNotificationToken = -1
    // Live voice handoff: while the in-app voice screen is open in Standard mode the page keeps a ready
    // session config here. Back/Home starts the 30-minute background session while this screen is still
    // resumed, which Android requires for a microphone foreground service.
    @Volatile private var handoffConfig: String? = null
    private var handoffNotifAsked = false
    // True while one of our own system screens (permission dialog, file picker, save dialog) is in front.
    @Volatile private var awaitingResult = false
    // <input type=file> (Import data, attachments): the WebView needs a chooser from the app, or the tap does nothing.
    private var fileCallback: ValueCallback<Array<Uri>>? = null
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
                dictation.destroy(); speaker?.stopAll(silent = true); neural?.stop()
                BackgroundVoiceService.start(this, pending.json).also { backgroundVoiceEvent(it) }
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
        dictation.destroy(); speaker?.stopAll(silent = true); neural?.stop()
        val out = BackgroundVoiceService.start(this, cfg, handoff = true)
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
                return loader.shouldInterceptRequest(request.url)
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
                if (error.visibility != View.VISIBLE) loading.visibility = View.GONE
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, e: WebResourceError) {
                if (request.isForMainFrame) {
                    findViewById<TextView>(R.id.errorText).text = getString(R.string.load_failed)
                    setBootBars(false)
                    loading.visibility = View.GONE
                    error.visibility = View.VISIBLE
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                val types = params.acceptTypes.filter { it.isNotBlank() && it.contains('/') }
                // "application/json" greys out .json files in many file managers: only images are filtered by type
                val type = if (types.size == 1 && types[0].startsWith("image/")) types[0] else "*/*"
                val i = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType(type)
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                return try { awaitingResult = true; filePicker.launch(Intent.createChooser(i, null)); true } catch (_: ActivityNotFoundException) {
                    fileCallback = null; cb.onReceiveValue(null); false
                }
            }
        }
        appCtx = applicationContext
        speaker = Speaker(this) { type, id -> runOnUiThread { js("window.__adarshTts&&window.__adarshTts(${JSONObject.quote(type)},${JSONObject.quote(id)})") } }
        actions = ActionRunner(this)
        neural = VoiceManager(this) { type, id -> runOnUiThread { js("window.__adarshTts&&window.__adarshTts(${JSONObject.quote(type)},${JSONObject.quote(id)})") } }
        launchTarget = intent?.getStringExtra(UpdateCheckJob.EXTRA_OPEN)
        UpdateCheckJob.schedule(this)
        updater = UpdateManager(this) { value -> runOnUiThread { js("window.__adarshUpdate&&window.__adarshUpdate($value)") } }
        web.addJavascriptInterface(AdarshBridge((application as AdarshApp).keys, Companion::progress, Companion::deliver), "AdarshNative")

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
        if (savedInstanceState == null) load() else web.restoreState(savedInstanceState)
    }

    private fun load() {
        error.visibility = View.GONE
        loading.visibility = View.VISIBLE
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

    /** Notification taps (e.g. "Naya update available") ask the page to open a screen. */
    private var launchTarget: String? = null
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val target = intent.getStringExtra(UpdateCheckJob.EXTRA_OPEN) ?: return
        if (target == UpdateCheckJob.OPEN_UPDATES) js("window.__adarshOpen&&window.__adarshOpen('updates')")
    }
    override fun onResume() {
        super.onResume()
        resumed = true
        awaitingResult = false   // our own permission dialog / picker has closed
        getSystemService(NotificationManager::class.java)?.cancel(REPLY_ID)
        web.onResume()
        flush()   // answers that arrived while the app was in the background
        web.post { if (resumed && !destroyed && pendingBackground != null) backgroundVoiceEvent(resumeBackgroundStart()) }
    }

    override fun onPause() {
        // Screen off / another app: keep the live voice chat going (no-op unless the voice screen armed a config).
        if (!isChangingConfigurations) handoffToBackground()
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
        dictation.destroy()
        speaker?.stopAll(silent = true); neural?.stop()
        val session = live ?: AdarshLive(this) { ev -> js("window.__adarshLive&&window.__adarshLive($ev)") }.also { live = it }
        val out = session.start(cfg)
        js("window.__adarshLive&&window.__adarshLive(${JSONObject().put("type", "state").put("state", out.optString("state", "connecting"))})")
        return out
    }

    override fun onDestroy() {
        destroyed = true
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
        /** M1: true only while the main frame is https://appassets.androidplatform.net (set on the UI/IO thread). */
        @Volatile private var pageTrusted = false
        private fun isAppOrigin(u: Uri?): Boolean = u != null && u.scheme == "https" && u.host == HOST
        /** Called by AdarshBridge before every method; the page also sets CSP frame-src 'none' so no frame can load. */
        fun pageTrusted(): Boolean = pageTrusted && current?.destroyed == false
        private const val REPLY_CHANNEL = "replies"
        private const val REPLY_ID = 8
        @Volatile var current: MainActivity? = null
        @Volatile private var appCtx: Context? = null
        private fun prefs(c: Context) = c.getSharedPreferences("adarsh_ui", Context.MODE_PRIVATE)
        private fun ui(f: (MainActivity) -> Unit) { current?.let { a -> a.runOnUiThread { if (!a.destroyed) f(a) } } }

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
                .put("message", "Gemini API key nahi mili. Settings > API keys me daalo.").toString()
            cfg.put("key", key)
            val session = a.live ?: AdarshLive(a) { ev -> a.js("window.__adarshLive&&window.__adarshLive($ev)") }.also { a.live = it }
            if (session.active()) session.stop()
            if (a.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                a.pendingLive = cfg
                a.askMic { ok ->
                    val pending = a.pendingLive ?: return@askMic
                    a.pendingLive = null
                    if (!ok) { a.js("window.__adarshLive&&window.__adarshLive(${JSONObject().put("type", "error").put("message", "Microphone permission nahi mili.")})"); return@askMic }
                    a.startLiveNow(pending)
                }
                return@onMain JSONObject().put("ok", true).put("state", "permission_required").toString()
            }
            a.startLiveNow(cfg).toString()
        }
        fun liveSendText(text: String): String = onMain {
            JSONObject().put("ok", current?.live?.sendText(text) ?: false).toString()
        }
        fun liveStop(): String = onMain {
            val a = current!!
            a.pendingLive = null
            a.live?.stop()
            JSONObject().put("ok", true).toString()
        }

        // ---- speech out (Speaker.kt). Results come back as window.__adarshTts(type, id)
        fun ttsAvailable(): Boolean = current?.speaker?.let { !it.failed } ?: false
        fun ttsSpeak(id: String, text: String, lang: String, rate: Float) = ui { it.speaker?.speak(id, text, lang, rate) }
        fun ttsPlayFile(id: String, path: String, rate: Float) = ui { it.speaker?.playFile(id, path, rate) }
        fun ttsStop() = ui { it.speaker?.stopAll(silent = true); it.neural?.stop() }
        /** Phone voices the user can choose from (Settings > Voice & language > Phone voice). */
        fun ttsVoices(): String = onMain { current?.speaker?.voiceList() ?: "[]" }
        fun ttsSetVoice(name: String) = ui { it.speaker?.wanted = name.ifBlank { null } }

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
        fun neuralSpeak(id: String, text: String, lang: String, rate: Float) = ui { it.speaker?.stopAll(silent = true); it.neural?.speak(id, text, lang, rate) }
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
            current?.let { a -> a.runOnUiThread { if (!a.destroyed) a.dictation.start(lang, useBnr, functionId, apiKey) } }
        }
        fun speechStop() { current?.let { a -> a.runOnUiThread { if (!a.destroyed) a.dictation.stop() } } }

        /** Dictation -> page. */
        fun speech(type: String, text: String) {
            current?.let { a ->
                a.runOnUiThread {
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
