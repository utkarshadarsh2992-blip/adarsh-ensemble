package app.adarsh.ensemble

import android.content.Context
import android.os.Build
import android.os.SystemClock
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.locks.ReentrantLock
import javax.net.ssl.HttpsURLConnection
import kotlin.concurrent.withLock

/** Paired-device controller client. The device token is separate from provider keys and never crosses into JS/Python. */
class ControllerLink(context: Context) {
    private val app = context.applicationContext
    private val lock = ReentrantLock()
    private val files = File(app.filesDir, "engine").apply { mkdirs() }
    val configCache = File(files, "controller-config.json")
    val configPending = File(files, "controller-config.pending.json")
    private val meta = app.getSharedPreferences("adarsh_controller_meta", Context.MODE_PRIVATE)
    private val tokenPrefs by lazy {
        val master = MasterKey.Builder(app, "adarsh_controller_token_master")
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            app, TOKEN_FILE, master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
    @Volatile private var lastAttemptElapsed = 0L
    @Volatile private var lastAttemptStatus = ""

    fun noteConfigApply(resultJson: String) {
        lastAttemptStatus = try {
            val result = JSONObject(resultJson)
            val digest = result.optString("config_digest")
            val editor = meta.edit()
            if (result.optBoolean("active") && digest.isNotBlank()) {
                when (digest) {
                    meta.getString("pending_digest", null) -> {
                        val revision = meta.getLong("pending_revision", 0L)
                        editor.putLong("applied_revision", revision)
                        if (result.optBoolean("cached")) {
                            editor.putLong("cached_revision", revision).putString("cached_digest", digest)
                        }
                    }
                    meta.getString("cached_digest", null) -> editor.putLong("applied_revision", meta.getLong("cached_revision", 0L))
                    else -> editor.putLong("applied_revision", 0L)
                }
            } else editor.putLong("applied_revision", 0L)
            editor.commit()
            val warning = result.optString("warning").ifBlank { result.optString("error") }
            when {
                warning.isNotBlank() -> (result.optString("source", "bundled") + " fallback: " + warning).take(120)
                result.optBoolean("active") -> "config active: " + result.optString("source", "cache")
                else -> "bundled defaults active"
            }
        } catch (_: Exception) { "config status unavailable" }
    }

    fun status(): String = JSONObject()
        .put("linked", !token().isNullOrBlank())
        .put("revision", meta.getLong("applied_revision", 0L))
        .put("staged_revision", meta.getLong("pending_revision", 0L))
        .put("last_sync", meta.getLong("last_sync", 0L))
        .put("last_status", lastAttemptStatus.take(120))
        .put("config_cached", configCache.isFile)
        .toString()

    /** Startup refresh runs on Engine's worker before Python modules are imported. */
    fun refreshBeforePython() {
        if (token().isNullOrBlank()) return
        syncInternal(null, force = true)
    }

    /** Exchange a one-time code. Raw code/token are never persisted in regular preferences or returned to the page. */
    fun pair(rawCode: String): String = lock.withLock {
        val code = rawCode.trim()
        if (code.length !in 12..128 || !code.matches(Regex("[A-Za-z0-9_-]+"))) return JSONObject()
            .put("ok", false).put("error", "Pairing code format sahi nahi hai.").toString()
        try {
            val body = JSONObject().put("action", "pair").put("code", code)
                .put("name", deviceName())
            val response = post(body, null)
            if (!response.optBoolean("ok")) return failure("Pairing code expire ya invalid ho sakta hai.")
            val deviceToken = response.optString("device_token")
            val config = response.optJSONObject("config")
            val revision = response.optLong("revision", 0L)
            if (deviceToken.length !in 32..256 || !deviceToken.matches(Regex("[A-Za-z0-9_-]+")) || config == null || revision < 0) {
                return failure("Controller ka pairing jawab valid nahi tha.")
            }
            if (!stageConfig(config, revision)) return failure("Controller config bahut badi ya unreadable hai.")
            if (!tokenPrefs.edit().putString(TOKEN_KEY, deviceToken).commit()) {
                try { configPending.delete() } catch (_: Exception) {}
                return failure("Encrypted controller token save nahi hua.")
            }
            meta.edit().putLong("revision", revision).putLong("last_sync", System.currentTimeMillis()).apply()
            lastAttemptStatus = "paired"
            JSONObject().put("ok", true).put("revision", revision).toString()
        } catch (_: Exception) {
            failure("Controller se secure connection nahi ho paya. Dobara try karo.")
        }
    }

    /** User-triggered config refresh (and optional prompt-free usage snapshots). */
    fun sync(reportsJson: String?, force: Boolean = true): String = lock.withLock {
        val result = syncInternal(reportsJson, force)
        result.toString()
    }

    /** Opportunistic usage snapshot after a model call; bounded and throttled, with retry on later calls. */
    fun uploadReports(reportsJson: String) {
        lock.withLock { syncInternal(reportsJson, force = false) }
    }

    private fun syncInternal(reportsJson: String?, force: Boolean): JSONObject {
        val deviceToken = token() ?: return JSONObject().put("ok", false).put("linked", false).put("error", "App abhi pair nahi hai.")
        val elapsed = SystemClock.elapsedRealtime()
        val now = System.currentTimeMillis()
        if (!force && reportsJson != null) {
            val lastOk = meta.getLong("last_report_upload", 0L)
            if (elapsed - lastAttemptElapsed < 20_000L || now - lastOk < 120_000L) {
                lastAttemptStatus = "throttled"
                return JSONObject().put("ok", true).put("throttled", true)
            }
        }
        lastAttemptElapsed = elapsed
        return try {
            val request = JSONObject().put("action", "sync")
                .put("config_revision", meta.getLong("applied_revision", 0L))
                .put("app_version", appVersion())
            if (reportsJson != null) {
                val reports = JSONArray(reportsJson)
                if (reports.length() > 14) return failure("Usage reports limit se zyada hain.")
                request.put("reports", reports)
            }
            val response = post(request, deviceToken)
            if (!response.optBoolean("ok")) return failure("Controller sync reject hua; last good config rakha hai.")
            val revision = response.optLong("revision", meta.getLong("revision", 0L))
            val config = response.optJSONObject("config")
            if (revision < 1 || config == null || !stageConfig(config, revision)) return failure("Controller config valid nahi; last good config rakha hai.")
            val editor = meta.edit().putLong("revision", revision).putLong("last_sync", now)
            if (reportsJson != null) editor.putLong("last_report_upload", now)
            editor.apply()
            lastAttemptStatus = "synced"
            JSONObject().put("ok", true).put("revision", revision).put("config_staged", true)
        } catch (_: Exception) {
            lastAttemptStatus = "offline"
            JSONObject().put("ok", false).put("error", "Controller offline hai; cached config use hogi.")
        }
    }

    private fun token(): String? = try { tokenPrefs.getString(TOKEN_KEY, null)?.takeIf { it.isNotBlank() } } catch (_: Exception) { null }

    private fun stageConfig(config: JSONObject, revision: Long): Boolean {
        val bytes = config.toString().toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty() || bytes.size > MAX_RESPONSE_BYTES) return false
        return try {
            files.mkdirs()
            val temp = File(files, "controller-config.pending.tmp")
            temp.outputStream().use { it.write(bytes); it.fd.sync() }
            temp.setReadable(false, false); temp.setWritable(false, false)
            temp.setReadable(true, true); temp.setWritable(true, true)
            if (!temp.renameTo(configPending)) { temp.delete(); false } else {
                val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                meta.edit().putLong("pending_revision", revision).putString("pending_digest", digest).commit()
            }
        } catch (_: Exception) { false }
    }

    private fun post(body: JSONObject, bearer: String?): JSONObject {
        val target = URL(ENDPOINT)
        require(target.protocol == "https" && target.host == PROJECT_HOST && target.port == -1 && target.userInfo == null)
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_REQUEST_BYTES)
        val connection = (target.openConnection() as HttpsURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            useCaches = false
            instanceFollowRedirects = false
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Cache-Control", "no-store")
            setRequestProperty("Pragma", "no-cache")
            if (bearer != null) setRequestProperty("Authorization", "Bearer $bearer")
        }
        try {
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            if (status !in 200..299 || connection.url.host != PROJECT_HOST || connection.url.protocol != "https") {
                throw IllegalStateException("request rejected")
            }
            val stream = connection.inputStream
            val output = ByteArrayOutputStream()
            stream.use { input ->
                val buffer = ByteArray(4096)
                var total = 0
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    if (total > MAX_RESPONSE_BYTES) throw IllegalStateException("response too large")
                    output.write(buffer, 0, count)
                }
            }
            JSONObject(output.toString(Charsets.UTF_8.name()))
        } finally {
            connection.disconnect()
        }
    }

    private fun deviceName(): String = (Build.MODEL.ifBlank { "Android device" }).take(60)
    private fun appVersion(): String = try { app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: "unknown" } catch (_: Exception) { "unknown" }
    private fun failure(message: String): JSONObject {
        lastAttemptStatus = "failed"
        return JSONObject().put("ok", false).put("error", message)
    }

    companion object {
        private const val PROJECT_HOST = "yepupldfjtikalfzehvl.supabase.co"
        private const val ENDPOINT = "https://yepupldfjtikalfzehvl.supabase.co/functions/v1/controller-device"
        private const val TOKEN_FILE = "adarsh_controller_pairing"
        private const val TOKEN_KEY = "device_token"
        private const val CONNECT_TIMEOUT_MS = 5_000
        private const val READ_TIMEOUT_MS = 8_000
        private const val MAX_REQUEST_BYTES = 256 * 1024
        private const val MAX_RESPONSE_BYTES = 256 * 1024
    }
}
