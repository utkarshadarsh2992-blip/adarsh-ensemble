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
        /** Tried in order when the chosen model is refused for this key. Each is a normal Live dialogue model. */
        private val FALLBACK = listOf("gemini-2.5-flash-native-audio-preview-12-2025", "gemini-3.1-flash-live-preview")
        private const val HOST = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage"
        private const val METHOD = ".GenerativeService.BidiGenerateContent"
        private const val IN_RATE = 16000
        private const val OUT_RATE = 24000
        private const val CHUNK_SAMPLES = IN_RATE / 10          // 100 ms
        private const val MAX_PROMPT = 6000
        private const val SETUP_TIMEOUT_MS = 12_000L

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
    private data class Variant(val api: String, val header: Boolean) {
        val label: String get() = api + "/" + (if (header) "header" else "key")
        fun url(key: String) = HOST + api + METHOD + if (header) "" else "?key=" + key
    }

    private val main = Handler(Looper.getMainLooper())
    private val closed = AtomicBoolean(true)

    private var client: OkHttpClient? = null
    private var ws: WebSocket? = null
    private var key = ""
    private var voice = "Orus"
    private var prompt = ""
    private var plans: List<Pair<Variant, String>> = emptyList()   // every endpoint/model combination, in order
    private var step = 0
    private var gotSetup = false
    private var lastWhy = ""
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

    fun active(): Boolean = !closed.get()

    /** cfg: {key, model, voice, prompt}. Returns a status object for the UI; never throws. */
    fun start(cfg: JSONObject): JSONObject {
        if (!closed.get()) stop()
        val k = cfg.optString("key").trim()
        if (k.isEmpty()) return JSONObject().put("ok", false).put("state", "error").put("message", "Gemini API key nahi mili.")
        val model = cfg.optString("model", "gemini-3.8-live").removePrefix("models/")
        if (model !in MODELS) return JSONObject().put("ok", false).put("state", "error").put("message", "Live model id galat hai: $model")
        key = k
        voice = cfg.optString("voice", "Orus").take(40)
        prompt = cfg.optString("prompt").take(MAX_PROMPT)
        val variants = listOf(
            Variant("v1alpha", true), Variant("v1beta", true),
            Variant("v1alpha", false), Variant("v1beta", false)
        )
        // chosen model on every endpoint first, then the fallback models; at most 8 attempts (~12 s each at worst)
        plans = (listOf(model) + FALLBACK).flatMap { m -> variants.map { v -> v to m } }.take(8)
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
        say(JSONObject().put("type", "state").put("state", "connecting").put("model", model))
        connect()
        return JSONObject().put("ok", true).put("state", "connecting").put("model", model)
    }

    private fun setupJson(model: String): String {
        val setup = JSONObject()
            .put("model", "models/$model")
            .put("generationConfig", JSONObject()
                .put("responseModalities", JSONArray().put("AUDIO"))
                .put("speechConfig", JSONObject().put("voiceConfig",
                    JSONObject().put("prebuiltVoiceConfig", JSONObject().put("voiceName", voice)))))
            .put("systemInstruction", JSONObject().put("parts", JSONArray().put(JSONObject().put("text", prompt))))
            .put("inputAudioTranscription", JSONObject())
            .put("outputAudioTranscription", JSONObject())
        return JSONObject().put("setup", setup).toString()
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

    private fun finish() {
        if (closed.getAndSet(true)) return
        main.removeCallbacks(setupTimeout)
        stopAudio()
        try { ws?.close(1000, "bye") } catch (_: Exception) { }
        ws = null
        val detail = if (trace.isEmpty()) (lastWhy.ifBlank { "koi jawab nahi aaya" }) else trace.joinToString(" | ")
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
            val model = plans.getOrNull(step)?.second ?: ""
            say(JSONObject().put("type", "state").put("state", "listening").put("model", model))
            startMic()
            return
        }
        obj.optJSONObject("error")?.let { err ->
            lastWhy = (err.optString("message").ifBlank { err.toString() }).take(300)
            note("error " + lastWhy.take(80))
            if (!gotSetup) next() else finish()
            return
        }
        val sc = obj.optJSONObject("serverContent") ?: return
        if (sc.optBoolean("interrupted")) { queue.clear(); try { track?.pause(); track?.flush() } catch (_: Exception) { }; speaking = false }
        sc.optJSONObject("inputTranscription")?.optString("text")?.takeIf { it.isNotBlank() }?.let {
            say(JSONObject().put("type", "user").put("text", it))
        }
        sc.optJSONObject("outputTranscription")?.optString("text")?.takeIf { it.isNotBlank() }?.let {
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
