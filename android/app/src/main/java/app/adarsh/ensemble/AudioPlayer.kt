package app.adarsh.ensemble

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import java.io.File

/** Ordered clip queue with pause / resume / stop. All work happens on the main thread. */
class AudioPlayer(ctx: Context, private val emit: (String, String) -> Unit) {
    private class Clip(val id: String, val file: File, val last: Boolean)
    private val main = Handler(Looper.getMainLooper())
    private val q = ArrayDeque<Clip>()
    private var mp: MediaPlayer? = null
    private var paused = false
    private var started = false
    private val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()

    fun enqueue(id: String, f: File, last: Boolean) = main.post { q.addLast(Clip(id, f, last)); if (mp == null && !paused) next() }

    private fun next() {
        val c = q.removeFirstOrNull() ?: return
        try {
            val p = MediaPlayer()
            p.setAudioAttributes(attrs)
            p.setDataSource(c.file.absolutePath)
            p.setOnCompletionListener {
                release(); c.file.delete()
                if (c.last) { started = false; emit("done", c.id) }
                if (!paused) next()
            }
            p.setOnErrorListener { _, _, _ -> release(); c.file.delete(); started = false; q.clear(); emit("error", c.id); true }
            p.setOnPreparedListener { if (!paused) it.start(); if (!started) { started = true; emit("start", c.id) } }
            mp = p
            p.prepareAsync()
        } catch (_: Exception) { release(); q.clear(); started = false; emit("error", c.id) }
    }

    private fun release() { mp?.let { try { it.stop() } catch (_: Exception) {}; it.release() }; mp = null }

    fun pause() = main.post { paused = true; try { mp?.pause() } catch (_: Exception) {} }
    fun resume() = main.post { paused = false; val p = mp; if (p != null) try { p.start() } catch (_: Exception) {} else next() }
    fun stop() = main.post { paused = false; started = false; q.forEach { it.file.delete() }; q.clear(); release() }
}
