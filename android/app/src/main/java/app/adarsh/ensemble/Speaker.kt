package app.adarsh.ensemble

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.io.File
import java.util.Locale

/**
 * Speech out. The WebView has no speechSynthesis, so the page speaks through here:
 *  - speak(): Android TextToSpeech with the best installed voice for the language (network / high quality first)
 *  - playFile(): a natural-voice WAV made by the engine (Gemini TTS), played with MediaPlayer
 * Events go back to the page as window.__adarshTts(type, id): "start", "done", "error".
 */
class Speaker(private val ctx: Context, private val emit: (String, String) -> Unit) {
    private var tts: TextToSpeech? = null
    @Volatile private var ready = false
    /** TextToSpeech could not start (no engine installed): the page then uses only the natural voice. */
    @Volatile var failed = false
        private set
    private var player: MediaPlayer? = null
    private val queue = ArrayList<Pair<String, Runnable>>()
    private val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private var focus: AudioFocusRequest? = null

    init {
        tts = TextToSpeech(ctx.applicationContext) { status ->
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
                tts?.setAudioAttributes(attrs)
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(id: String) { if (!id.contains("#")) emit("start", id) }
                    override fun onDone(id: String) { if (id.endsWith("#last") || !id.contains("#")) end(id.substringBefore("#"), "done") }
                    @Deprecated("Deprecated in Java") override fun onError(id: String) { end(id.substringBefore("#"), "error") }
                    override fun onError(id: String, code: Int) { end(id.substringBefore("#"), "error") }
                    override fun onStop(id: String, interrupted: Boolean) { end(id.substringBefore("#"), "stopped") }
                })
                val jobs = synchronized(queue) { val j = queue.toList(); queue.clear(); j }
                jobs.forEach { it.second.run() }
            } else {
                failed = true
                val jobs = synchronized(queue) { val j = queue.toList(); queue.clear(); j }
                jobs.forEach { emit("error", it.first) }
            }
        }
    }

    fun available(): Boolean = ready

    private fun end(id: String, type: String) {
        releaseFocus()
        emit(type, id)
    }

    private fun takeFocus() {
        val f = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs).build()
        focus = f
        audio.requestAudioFocus(f)
    }

    private fun releaseFocus() { focus?.let { audio.abandonAudioFocusRequest(it) }; focus = null }

    /** Best installed voice for this locale: not network-only when offline is likely, highest quality, lowest latency. */
    private fun pickVoice(loc: Locale): Voice? {
        val all = try { tts?.voices } catch (_: Exception) { null } ?: return null
        val same = all.filter { it.locale.language == loc.language && !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
        if (same.isEmpty()) return null
        return same.sortedWith(
            compareByDescending<Voice> { it.locale.country == loc.country }
                .thenByDescending { it.quality }
                .thenBy { it.latency }
                .thenBy { it.isNetworkConnectionRequired }
        ).first()
    }

    private fun localeFor(lang: String, text: String): Locale {
        // Devanagari script needs a Hindi voice; Roman-script Hinglish reads best with an Indian English voice.
        if (text.any { it in '\u0900'..'\u097F' }) return Locale("hi", "IN")
        return when (lang) {
            "hi-IN" -> Locale("en", "IN")
            "en-US" -> Locale.US
            else -> Locale("en", "IN")
        }
    }

    fun speak(id: String, text: String, lang: String, rate: Float) {
        val job = Runnable {
            stopPlayer()
            val t = tts
            if (t == null) { emit("error", id); return@Runnable }
            val loc = localeFor(lang, text)
            val v = pickVoice(loc)
            if (v != null) t.voice = v else t.language = loc
            t.setSpeechRate(rate.coerceIn(0.5f, 2.0f))
            t.setPitch(0.97f)   // a touch lower reads as calmer and more confident
            takeFocus()
            val parts = splitText(text, TextToSpeech.getMaxSpeechInputLength() - 50)
            val params = Bundle()
            parts.forEachIndexed { i, p ->
                val uid = if (parts.size == 1) id else if (i == parts.size - 1) "$id#last" else "$id#$i"
                val mode = if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
                t.speak(p, mode, params, uid)
            }
            if (parts.size > 1) emit("start", id)
        }
        when {
            failed -> emit("error", id)
            ready -> job.run()
            else -> {
                val now = synchronized(queue) { if (!ready) { queue.add(Pair(id, job)); false } else true }
                if (now) job.run()
            }
        }
    }

    fun playFile(id: String, path: String, rate: Float) {
        stopAll(silent = true)
        val f = File(path)
        if (!f.exists()) { emit("error", id); return }
        try {
            val mp = MediaPlayer()
            mp.setAudioAttributes(attrs)
            mp.setDataSource(f.absolutePath)
            mp.setOnPreparedListener {
                takeFocus()
                if (rate != 1f) try { it.playbackParams = it.playbackParams.setSpeed(rate.coerceIn(0.5f, 2.0f)) } catch (_: Exception) {}
                it.start(); emit("start", id)
            }
            mp.setOnCompletionListener { stopPlayer(); end(id, "done") }
            mp.setOnErrorListener { _, _, _ -> stopPlayer(); end(id, "error"); true }
            player = mp
            mp.prepareAsync()
        } catch (e: Exception) {
            stopPlayer(); emit("error", id)
        }
    }

    private fun stopPlayer() {
        player?.let { try { it.stop() } catch (_: Exception) {}; it.release() }
        player = null
    }

    fun stopAll(silent: Boolean = false) {
        stopPlayer()
        try { tts?.stop() } catch (_: Exception) {}
        releaseFocus()
        if (!silent) emit("stopped", "")
    }

    fun destroy() {
        stopAll(silent = true)
        tts?.shutdown()
        tts = null
    }

    private fun splitText(text: String, max: Int): List<String> {
        if (text.length <= max) return listOf(text)
        val out = ArrayList<String>()
        var rest = text
        while (rest.length > max) {
            var cut = rest.lastIndexOfAny(charArrayOf('.', '?', '!', '।'), max)
            if (cut < max / 2) cut = rest.lastIndexOf(' ', max)
            if (cut <= 0) cut = max
            out.add(rest.substring(0, cut + 1).trim())
            rest = rest.substring(cut + 1)
        }
        if (rest.isNotBlank()) out.add(rest.trim())
        return out
    }
}
