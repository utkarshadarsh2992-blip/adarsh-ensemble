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
 * The handshake almost always succeeds; the real answer arrives as a close frame ("API key not valid", "model not
 * found", "not supported for this key"). Those reasons used to be dropped, which looked like "connect nahi ho raha",
 * so every close before `setupComplete` is now reported to the page and the next model in the chain is tried.
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
        private const val PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
        private const val HOST = "wss://generativelanguage.googleapis.com"
        private const val IN_RATE = 16000
        private const val OUT_RATE = 24000
        private const val CHUNK_SAMPLES = IN_RATE / 10          // 100 ms
        private const val MAX_PROMPT = 6000
        private const val SETUP_TIMEOUT_MS = 25_000L
    }

    private val main = Handler(Looper.getMainLooper())
    private val closed = AtomicBoolean(true)

    private var client: OkHttpClient? = null
    private var ws: WebSocket? = null
    private var key = ""
    private var voice = "Orus"
    private var prompt = ""
    private var chain: List<String> = emptyList()
    private var attempt = 0
    private var gotSetup = false
    private var usedHeader = false
    private var lastWhy = ""

    private var recorder: AudioRecord? = null
    private var micThread: Thread? = null
    private var track: AudioTrack? = null
    private var writerThread: Thread? = null
    private val queue = LinkedBlockingQueue<ByteArray>()
    @Volatile private var speaking = false

    private val setupTimeout = Runnable {
        if (!closed.get() && !gotSetup) {
            lastWhy = "server ne setup ka jawab nahi diya"
            tryNext("setup timeout")
        }
    }

    private fun say(obj: JSONObject) {
        main.post { try { emit(obj) } catch (_: Exception) { } }
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
        chain = (listOf(model) + FALLBACK).distinct()
        attempt = 0
        gotSetup = false
        lastWhy = ""
        closed.set(false)
        speaking = false
        queue.clear()
        client = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
        say(JSONObject().put("type", "state").put("state", "connecting").put("model", chain[0]))
        connect()
        return JSONObject().put("ok", true).put("state", "connecting").put("model", chain[0])
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
        val model = chain.getOrElse(attempt) { chain.last() }
        val socket = open(key, header = !usedHeader)
        if (socket == null) {
            lastWhy = "socket khul hi nahi paya"
            say(JSONObject().put("type", "error").put("message", "Live connection nahi khula. Internet check karo."))
            closed.set(true)
            return
        }
        ws = socket
        socket.send(setupJson(model))
        main.removeCallbacks(setupTimeout)
        main.postDelayed(setupTimeout, SETUP_TIMEOUT_MS)
    }

    /** The key travels in a header so it never appears in a URL; the documented `?key=` form is the fallback. */
    private fun open(k: String, header: Boolean): WebSocket? = try {
        val b = Request.Builder().url(HOST + PATH + if (header) "" else "?key=" + k)
        if (header) b.header("x-goog-api-key", k)
        client!!.newWebSocket(b.build(), listener)
    } catch (_: Exception) { null }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) { }

        override fun onMessage(webSocket: WebSocket, text: String) {
            try { handle(JSONObject(text)) } catch (_: Exception) { }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (closed.get()) return
            val code = response?.code ?: 0
            if ((code == 401 || code == 403) && !usedHeader) {   // handshake rejected: retry once in the query form
                usedHeader = true
                connect()
                return
            }
            lastWhy = (t.message ?: "network").take(160)
            tryNext("network/HTTP $code")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // The server explains real failures here ("API key not valid", "model not found", ...).
            if (reason.isNotBlank()) lastWhy = reason.take(300)
            try { webSocket.close(code, null) } catch (_: Exception) { }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (closed.get()) return
            if (reason.isNotBlank()) lastWhy = reason.take(300)
            if (!gotSetup) { tryNext("closed $code"); return }
            finish("Live band ho gaya" + if (reason.isNotBlank()) ": " + reason.take(120) else "")
        }
    }

    /** Next model in the chain, or a readable error if none is left. */
    private fun tryNext(why: String) {
        main.removeCallbacks(setupTimeout)
        if (closed.get()) return
        val detail = if (lastWhy.isNotBlank()) lastWhy else why
        if (attempt + 1 < chain.size) {
            attempt++
            say(JSONObject().put("type", "notice").put("message", "Live: " + detail + " — " + chain[attempt] + " try kar raha hoon."))
            stopAudio()
            try { ws?.close(1000, "retry") } catch (_: Exception) { }
            ws = null
            gotSetup = false
            connect()
            return
        }
        finish("Live nahi chala: " + detail)
    }

    private fun finish(message: String) {
        closed.set(true)
        main.removeCallbacks(setupTimeout)
        stopAudio()
        try { ws?.close(1000, "bye") } catch (_: Exception) { }
        ws = null
        say(JSONObject().put("type", "error").put("message", message))
    }

    private fun handle(obj: JSONObject) {
        if (obj.has("setupComplete")) {
            main.removeCallbacks(setupTimeout)
            gotSetup = true
            say(JSONObject().put("type", "state").put("state", "listening").put("model", chain.getOrElse(attempt) { "" }))
            startMic()
            return
        }
        obj.optJSONObject("error")?.let { err ->
            lastWhy = (err.optString("message").ifBlank { err.toString() }).take(300)
            if (!gotSetup) tryNext("error") else finish("Live error: " + lastWhy)
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
