package app.adarsh.ensemble

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Base64
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Adarsh Live: one Gemini Live (BidiGenerateContent) WebSocket session, spoken both ways.
 *
 * In: 16 kHz 16-bit mono PCM from the microphone, 100 ms chunks, base64 in `realtimeInput.audio`.
 * Out: 24 kHz 16-bit mono PCM from `serverContent.modelTurn.parts[].inlineData.data`, streamed to an AudioTrack.
 * Barge-in: `serverContent.interrupted` drops whatever is still queued, so the model's voice stops at once.
 *
 * The handshake almost always succeeds; the answer arrives afterwards as `setupComplete` or as a close frame
 * ("API key not valid", "model not found", ...). Because the exact endpoint/auth form differs between the v1alpha
 * (Gemini 3.8 Live docs) and v1beta (WebSocket get-started docs) services, every variant is tried once and the
 * per-variant result is kept, so a failure can say *why* instead of sitting on "Connecting…".
 */
class AdarshLive(private val ctx: Context, private val emit: (JSONObject) -> Unit) {

    companion object {
        /** Verified against the Gemini API model list (Nov 2026). Keep in sync with LIVE_MODELS in ui/src/js/05-voice.js. */
        val MODELS = setOf(
            "gemini-3.8-live",
            "gemini-3.8-live-extended-thinking",
            "gemini-2.5-flash-native-audio-preview-12-2025",
            "gemini-3.1-flash-live-preview",
            "gemini-3.5-live-translate-preview",
            "gemini-3.5-transcribe-live"
        )
        /** What each Live model is for; the page asks for a role, the client picks the model. */
        val ROLE_MODEL = mapOf(
            "main" to "gemini-3.8-live",                                   // everyday voice, Jarvis-like
            "think" to "gemini-3.8-live-extended-thinking",                // deep reasoning, auto-upgraded
            "transcribe" to "gemini-3.5-transcribe-live",                  // speech recognition / dictation
            "translate" to "gemini-3.5-live-translate-preview",            // "isko Hindi/English me karo"
            "backup" to "gemini-2.5-flash-native-audio-preview-12-2025",   // backup voice
            "test" to "gemini-3.1-flash-live-preview"                      // backup / testing
        )
        val ROLE_LABEL = mapOf(
            "main" to "Main voice", "think" to "Advanced reasoning", "transcribe" to "Speech recognition",
            "translate" to "Translation", "backup" to "Backup", "test" to "Backup/testing"
        )
        /** v1beta + header first: the documented WebSocket service, verified from the sandbox. */
        private val VARIANTS = listOf(
            Variant("v1beta", true), Variant("v1alpha", true),
            Variant("v1beta", false), Variant("v1alpha", false)
        )
        /** Tried in order when the chosen model is refused for this key. Each is a normal Live dialogue model. */
        private val FALLBACK = listOf("gemini-2.5-flash-native-audio-preview-12-2025", "gemini-3.1-flash-live-preview")
        /** Note the trailing dot: the service name is "google.ai.generativelanguage.<api>.GenerativeService". */
        private const val HOST_NAME = "generativelanguage.googleapis.com"
        private const val HOST = "wss://$HOST_NAME/ws/google.ai.generativelanguage."
        private const val METHOD = ".GenerativeService.BidiGenerateContent"
        private const val IN_RATE = 16000
        private const val OUT_RATE = 24000
        private const val CHUNK_SAMPLES = IN_RATE / 10          // 100 ms
        private const val MAX_PROMPT = 6000
        private const val SETUP_TIMEOUT_MS = 8_000L
        private const val DNS_TIMEOUT_MS = 6_000L

        /** Plain HTTPS check of the same host and key: tells a bad key or blocked network apart from a socket problem. */
        fun probe(ctx: Context, emit: (JSONObject) -> Unit) {
            val key = (ctx.applicationContext as AdarshApp).keys.first("GEMINI_API_KEY")
            val post = Handler(Looper.getMainLooper())
            if (key.isNullOrBlank()) {
                post.post { emit(JSONObject().put("type", "probe").put("message", "Gemini API key nahi mili (Settings > API keys).")) }
                return
            }
            Thread {
                val msg = try {
                    val c = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
                    val req = Request.Builder()
                        .url("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-live")
                        .header("x-goog-api-key", key).build()
                    c.newCall(req).execute().use { r ->
                        if (r.isSuccessful) "key ok · HTTP " + r.code
                        else "HTTP " + r.code + " · " + ((r.body?.string() ?: "").replace("\n", " ").take(120))
                    }
                } catch (e: Exception) { "network: " + (e.message ?: e.javaClass.simpleName) }
                post.post { emit(JSONObject().put("type", "probe").put("message", msg)) }
            }.also { it.isDaemon = true; it.start() }
        }
    }

    /** One endpoint + auth form. v1alpha is what the Gemini 3.8 Live docs use; v1beta is the WebSocket guide. */
    data class Variant(val api: String, val header: Boolean) {
        val label: String get() = api + "/" + (if (header) "header" else "key")
        fun url(key: String) = HOST + api + METHOD + if (header) "" else "?key=" + key
    }

    private val main = Handler(Looper.getMainLooper())
    private val closed = AtomicBoolean(true)

    private var client: OkHttpClient? = null
    private var ws: WebSocket? = null
    private var key = ""
    private var model = ROLE_MODEL.getValue("main")
    private var resumeHandle: String? = null
    private var lastGood: Variant? = null
    private val recent = StringBuilder()   // both sides of the talk, kept so a switch without a handle still has context
    private var voice = "Orus"
    private var prompt = ""
    private var plans: List<Pair<Variant, String>> = emptyList()   // every endpoint/model combination, in order
    private var step = 0
    private var gotSetup = false
    private var lastWhy = ""
    @Volatile private var dnsDone = false
    private val trace = ArrayList<String>()

    private var recorder: AudioRecord? = null
    private var micThread: Thread? = null
    private var track: AudioTrack? = null
    private var writerThread: Thread? = null
    private val queue = LinkedBlockingQueue<ByteArray>()
    @Volatile private var speaking = false

    private val setupTimeout = Runnable {
        if (closed.get() || gotSetup) return@Runnable
        note("timeout")
        next()
    }

    private fun say(obj: JSONObject) {
        main.post { try { emit(obj) } catch (_: Exception) { } }
    }

    private fun note(what: String) {
        val p = plans.getOrNull(step) ?: return
        trace.add(p.first.label + " " + p.second.replace("gemini-", "") + ": " + what)
        while (trace.size > 6) trace.removeAt(0)
    }

    private fun isNetwork(t: Throwable): Boolean =
        t is java.net.UnknownHostException || t is java.net.ConnectException ||
            t is java.net.SocketTimeoutException || t is javax.net.ssl.SSLException || t is java.net.SocketException

    fun active(): Boolean = !closed.get()

    /** cfg: {key, model, voice, prompt}. Returns a status object for the UI; never throws. */
    fun start(cfg: JSONObject): JSONObject {
        if (!closed.get()) stop()
        val k = cfg.optString("key").trim()
        if (k.isEmpty()) return JSONObject().put("ok", false).put("state", "error").put("message", "Gemini API key nahi mili.")
        val asked = cfg.optString("model", "auto").removePrefix("models/")
        val model = if (asked.isBlank() || asked == "auto") ROLE_MODEL.getValue("main") else asked
        if (model !in MODELS) return JSONObject().put("ok", false).put("state", "error").put("message", "Live model id galat hai: $model")
        this.model = model
        resumeHandle = null
        lastGood = null
        recent.setLength(0)
        key = k
        voice = cfg.optString("voice", "Orus").take(40)
        prompt = cfg.optString("prompt").take(MAX_PROMPT)
        // chosen model on every endpoint, then the fallback models on the documented endpoint only: six attempts,
        // and a network failure ends the sweep at once, so the screen never sits on "Connecting…" for a minute.
        plans = VARIANTS.map { v -> v to model } + FALLBACK.map { m -> VARIANTS.first() to m }
        step = 0
        gotSetup = false
        lastWhy = ""
        trace.clear()
        closed.set(false)
        speaking = false
        queue.clear()
        client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
        dnsDone = false
        say(JSONObject().put("type", "state").put("state", "connecting").put("model", model)
            .put("attempt", 1).put("total", plans.size))
        preflight()
        return JSONObject().put("ok", true).put("state", "connecting").put("model", model)
    }

    private fun setupJson(model: String): String {
        val setup = JSONObject()
            .put("model", "models/$model")
            .put("generationConfig", JSONObject()
                .put("responseModalities", JSONArray().put("AUDIO"))
                .put("speechConfig", JSONObject().put("voiceConfig",
                    JSONObject().put("prebuiltVoiceConfig", JSONObject().put("voiceName", voice)))))
            .put("systemInstruction", JSONObject().put("parts", JSONArray().put(JSONObject().put("text", instruction()))))
            .put("inputAudioTranscription", JSONObject())
            .put("outputAudioTranscription", JSONObject())
            .put("sessionResumption", resumeHandle?.let { JSONObject().put("handle", it) } ?: JSONObject())
        return JSONObject().put("setup", setup).toString()
    }

    /**
     * Resolve the host before opening a socket. A dead resolver otherwise costs a full timeout on every attempt and
     * the user just watches "Connecting…", so it is answered in a few seconds with a plain "internet/DNS" message.
     */
    private fun preflight() {
        val watchdog = Runnable {
            if (closed.get() || dnsDone) return@Runnable
            dnsDone = true
            fail("Internet/DNS theek nahi — host resolve nahi hua. Net check karke dobara try karein.")
        }
        main.postDelayed(watchdog, DNS_TIMEOUT_MS)
        Thread {
            val why = try {
                val addrs = java.net.InetAddress.getAllByName(HOST_NAME)
                if (addrs.isEmpty()) "koi address nahi mila" else null
            } catch (e: Exception) { (e.message ?: "DNS").take(90) }
            main.post {
                main.removeCallbacks(watchdog)
                if (closed.get() || dnsDone) return@post
                dnsDone = true
                if (why == null) connect()
                else fail("Internet/DNS theek nahi — " + why + ". Net check karke dobara try karein.")
            }
        }.also { it.isDaemon = true; it.start() }
    }

    /** Stops everything with one plain sentence (used when retrying other endpoints cannot possibly help). */
    private fun fail(message: String) {
        finish(message)
    }

    /** System prompt, plus the recent talk when a model switch could not resume the previous session. */
    private fun instruction(): String {
        val extra = if (resumeHandle != null || recent.isBlank()) "" else
            "\n\nPichli baat (isi conversation se, model badal gaya hai):\n" + recent.takeLast(1200)
        return prompt + extra
    }

    /**
     * Move the live conversation to another model (auto role routing: deep question -> extended thinking,
     * "Hindi me karo" -> translate, dictation -> transcribe). Uses the session resumption handle when the server
     * gave one, otherwise carries the recent transcript so the new model is not blind.
     */
    fun switchTo(asked: String): JSONObject {
        val target = ROLE_MODEL[asked] ?: asked.removePrefix("models/")
        if (target !in MODELS) return JSONObject().put("ok", false).put("message", "unknown live model: " + asked)
        if (closed.get()) return JSONObject().put("ok", false).put("message", "live band hai")
        if (target == model && gotSetup) return JSONObject().put("ok", true).put("model", target).put("same", true)
        model = target
        gotSetup = false
        main.removeCallbacks(setupTimeout)
        val old = ws
        ws = null
        try { old?.close(1000, "switch") } catch (_: Exception) { }
        stopAudio()
        val order = listOfNotNull(lastGood) + VARIANTS.filter { it != lastGood }
        plans = order.map { it to target }
        step = 0
        trace.clear()
        say(JSONObject().put("type", "state").put("state", "connecting").put("model", target)
            .put("attempt", 1).put("total", plans.size))
        connect()
        return JSONObject().put("ok", true).put("model", target)
    }

    private fun connect() {
        val plan = plans.getOrNull(step)
        if (plan == null) { finish(); return }
        val (variant, model) = plan
        val request = try {
            val b = Request.Builder().url(variant.url(key))
            if (variant.header) b.header("x-goog-api-key", key)
            b.build()
        } catch (_: Exception) { note("url"); next(); return }
        val socket = try { client!!.newWebSocket(request, listener) } catch (_: Exception) { null }
        if (socket == null) { note("socket"); next(); return }
        ws = socket
        say(JSONObject().put("type", "state").put("state", "connecting").put("model", model)
            .put("endpoint", variant.label).put("attempt", step + 1).put("total", plans.size))
        socket.send(setupJson(model))
        main.removeCallbacks(setupTimeout)
        main.postDelayed(setupTimeout, SETUP_TIMEOUT_MS)
    }

    /** Next endpoint/model. Called from the socket callbacks (OkHttp threads) or the main-thread timer. */
    private fun next() {
        main.post {
            if (closed.get()) return@post
            main.removeCallbacks(setupTimeout)
            if (gotSetup) return@post
            stopAudio()
            try { ws?.close(1000, "retry") } catch (_: Exception) { }
            ws = null
            step++
            if (step >= plans.size) { finish(); return@post }
            connect()
        }
    }

    private fun finish(message: String? = null) {
        if (closed.getAndSet(true)) return
        main.removeCallbacks(setupTimeout)
        stopAudio()
        try { ws?.close(1000, "bye") } catch (_: Exception) { }
        ws = null
        val detail = message ?: if (trace.isEmpty()) (lastWhy.ifBlank { "koi jawab nahi aaya" })
        else trace.takeLast(3).joinToString(" | ")
        say(JSONObject().put("type", "error").put("message", "Live nahi chala — " + detail.take(600)))
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (webSocket !== ws) return
            note("open")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (webSocket !== ws) return   // a socket replaced by the fallback must not speak any more
            try { handle(JSONObject(text)) } catch (_: Exception) { }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (closed.get() || webSocket !== ws) return
            lastWhy = (t.message ?: "network").take(160)
            // no endpoint can help when the network itself is down: say it now instead of timing out five more times
            if ((response == null || response.code <= 0) && isNetwork(t)) {
                main.post { if (!closed.get()) fail("Internet/DNS theek nahi — " + lastWhy.take(90) + ". Net check karke dobara try karein.") }
                return
            }
            note("fail " + (response?.code?.takeIf { it > 0 }?.toString() ?: lastWhy))
            next()
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            if (webSocket !== ws) return
            // The server explains real failures here ("API key not valid", "model not found", ...).
            if (reason.isNotBlank()) lastWhy = reason.take(300)
            note("close $code " + reason.take(80))
            try { webSocket.close(code, null) } catch (_: Exception) { }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (closed.get() || webSocket !== ws) return
            if (reason.isNotBlank()) lastWhy = reason.take(300)
            if (!gotSetup) { next(); return }
            finish()
        }
    }

    private fun handle(obj: JSONObject) {
        if (obj.has("setupComplete")) {
            main.removeCallbacks(setupTimeout)
            gotSetup = true
            lastGood = plans.getOrNull(step)?.first ?: lastGood
            val model = plans.getOrNull(step)?.second ?: ""
            say(JSONObject().put("type", "role").put("role", roleOf(model)).put("label", ROLE_LABEL[roleOf(model)] ?: "").put("model", model))
            say(JSONObject().put("type", "state").put("state", "listening").put("model", model).put("role", roleOf(model)))
            startMic()
            return
        }
        obj.optJSONObject("error")?.let { err ->
            lastWhy = (err.optString("message").ifBlank { err.toString() }).take(300)
            note("error " + lastWhy.take(80))
            if (!gotSetup) next() else finish()
            return
        }
        obj.optJSONObject("sessionResumptionUpdate")?.let { up ->
            val h = up.optString("newHandle")
            if (up.optBoolean("resumable") && h.isNotBlank()) resumeHandle = h
        }
        val sc = obj.optJSONObject("serverContent") ?: return
        if (sc.optBoolean("interrupted")) { queue.clear(); try { track?.pause(); track?.flush() } catch (_: Exception) { }; speaking = false }
        sc.optJSONObject("inputTranscription")?.optString("text")?.takeIf { it.isNotBlank() }?.let {
            remember("Sir: " + it)
            say(JSONObject().put("type", "user").put("text", it))
        }
        sc.optJSONObject("outputTranscription")?.optString("text")?.takeIf { it.isNotBlank() }?.let {
            remember("Adarsh: " + it)
            say(JSONObject().put("type", "model").put("text", it))
        }
        val parts = sc.optJSONObject("modelTurn")?.optJSONArray("parts")
        if (parts != null) {
            for (i in 0 until parts.length()) {
                val data = parts.optJSONObject(i)?.optJSONObject("inlineData")?.optString("data")
                if (!data.isNullOrBlank()) {
                    val pcm = try { Base64.decode(data, Base64.DEFAULT) } catch (_: Exception) { null } ?: continue
                    if (pcm.isNotEmpty()) {
                        queue.offer(pcm)
                        ensureWriter()
                        if (!speaking) { speaking = true; say(JSONObject().put("type", "state").put("state", "speaking")) }
                    }
                }
            }
        }
        if (sc.optBoolean("turnComplete")) {
            speaking = false
            say(JSONObject().put("type", "state").put("state", "listening"))
        }
    }

    private fun roleOf(m: String): String = ROLE_MODEL.entries.firstOrNull { it.value == m }?.key ?: "main"

    private fun remember(line: String) {
        recent.append(if (recent.isEmpty()) line else " " + line)
        if (recent.length > 2000) recent.delete(0, recent.length - 2000)
    }

    private fun startMic() {
        if (micThread != null) return
        val min = AudioRecord.getMinBufferSize(IN_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val size = maxOf(min, CHUNK_SAMPLES * 2 * 4)
        val r = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, IN_RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, size)
        } catch (_: Exception) { null } ?: return
        if (r.state != AudioRecord.STATE_INITIALIZED) { try { r.release() } catch (_: Exception) { }; return }
        recorder = r
        try { r.startRecording() } catch (_: Exception) { return }
        val t = Thread {
            val buf = ShortArray(CHUNK_SAMPLES)
            val bytes = ByteArray(CHUNK_SAMPLES * 2)
            while (!closed.get()) {
                val n = try { r.read(buf, 0, buf.size) } catch (_: Exception) { -1 }
                if (n <= 0) { if (n < 0) break else continue }
                var j = 0
                for (i in 0 until n) {
                    val v = buf[i].toInt()
                    bytes[j++] = (v and 0xFF).toByte()
                    bytes[j++] = ((v shr 8) and 0xFF).toByte()
                }
                val chunk = bytes.copyOf(j)
                val msg = JSONObject().put("realtimeInput", JSONObject().put("audio", JSONObject()
                    .put("data", Base64.encodeToString(chunk, Base64.NO_WRAP))
                    .put("mimeType", "audio/pcm;rate=$IN_RATE")))
                if (!closed.get()) try { ws?.send(msg.toString()) } catch (_: Exception) { break }
            }
            try { r.stop() } catch (_: Exception) { }
            try { r.release() } catch (_: Exception) { }
        }
        t.isDaemon = true
        t.start()
        micThread = t
    }

    private fun ensureWriter() {
        if (writerThread != null) return
        val t = Thread {
            val min = AudioTrack.getMinBufferSize(OUT_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val tr = try {
                AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setAudioFormat(AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(OUT_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(maxOf(min, OUT_RATE / 2))
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build()
            } catch (_: Exception) { null } ?: return@Thread
            track = tr
            try { tr.play() } catch (_: Exception) { }
            while (!closed.get() || queue.isNotEmpty()) {
                val pcm = try { queue.poll(200, TimeUnit.MILLISECONDS) } catch (_: Exception) { null } ?: continue
                try { tr.write(pcm, 0, pcm.size) } catch (_: Exception) { break }
            }
            try { tr.stop() } catch (_: Exception) { }
            try { tr.release() } catch (_: Exception) { }
        }
        t.isDaemon = true
        t.start()
        writerThread = t
    }

    /** Typed turn on the same live session (no new connection, no mic). */
    fun sendText(text: String): Boolean {
        val socket = ws ?: return false
        if (text.isBlank() || !gotSetup) return false
        val msg = JSONObject().put("clientContent", JSONObject()
            .put("turns", JSONArray().put(JSONObject().put("role", "user")
                .put("parts", JSONArray().put(JSONObject().put("text", text.take(2000))))))
            .put("turnComplete", true))
        return try { socket.send(msg.toString()); true } catch (_: Exception) { false }
    }

    private fun stopAudio() {
        queue.clear()
        try { track?.pause(); track?.flush() } catch (_: Exception) { }
    }

    fun stop() {
        main.removeCallbacks(setupTimeout)
        if (closed.getAndSet(true)) return
        try { ws?.close(1000, "bye") } catch (_: Exception) { }
        ws = null
        stopAudio()
        micThread = null
        writerThread = null
        try { client?.dispatcher?.executorService?.shutdown() } catch (_: Exception) { }
        client = null
        track = null
        recorder = null
        say(JSONObject().put("type", "closed").put("code", 1000))
    }
}
