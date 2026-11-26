package app.adarsh.ensemble

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Manual Firebase configuration and the phone-side registration half of the news contract. */
object NewsFcm {
    const val ACTION_OPEN = "app.adarsh.ensemble.OPEN_NEWS"
    const val EXTRA_OPEN_TARGET = "adarsh_open_target"
    const val ALERT_CHANNEL = "adarsh_news_alert"
    const val INFO_CHANNEL = "adarsh_news_info"

    private const val STORE = "adarsh_news"
    private const val MAX_CONFIG_JSON = 4096
    private const val MAX_VALUE = 512
    private const val MAX_URL = 2048
    private const val MAX_RESPONSE = 64 * 1024
    private const val MAX_CALL_RESPONSE = 512 * 1024
    private const val MAX_RETRIES = 5
    private const val TAG = "NewsFcm"
    private val API_ACTIONS = setOf(
        "ping", "list", "get", "top", "mark", "register", "unregister", "budget",
        "settings_get", "settings_set", "telegram_link", "telegram_test", "fcm_test",
        "telegram_copy", "digest_now"
    )
    private val pool: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, TAG).apply { isDaemon = true }
    }
    private val registrationScheduled = AtomicBoolean(false)
    @Volatile private var store: SharedPreferences? = null
    @Volatile private var initialized = false
    @Volatile private var lastError = ""
    @Volatile private var pendingToken: String? = null
    @Volatile private var configGeneration = 0L

    /** Called from Application.onCreate; all work, including encrypted-store access, is deferred. */
    fun start(ctx: Context) {
        val app = ctx.applicationContext
        try {
            pool.execute { runUnitGuarded { ensureInitInternal(app) } }
        } catch (_: Throwable) {
            // Firebase must never affect app startup.
        }
    }

    /** Safe for the messaging service and bridge. It never throws or exposes a secret. */
    fun ensureInit(ctx: Context): Boolean = try {
        ensureInitInternal(ctx.applicationContext)
    } catch (_: Throwable) {
        lastError = "FCM init failed"
        false
    }

    fun configureNews(ctx: Context, json: String): String {
        val bad = { message: String -> JSONObject().put("ok", false).put("error", message).toString() }
        if (json.length > MAX_CONFIG_JSON) return bad("JSON bahut bada")
        val o = try { JSONObject(json) } catch (_: Exception) { return bad("bad json") }
        val url = value(o, "url", MAX_URL, bad) ?: return bad("url galat hai")
        val secret = value(o, "secret", MAX_VALUE, bad) ?: return bad("secret galat hai")
        if (url.isNotEmpty() && !isHttps(url)) return bad("sirf HTTPS URL chalega")
        val p = prefs(ctx) ?: return bad("secure store ready nahi")
        try {
            val oldUrl = p.getString("news_url", "").orEmpty()
            val oldSecret = p.getString("news_secret", "").orEmpty()
            val oldDevice = p.getString("device_id", "").orEmpty()
            val changed = oldUrl != url || oldSecret != secret
            p.edit().putString("news_url", url).putString("news_secret", secret).apply()
            if (changed) {
                configGeneration++
                p.edit().putBoolean("registered", false).apply()
                scheduleUnregister(ctx, oldUrl, oldSecret, oldDevice)
            }
            lastError = ""
            scheduleRegistration(ctx, 0L, 0)
            return JSONObject().put("ok", true).toString()
        } catch (_: Throwable) {
            lastError = "news config save failed"
            return bad("save nahi hua")
        }
    }

    fun configureFcm(ctx: Context, json: String): String {
        val bad = { message: String -> JSONObject().put("ok", false).put("error", message).toString() }
        if (json.length > MAX_CONFIG_JSON) return bad("JSON bahut bada")
        val o = try { JSONObject(json) } catch (_: Exception) { return bad("bad json") }
        val names = listOf("apiKey", "appId", "projectId", "senderId")
        if (o.length() == 0) {
            val p = prefs(ctx) ?: return bad("secure store ready nahi")
            val oldUrl = p.getString("news_url", "").orEmpty()
            val oldSecret = p.getString("news_secret", "").orEmpty()
            val oldDevice = p.getString("device_id", "").orEmpty()
            p.edit().remove("fcm_api_key").remove("fcm_app_id").remove("fcm_project_id")
                .remove("fcm_sender_id").remove("fcm_token").putBoolean("registered", false).apply()
            initialized = false
            configGeneration++
            scheduleUnregister(ctx, oldUrl, oldSecret, oldDevice)
            lastError = ""
            return JSONObject().put("ok", true).toString()
        }
        val values = HashMap<String, String>()
        for (name in names) {
            if (!o.has(name) || o.isNull(name) || o.get(name) !is String) return bad("$name string hona chahiye")
            val value = o.getString(name).trim()
            if (value.isEmpty() || value.length > MAX_VALUE) return bad("$name galat hai")
            values[name] = value
        }
        val p = prefs(ctx) ?: return bad("secure store ready nahi")
        return try {
            val oldApiKey = p.getString("fcm_api_key", "").orEmpty()
            val oldAppId = p.getString("fcm_app_id", "").orEmpty()
            val oldProjectId = p.getString("fcm_project_id", "").orEmpty()
            val oldSenderId = p.getString("fcm_sender_id", "").orEmpty()
            val changed = oldApiKey != values.getValue("apiKey") || oldAppId != values.getValue("appId") ||
                oldProjectId != values.getValue("projectId") || oldSenderId != values.getValue("senderId")
            val oldUrl = p.getString("news_url", "").orEmpty()
            val oldSecret = p.getString("news_secret", "").orEmpty()
            val oldDevice = p.getString("device_id", "").orEmpty()
            p.edit().putString("fcm_api_key", values.getValue("apiKey"))
                .putString("fcm_app_id", values.getValue("appId"))
                .putString("fcm_project_id", values.getValue("projectId"))
                .putString("fcm_sender_id", values.getValue("senderId"))
                .remove("fcm_token").putBoolean("registered", false).apply()
            if (changed) {
                configGeneration++
                scheduleUnregister(ctx, oldUrl, oldSecret, oldDevice)
            }
            lastError = ""
            pool.execute { runUnitGuarded { ensureInitInternal(ctx.applicationContext) } }
            JSONObject().put("ok", true).toString()
        } catch (_: Throwable) {
            lastError = "FCM config save failed"
            bad("save nahi hua")
        }
    }

    fun status(ctx: Context): JSONObject {
        val p = prefs(ctx)
        val configured = p != null && fcmConfigured(p)
        val gms = isGmsAvailable(ctx)
        val token = p?.getString("fcm_token", null).isNullOrBlank().not()
        val registered = p?.getBoolean("registered", false) == true
        return JSONObject().put("configured", configured).put("gms", gms).put("token", token)
            .put("registered", registered).put("error", lastError)
    }

    fun newsStatus(ctx: Context): JSONObject {
        val p = prefs(ctx)
        val url = p?.getString("news_url", "").orEmpty()
        val secret = p?.getString("news_secret", "").orEmpty()
        return JSONObject().put("configured", isHttps(url) && secret.isNotBlank()).put("url", url)
    }

    /** Native news-api call. The page supplies no URL or secret and only receives a JSON response. */
    fun newsCall(ctx: Context, id: String, json: String, callback: (String) -> Unit) {
        val failure = { message: String -> JSONObject().put("ok", false).put("error", message).toString() }
        if (!id.matches(Regex("^[A-Za-z0-9_-]{1,64}$"))) { callback(failure("id galat hai")); return }
        if (json.length > 32 * 1024) { callback(failure("request bahut bada")); return }
        val request = try { JSONObject(json) } catch (_: Exception) {
            callback(failure("bad json")); return
        }
        val action = request.optString("action", "")
        if (action !in API_ACTIONS) { callback(failure("action allowed nahi hai")); return }
        val app = ctx.applicationContext
        try {
            pool.execute {
                val p = prefs(app)
                val url = p?.getString("news_url", "").orEmpty()
                val secret = p?.getString("news_secret", "").orEmpty()
                val result = if (!isHttps(url) || secret.isBlank()) failure("news configured nahi")
                else callNewsApi(url, secret, request.toString(), MAX_CALL_RESPONSE)
                callback(result)
            }
        } catch (_: Throwable) {
            callback(failure("request start nahi hua"))
        }
    }

    fun onToken(ctx: Context, token: String) {
        if (token.isBlank() || token.length > 4096) return
        pendingToken = token
        start(ctx)
    }

    fun openTarget(intent: android.content.Intent): String? {
        if (intent.action != ACTION_OPEN) return null
        return sanitizeOpenTarget(intent.getStringExtra(EXTRA_OPEN_TARGET))
    }

    /** Only these values are ever allowed into the WebView JavaScript call. */
    fun sanitizeOpenTarget(raw: String?): String? {
        val value = raw ?: return null
        return when {
            value == "news" || value == "news:budget" -> value
            value.startsWith("news:") -> {
                val id = value.substringAfter("news:").filter { it.isLetterOrDigit() || it == '_' || it == '-' }.take(64)
                if (id.isEmpty()) null else "news:$id"
            }
            else -> null
        }
    }

    private fun ensureInitInternal(ctx: Context): Boolean {
        val p = prefs(ctx) ?: return false
        val token = pendingToken
        if (!token.isNullOrBlank()) {
            p.edit().putString("fcm_token", token).putBoolean("registered", false).apply()
            pendingToken = null
        }
        if (!fcmConfigured(p)) return false
        if (!isGmsAvailable(ctx)) {
            lastError = "Google Play services nahi hai"
            return false
        }
        val options = FirebaseOptions.Builder()
            .setApiKey(p.getString("fcm_api_key", "")!!)
            .setApplicationId(p.getString("fcm_app_id", "")!!)
            .setProjectId(p.getString("fcm_project_id", "")!!)
            .setGcmSenderId(p.getString("fcm_sender_id", "")!!)
            .build()
        try {
            val app = FirebaseApp.getApps(ctx).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
                ?: FirebaseApp.initializeApp(ctx, options)
            if (app == null) throw IllegalStateException("Firebase app unavailable")
            initialized = true
            lastError = ""
            requestToken(ctx)
            scheduleRegistration(ctx, 0L, 0)
            return true
        } catch (_: Throwable) {
            initialized = false
            lastError = "FCM init failed"
            return false
        }
    }

    private fun requestToken(ctx: Context) {
        if (!initialized) return
        try {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    val token = task.result
                    if (!token.isNullOrBlank()) onToken(ctx, token)
                } else {
                    lastError = "FCM token nahi mila"
                }
            }
        } catch (_: Throwable) {
            lastError = "FCM token nahi mila"
        }
    }

    private fun scheduleRegistration(ctx: Context, delayMs: Long, attempt: Int) {
        if (!registrationScheduled.compareAndSet(false, true)) return
        try {
            pool.schedule({
                registrationScheduled.set(false)
                val ok = tryGuarded { registerOnce(ctx.applicationContext) } ?: false
                if (!ok && attempt < MAX_RETRIES) {
                    val next = (5_000L shl attempt).coerceAtMost(15 * 60_000L)
                    scheduleRegistration(ctx, next, attempt + 1)
                }
            }, delayMs, TimeUnit.MILLISECONDS)
        } catch (_: Throwable) {
            registrationScheduled.set(false)
        }
    }

    private fun registerOnce(ctx: Context): Boolean {
        val p = prefs(ctx) ?: return false
        val generation = configGeneration
        val url = p.getString("news_url", "").orEmpty()
        val secret = p.getString("news_secret", "").orEmpty()
        val token = p.getString("fcm_token", "").orEmpty()
        if (!isHttps(url) || secret.isBlank() || token.isBlank()) return false
        val device = getOrCreateDeviceId(p) ?: return false
        val version = try {
            @Suppress("DEPRECATION")
            ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName.orEmpty()
        } catch (_: Exception) { "" }
        val body = JSONObject().put("action", "register").put("device_id", device)
            .put("fcm_token", token).put("platform", "android").put("app_version", version).toString()
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as? HttpURLConnection) ?: return false
            if (!exactHttpsHost(connection.url, url)) return false
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("x-app-secret", secret)
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.use { readBounded(it.bufferedReader(), MAX_RESPONSE) }.orEmpty()
            val ok = code in 200..299 && JSONObject(response).optBoolean("ok", false)
            if (ok && generation == configGeneration && p.getString("news_url", "").orEmpty() == url &&
                p.getString("news_secret", "").orEmpty() == secret) {
                p.edit().putBoolean("registered", true).apply()
                lastError = ""
            } else lastError = "registration failed"
            ok
        } catch (_: Throwable) {
            lastError = "registration failed"
            false
        } finally {
            connection?.disconnect()
        }
    }

    private fun scheduleUnregister(ctx: Context, url: String, secret: String, device: String) {
        if (!isHttps(url) || secret.isBlank() || device.isBlank()) return
        try {
            pool.execute {
                val body = JSONObject().put("action", "unregister").put("device_id", device).toString()
                callNewsApi(url, secret, body, MAX_RESPONSE)
            }
        } catch (_: Throwable) {}
    }

    private fun callNewsApi(url: String, secret: String, body: String, maxResponse: Int): String {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as? HttpURLConnection) ?: return JSONObject()
                .put("ok", false).put("error", "URL galat hai").toString()
            if (!exactHttpsHost(connection.url, url)) return JSONObject()
                .put("ok", false).put("error", "URL galat hai").toString()
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("x-app-secret", secret)
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.use { readBounded(it.bufferedReader(), maxResponse) }.orEmpty()
            if (response.isBlank()) JSONObject().put("ok", false).put("error", "empty response").toString()
            else try { JSONObject(response).toString() }
            catch (_: Exception) { JSONObject().put("ok", false).put("error", "bad response").toString() }
        } catch (_: Throwable) {
            JSONObject().put("ok", false).put("error", "network error").toString()
        } finally {
            connection?.disconnect()
        }
    }

    private fun getOrCreateDeviceId(p: SharedPreferences): String? {
        val old = p.getString("device_id", null)
        if (!old.isNullOrBlank()) return old
        val id = UUID.randomUUID().toString()
        return if (p.edit().putString("device_id", id).commit()) id else null
    }

    /** Authenticated news traffic never follows a redirect to another host (or to HTTP). */
    private fun exactHttpsHost(actual: URL, expected: String): Boolean = try {
        val original = URL(expected)
        actual.protocol.equals("https", ignoreCase = true) &&
            original.protocol.equals("https", ignoreCase = true) &&
            actual.host.equals(original.host, ignoreCase = true) &&
            actual.port == original.port
    } catch (_: Exception) { false }

    private fun prefs(ctx: Context): SharedPreferences? {
        store?.let { return it }
        return try {
            val master = MasterKey.Builder(ctx.applicationContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            val created = EncryptedSharedPreferences.create(
                ctx.applicationContext, STORE, master,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            store = created
            created
        } catch (_: Throwable) {
            lastError = "secure store ready nahi"
            null
        }
    }

    private fun fcmConfigured(p: SharedPreferences): Boolean =
        listOf("fcm_api_key", "fcm_app_id", "fcm_project_id", "fcm_sender_id").all { !p.getString(it, null).isNullOrBlank() }

    private fun isGmsAvailable(ctx: Context): Boolean = try {
        ctx.packageManager.getPackageInfo("com.google.android.gms", 0)
        true
    } catch (_: Throwable) { false }

    private fun isHttps(raw: String): Boolean = try {
        val uri = Uri.parse(raw)
        uri.scheme.equals("https", true) && !uri.host.isNullOrBlank()
    } catch (_: Throwable) { false }

    private fun readBounded(reader: java.io.Reader, max: Int): String {
        val out = StringBuilder(minOf(max, 8192))
        val buffer = CharArray(8192)
        while (out.length < max) {
            val count = reader.read(buffer, 0, minOf(buffer.size, max - out.length))
            if (count < 0) break
            if (count == 0) continue
            out.append(buffer, 0, count)
        }
        return out.toString()
    }

    private fun value(o: JSONObject, name: String, max: Int, bad: (String) -> String): String? {
        if (!o.has(name) || o.isNull(name) || o.get(name) !is String) return null
        val value = o.getString(name).trim()
        return if (value.length <= max) value else null
    }

    private fun runUnitGuarded(block: () -> Unit): Boolean = try { block(); true } catch (_: Throwable) { false }
    private fun <T> tryGuarded(block: () -> T): T? = try { block() } catch (_: Throwable) { null }
}
