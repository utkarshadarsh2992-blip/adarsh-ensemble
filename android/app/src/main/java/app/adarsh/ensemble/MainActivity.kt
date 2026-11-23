package app.adarsh.ensemble

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
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
            mediaPlaybackRequiresUserGesture = true
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
        web.onResume()
        flush()   // answers that arrived while the app was in the background
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        destroyed = true
        if (current === this) current = null
        dictation.destroy()
        web.removeJavascriptInterface("AdarshNative")
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val HOST = "appassets.androidplatform.net"
        @Volatile var current: MainActivity? = null

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
            current?.let { a -> a.runOnUiThread { a.flush() } }
        }
    }
}
