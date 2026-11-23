package app.adarsh.ensemble

import android.content.Context
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/**
 * V6 offline fallback voice. Sentence by sentence: split -> pick Hindi/English voice -> synthesise -> queue for playback,
 * so the first sentence is heard while the next one is still being made.
 * Events go back through the same window.__adarshTts(type, id) channel as every other voice.
 */
class VoiceManager(private val ctx: Context, emit: (String, String) -> Unit) {
    private val neural = NeuralTTS(ctx)
    private val player = AudioPlayer(ctx, emit)
    private val gen = AtomicInteger(0)
    private val tmp = File(ctx.cacheDir, "neural_clips").apply { mkdirs() }
    private val emitter = emit

    fun ready() = neural.ready()
    fun status() = neural.status()
    fun install(done: (Boolean) -> Unit) = neural.install(done)

    fun speak(id: String, text: String, lang: String, rate: Float) {
        val my = gen.incrementAndGet()
        player.stop()
        if (!neural.ready()) { emitter("error", id); return }
        Thread {
            val parts = sentences(text)
            if (parts.isEmpty()) { emitter("error", id); return@Thread }
            var any = false
            parts.forEachIndexed { i, s ->
                if (gen.get() != my) return@Thread
                val f = File(tmp, "n${my}_$i.wav")
                val ok = try { neural.synth(s, routeLang(s, lang), rate, f) } catch (_: Throwable) { false }
                if (gen.get() != my) { f.delete(); return@Thread }
                if (ok) { any = true; player.enqueue(id, f, i == parts.size - 1) }
                else if (i == parts.size - 1) { if (any) player.enqueue(id, f.also { it.writeBytes(SILENT) }, true) else emitter("error", id) }
            }
        }.start()
    }

    fun pause() = player.pause()
    fun resume() = player.resume()
    fun stop() { gen.incrementAndGet(); player.stop() }
    fun destroy() { stop(); neural.destroy() }

    companion object {
        // 44-byte header + 0 samples: lets the "last" event fire when only the final sentence failed
        private val SILENT = ByteArray(44).also { h ->
            "RIFF".toByteArray().copyInto(h, 0); h[4] = 36; "WAVEfmt ".toByteArray().copyInto(h, 8); h[16] = 16; h[20] = 1; h[22] = 1
            h[24] = 0x40; h[25] = 0x1f; h[28] = (0x80).toByte(); h[29] = 0x3e; h[32] = 2; h[34] = 16; "data".toByteArray().copyInto(h, 36)
        }
        private val ROMAN_HI = ("ka ki ke ko se mein main hai hain ho hota hoti hote tha thi the kya kyun kaise kab kahan kaun kitna yeh ye woh wo aur " +
            "ya lekin par pe nahi nahin mat bhi hi toh to abhi bahut bohot thoda zyada matlab samajh batao bata bol bolo kar karo karna kare kiya " +
            "mera meri mere apna hum tum aap isko usko isme sab ek hoga raha rahi rahe liye wala wale jab agar isliye sakta chahiye accha theek sahi " +
            "galat kuch koi kaam pehle baad sirf bas yahan wahan").split(" ").toHashSet()
        private val WORD = Regex("[A-Za-z\\u0900-\\u097F']+")

        /** 'hi' when the sentence is Devanagari or clearly Roman Hindi, else 'en'. */
        fun routeLang(s: String, pref: String): String {
            if (s.any { it in '\u0900'..'\u097F' }) return "hi"
            val ws = WORD.findAll(s).map { it.value.lowercase() }.toList()
            if (ws.isEmpty()) return if (pref.startsWith("hi")) "hi" else "en"
            val hi = ws.count { it in ROMAN_HI }
            return if (hi * 4 >= ws.size) "hi" else "en"   // >=25% Hindi function words = Hinglish -> Hindi voice
        }

        fun sentences(text: String, max: Int = 220): List<String> {
            val out = ArrayList<String>()
            for (raw in text.split(Regex("(?<=[.!?\u0964\u0965])\\s+|\\n+"))) {
                var s = raw.trim()
                while (s.length > max) {
                    var cut = maxOf(s.lastIndexOf(',', max), s.lastIndexOf(' ', max))
                    if (cut < 40) cut = max
                    out.add(s.substring(0, cut + 1).trim()); s = s.substring(cut + 1).trim()
                }
                if (s.isNotEmpty()) out.add(s)
            }
            return out
        }
    }
}
