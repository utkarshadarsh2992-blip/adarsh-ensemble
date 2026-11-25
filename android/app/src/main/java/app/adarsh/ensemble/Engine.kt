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
    private val activeRequests = AtomicInteger(0)
    private val controllerGate = Any()
    @Volatile private var controllerApplyPending = false
    private val cancelled = ConcurrentHashMap.newKeySet<String>()
    private lateinit var app: Application
    private lateinit var controller: ControllerLink
    private var entry: PyObject? = null

    @Volatile var ready = false
        private set
    @Volatile var startError: String? = null
        private set

    /** Replies that finished while no screen was attached. Delivered when the activity comes back. */
    val undelivered = ConcurrentHashMap<String, Pair<String?, String?>>()

    fun start(application: Application, keys: SecureKeys, controllerLink: ControllerLink) {
        app = application
        controller = controllerLink
        pool.execute {
            try {
                // Stage secret-free config before Python imports config.py or any routing module.
                controller.refreshBeforePython()
                if (!Python.isStarted()) Python.start(AndroidPlatform(application))
                val mod = Python.getInstance().getModule("android_entry")
                val initState = mod.callAttr("init", application.filesDir.resolve("engine").absolutePath,
                    controller.configCache.absolutePath, controller.configPending.absolutePath).toString()
                controller.noteConfigApply(initState)
                for (n in SecureKeys.NAMES) keys.get(n)?.let { mod.callAttr("set_key", n, it) }
                entry = mod
                ready = true
                synchronized(controllerGate) { controllerApplyPending = false }
                pool.execute { syncControllerReports(force = true) }
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

    /** Pair-code exchange remains native; the raw token is never passed to Python or JavaScript. */
    fun controllerPair(id: String, code: String, onDone: (String?, String?) -> Unit) {
        pool.execute {
            val parsed = try { org.json.JSONObject(controller.pair(code)) }
                catch (_: Exception) { org.json.JSONObject().put("ok", false) }
            if (parsed.optBoolean("ok")) {
                applyControllerConfigWhenIdle()
                parsed.put("config_status", try { org.json.JSONObject(controller.status()).optString("last_status") } catch (_: Exception) { "" })
            }
            onDone(parsed.toString(), null)
        }
    }

    /** Manual sync uploads prompt-free absolute usage summaries and stages the newest config. */
    fun controllerSync(id: String, onDone: (String?, String?) -> Unit) {
        pool.execute {
            val reports = controllerReportsJson()
            val result = try { org.json.JSONObject(controller.sync(reports, force = true)) }
                catch (_: Exception) { org.json.JSONObject().put("ok", false).put("error", "Controller offline hai.") }
            if (result.optBoolean("ok")) {
                applyControllerConfigWhenIdle()
                result.put("config_status", try { org.json.JSONObject(controller.status()).optString("last_status") } catch (_: Exception) { "" })
            }
            onDone(result.toString(), null)
        }
    }

    fun controllerStatus(): String = try { controller.status() }
        catch (_: Exception) { """{"linked":false,"revision":0}""" }

    private fun controllerReportsJson(): String? = try {
        started.await()
        entry?.callAttr("controller_reports")?.toString()
    } catch (_: Exception) { null }

    private fun syncControllerReports(force: Boolean) {
        val reports = controllerReportsJson() ?: return
        val result = try { org.json.JSONObject(controller.sync(reports, force = force)) }
            catch (_: Exception) { org.json.JSONObject() }
        if (result.optBoolean("ok")) applyControllerConfigWhenIdle()
    }

    private fun reloadControllerConfigLocked() {
        if (!ready) { controllerApplyPending = true; return }
        try {
            val result = entry?.callAttr("reload_controller_config", controller.configCache.absolutePath,
                controller.configPending.absolutePath)?.toString()
            if (result != null) controller.noteConfigApply(result)
            controllerApplyPending = false
        } catch (_: Exception) {
            // Keep the prior active config and last-known-good file if the adapter cannot reload.
        }
    }

    private fun applyControllerConfigWhenIdle() {
        synchronized(controllerGate) {
            if (activeRequests.get() == 0) reloadControllerConfigLocked()
            else controllerApplyPending = true
        }
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
        synchronized(controllerGate) { activeRequests.incrementAndGet() }
        pool.execute {
            var result: String? = null
            var error: String? = null
            var usageBefore: Long? = null
            var shouldUpload = false
            try {
                started.await()
                if (!cancelled.contains(id)) {
                    val e = entry ?: throw IllegalStateException(startError ?: "Engine did not start")
                    usageBefore = try { e.callAttr("usage_request_count").toLong() } catch (_: Exception) { null }
                    val progress = java.util.function.Consumer<String> { msg -> onProgress(msg) }
                    // Python also handles Stop arriving between this check and request registration.
                    result = e.callAttr("handle", requestJson, progress, id).toString()
                    val usageAfter = try { e.callAttr("usage_request_count").toLong() } catch (_: Exception) { null }
                    shouldUpload = usageBefore != null && usageAfter != null && usageAfter > usageBefore!!
                }
            } catch (t: Throwable) {
                // Never include the request body here: it can contain the user's text.
                error = "Engine error: " + (t.message ?: t.javaClass.simpleName)
            } finally {
                if (foreground && inFlight.decrementAndGet() == 0) setForeground(false)
                synchronized(controllerGate) {
                    activeRequests.decrementAndGet()
                    if (activeRequests.get() == 0 && controllerApplyPending) reloadControllerConfigLocked()
                }
            }
            if (!cancelled.remove(id)) onDone(result, error)
            if (shouldUpload) pool.execute { syncControllerReports(force = false) }
        }
    }

    /** Stop: the late answer is dropped here, and Python cancels the running request so no further model calls
     *  (and tokens) are spent. Runs on the pool so the UI or main thread never waits for Python. */
    fun cancel(id: String) {
        cancelled.add(id)
        pool.execute {
            try {
                started.await()
                entry?.callAttr("cancel", id)
            } catch (t: Throwable) {
                // Best effort: the answer is still dropped even if Python could not be told to stop.
            }
        }
    }

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
