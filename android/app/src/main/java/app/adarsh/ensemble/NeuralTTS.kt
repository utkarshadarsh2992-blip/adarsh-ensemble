package app.adarsh.ensemble

import android.content.Context
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Offline neural voice (Piper VITS models run by sherpa-onnx). Works with no internet and no API key once the
 * two small int8 voice packs (~21 MB each: Hindi "rohan", English "ryan", both male) are downloaded once.
 * It is only a fallback: the page asks for it after the natural (Gemini) voice failed, before the phone's own voice.
 */
class NeuralTTS(ctx: Context) {
    private val root = File(ctx.filesDir, "neural")
    private val engines = HashMap<String, OfflineTts>()
    @Volatile var installing = false
        private set
    @Volatile var progress = 0
        private set
    @Volatile var lastError = ""
        private set

    fun installed(lang: String) = PACKS[lang]?.let { File(root, "$it/.ok").exists() } ?: false
    fun ready() = installed("hi") || installed("en")

    fun status(): String =
        """{"hi":${installed("hi")},"en":${installed("en")},"installing":$installing,"progress":$progress,"error":${org.json.JSONObject.quote(lastError)}}"""

    /** Download + unpack the missing packs once (background thread). */
    fun install(done: (Boolean) -> Unit) {
        if (installing) return
        installing = true; progress = 0; lastError = ""
        Thread {
            var ok = true
            try {
                val todo = PACKS.filter { !installed(it.key) }.values.toList()
                todo.forEachIndexed { i, pack ->
                    fetch(pack) { p -> progress = ((i * 100 + p) / todo.size) }
                }
                progress = 100
            } catch (e: Exception) {
                ok = false; lastError = (e.message ?: e.javaClass.simpleName).take(120)
            } finally {
                installing = false
            }
            done(ok)
        }.start()
    }

    private class Counting(i: InputStream, val onBytes: (Long) -> Unit) : FilterInputStream(i) {
        private var n = 0L
        override fun read(): Int { val r = super.read(); if (r >= 0) onBytes(++n); return r }
        override fun read(b: ByteArray, off: Int, len: Int): Int { val r = super.read(b, off, len); if (r > 0) { n += r; onBytes(n) }; return r }
    }

    private fun fetch(pack: String, onPercent: (Int) -> Unit) {
        root.mkdirs()
        val c = URL(BASE + pack + ".tar.bz2").openConnection() as HttpURLConnection
        c.connectTimeout = 20000; c.readTimeout = 30000; c.instanceFollowRedirects = true
        if (c.responseCode !in 200..299) throw RuntimeException("download HTTP ${c.responseCode}")
        val total = c.contentLengthLong.takeIf { it > 0 } ?: 22_000_000L
        val target = File(root, pack); target.deleteRecursively()
        val canon = root.canonicalPath
        Counting(c.inputStream.buffered(), { n -> onPercent((n * 100 / total).toInt().coerceIn(0, 99)) }).use { raw ->
            TarArchiveInputStream(BZip2CompressorInputStream(raw)).use { tar ->
                while (true) {
                    val e = tar.nextTarEntry ?: break
                    val out = File(root, e.name)
                    if (!out.canonicalPath.startsWith(canon)) continue   // never write outside our folder
                    if (e.isDirectory) out.mkdirs() else { out.parentFile?.mkdirs(); out.outputStream().use { tar.copyTo(it) } }
                }
            }
        }
        if (File(target, "tokens.txt").exists()) File(target, ".ok").writeText("1")
        else throw RuntimeException("pack incomplete")
    }

    private fun engine(lang: String): OfflineTts? = synchronized(engines) {
        engines[lang]?.let { return it }
        val pack = PACKS[lang] ?: return null
        val dir = File(root, pack)
        if (!File(dir, ".ok").exists()) return null
        val model = dir.listFiles { f -> f.name.endsWith(".onnx") }?.firstOrNull() ?: return null
        val cfg = OfflineTtsConfig(model = OfflineTtsModelConfig(
            vits = OfflineTtsVitsModelConfig(model = model.absolutePath, tokens = File(dir, "tokens.txt").absolutePath,
                dataDir = File(dir, "espeak-ng-data").absolutePath),
            numThreads = 2, debug = false, provider = "cpu"))
        val t = OfflineTts(config = cfg)
        engines[lang] = t
        t
    }

    /** One sentence -> 16-bit mono WAV file. Falls back to the other language's voice when this one is not installed. */
    fun synth(text: String, lang: String, rate: Float, out: File): Boolean {
        val order = if (lang == "hi") listOf("hi", "en") else listOf("en", "hi")
        for (l in order) {
            val e = try { engine(l) } catch (_: Throwable) { null } ?: continue
            val a = try { e.generate(text, 0, rate.coerceIn(0.5f, 2.0f)) } catch (_: Throwable) { continue }
            if (a.samples.isEmpty()) continue
            writeWav(out, a.samples, a.sampleRate)
            return true
        }
        return false
    }

    private fun writeWav(f: File, s: FloatArray, rate: Int) {
        val pcm = ByteArray(s.size * 2)
        for (i in s.indices) {
            val v = (s[i] * 32767f).toInt().coerceIn(-32768, 32767)
            pcm[2 * i] = (v and 0xff).toByte(); pcm[2 * i + 1] = ((v shr 8) and 0xff).toByte()
        }
        fun le(v: Int) = byteArrayOf(v.toByte(), (v shr 8).toByte(), (v shr 16).toByte(), (v shr 24).toByte())
        f.outputStream().use {
            it.write("RIFF".toByteArray()); it.write(le(36 + pcm.size)); it.write("WAVEfmt ".toByteArray())
            it.write(le(16)); it.write(byteArrayOf(1, 0, 1, 0)); it.write(le(rate)); it.write(le(rate * 2))
            it.write(byteArrayOf(2, 0, 16, 0)); it.write("data".toByteArray()); it.write(le(pcm.size)); it.write(pcm)
        }
    }

    fun destroy() = synchronized(engines) { engines.values.forEach { try { it.release() } catch (_: Throwable) {} }; engines.clear() }

    companion object {
        private const val BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
        val PACKS = linkedMapOf(
            "hi" to "vits-piper-hi_IN-rohan-medium-int8",
            "en" to "vits-piper-en_US-ryan-medium-int8"
        )
    }
}
