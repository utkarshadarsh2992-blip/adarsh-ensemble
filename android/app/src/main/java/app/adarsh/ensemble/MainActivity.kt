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
    ) { /* the service still runs without it; only the notification is hidden */ }

    private var micCallback: ((Boolean) -> Unit)? = null
    private val micPermission = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission()
    ) { ok -> micCallback?.invoke(ok); micCallback = null }
    private val dictation by lazy { Dictation(this) }
    private var speaker: Speaker? = null
    private var neural: VoiceManager? = null
    private var actions: ActionRunner? = null
    @Volatile private var resumed = false
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

    /** Ask for the microphone (the system dialog) and report the answer. Used the first time voice typing starts. */
    fun askMic(cb: (Boolean) -> Unit) { micCallback = cb; micPermission.launch(Manifest.permission.RECORD_AUDIO) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        loading = findViewById(R.id.loading)
        error = findViewById(R.id.error)
        findViewById<Button>(R.id.retry).setOnClickListener { load() }

        val loader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
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
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

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
                return try { filePicker.launch(Intent.createChooser(i, null)); true } catch (_: ActivityNotFoundException) {
                    fileCallback = null; cb.onReceiveValue(null); false
                }
            }
        }
        appCtx = applicationContext
        speaker = Speaker(this) { type, id -> runOnUiThread { js("window.__adarshTts&&window.__adarshTts(${JSONObject.quote(type)},${JSONObject.quote(id)})") } }
        actions = ActionRunner(this)
        neural = VoiceManager(this) { type, id -> runOnUiThread { js("window.__adarshTts&&window.__adarshTts(${JSONObject.quote(type)},${JSONObject.quote(id)})") } }
        web.addJavascriptInterface(AdarshBridge((application as AdarshApp).keys, Companion::progress, Companion::deliver), "AdarshNative")

        // Back never closes the app mid-request: it sends it to the background.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // an open "Kisne kya socha" page closes first; otherwise the app goes to the background
                web.evaluateJavascript("(window.__adarshBack&&window.__adarshBack())") { r ->
                    if (r != "true") moveTaskToBack(true)
                }
            }
        })

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)

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

    override fun onResume() {
        super.onResume()
        resumed = true
        getSystemService(NotificationManager::class.java)?.cancel(REPLY_ID)
        web.onResume()
        flush()   // answers that arrived while the app was in the background
    }

    override fun onPause() {
        resumed = false
        super.onPause()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        destroyed = true
        if (current === this) current = null
        dictation.destroy()
        speaker?.destroy()
        neural?.destroy()
        web.removeJavascriptInterface("AdarshNative")
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val HOST = "appassets.androidplatform.net"
        private const val REPLY_CHANNEL = "replies"
        private const val REPLY_ID = 8
        @Volatile var current: MainActivity? = null
        @Volatile private var appCtx: Context? = null
        private fun prefs(c: Context) = c.getSharedPreferences("adarsh_ui", Context.MODE_PRIVATE)
        private fun ui(f: (MainActivity) -> Unit) { current?.let { a -> a.runOnUiThread { if (!a.destroyed) f(a) } } }

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
            if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return block()
            var out = """{"error":"timeout"}"""
            val latch = java.util.concurrent.CountDownLatch(1)
            a.runOnUiThread { try { out = block() } finally { latch.countDown() } }
            latch.await(6, java.util.concurrent.TimeUnit.SECONDS)
            return out
        }

        fun runActions(json: String): String = onMain {
            try {
                val req = JSONObject(json)
                val mode = if (!req.has("mode") || req.isNull("mode")) "standard" else req.opt("mode")
                if (mode !is String || mode != "standard") {
                    return@onMain JSONObject().put("ok", false).put("error", "Native actions require mode=standard").put("results", org.json.JSONArray()).toString()
                }
                val confirmed = if (!req.has("confirmed") || req.isNull("confirmed")) false else {
                    if (req.opt("confirmed") !is Boolean) return@onMain JSONObject().put("ok", false).put("error", "confirmed must be boolean").toString()
                    req.getBoolean("confirmed")
                }
                val steps = req.optJSONArray("steps") ?: return@onMain JSONObject().put("ok", false).put("error", "steps must be an array").toString()
                val results = org.json.JSONArray()
                for (i in 0 until steps.length()) {
                    val step = steps.optJSONObject(i)
                        ?: return@onMain JSONObject().put("ok", false).put("error", "steps[$i] must be an object").toString()
                    results.put(current!!.actions!!.run(step, confirmed))
                }
                JSONObject().put("ok", true).put("results", results).toString()
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName).toString()
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
        fun haptic(ms: Int) = ui {
            it.web.performHapticFeedback(if (ms >= 25) HapticFeedbackConstants.LONG_PRESS else HapticFeedbackConstants.VIRTUAL_KEY)
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
            try { a.saver.launch(name) } catch (_: Exception) { a.pendingSave = null; a.js("window.__adarshSaved&&window.__adarshSaved(false)") }
        }

        // ---- reply notifications: the WebView has no Notification API, so the app posts them itself
        /** "granted" | "asked" (system dialog shown) | "denied" | "off" */
        fun setNotify(on: Boolean): String {
            val c = appCtx ?: return "denied"
            prefs(c).edit().putBoolean("notify", on).apply()
            if (!on) return "off"
            if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ui { it.notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }
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

        fun speechStart(lang: String) { current?.let { a -> a.runOnUiThread { if (!a.destroyed) a.dictation.start(lang) } } }
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
