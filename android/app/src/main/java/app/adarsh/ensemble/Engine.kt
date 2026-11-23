package app.adarsh.ensemble

import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** Owns the embedded Python runtime and runs every request off the main thread. */
object Engine {
    private val pool = Executors.newCachedThreadPool()
    private val started = CountDownLatch(1)
    private val inFlight = AtomicInteger(0)
    private val cancelled = ConcurrentHashMap.newKeySet<String>()
    private lateinit var app: Application
    private var entry: PyObject? = null

    @Volatile var ready = false
        private set
    @Volatile var startError: String? = null
        private set

    /** Replies that finished while no screen was attached. Delivered when the activity comes back. */
    val undelivered = ConcurrentHashMap<String, Pair<String?, String?>>()

    fun start(application: Application, keys: SecureKeys) {
        app = application
        pool.execute {
            try {
                if (!Python.isStarted()) Python.start(AndroidPlatform(application))
                val mod = Python.getInstance().getModule("android_entry")
                mod.callAttr("init", application.filesDir.resolve("engine").absolutePath)
                for (n in SecureKeys.NAMES) keys.get(n)?.let { mod.callAttr("set_key", n, it) }
                entry = mod
                ready = true
            } catch (t: Throwable) {
                startError = t.javaClass.simpleName + ": " + (t.message ?: "")
            } finally {
                started.countDown()
            }
        }
    }

    fun status(): String {
        val e = entry
        if (!ready || e == null) {
            val err = startError?.replace("\"", "'")?.replace("\n", " ") ?: ""
            return """{"ready":false,"error":"$err"}"""
        }
        return e.callAttr("status").toString()
    }

    fun setKey(name: String, value: String) {
        started.await()
        entry?.callAttr("set_key", name, value)
    }

    /** Lessons list/add/edit/delete: a quick file operation in Python. No model call, so no foreground service. */
    fun lessons(opJson: String): String {
        return try {
            started.await()
            val e = entry ?: return """{"ok":false,"error":"Engine start nahi hua."}"""
            e.callAttr("lessons", opJson).toString()
        } catch (t: Throwable) {
            """{"ok":false,"error":"Lessons error."}"""
        }
    }

    fun submit(
        id: String, requestJson: String, onProgress: (String) -> Unit, foreground: Boolean = true,
        onDone: (String?, String?) -> Unit
    ) {
        if (foreground && inFlight.getAndIncrement() == 0) setForeground(true)
        pool.execute {
            var result: String? = null
            var error: String? = null
            try {
                started.await()
                val e = entry ?: throw IllegalStateException(startError ?: "Engine did not start")
                val progress = java.util.function.Consumer<String> { msg -> onProgress(msg) }
                result = e.callAttr("handle", requestJson, progress).toString()
            } catch (t: Throwable) {
                // Never include the request body here: it can contain the user's text.
                error = "Engine error: " + (t.message ?: t.javaClass.simpleName)
            } finally {
                if (foreground && inFlight.decrementAndGet() == 0) setForeground(false)
            }
            if (!cancelled.remove(id)) onDone(result, error)
        }
    }

    /** Python cannot be interrupted safely mid-request; the answer is simply dropped when it arrives. */
    fun cancel(id: String) { cancelled.add(id) }

    // A foreground service keeps the process alive while a long multi-model request runs in the background.
    private fun setForeground(on: Boolean) {
        try {
            val i = Intent(app, EngineService::class.java)
            if (on) {
                if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(i) else app.startService(i)
            } else app.stopService(i)
        } catch (e: Exception) {
            // Starting a foreground service from the background can be refused on Android 12+. The request still runs.
        }
    }
}
