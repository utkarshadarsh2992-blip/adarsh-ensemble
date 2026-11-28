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
    /** Raw Vault values are held in process memory only until Engine applies encrypted native storage. */
    @Volatile private var pendingCredentialBundle: JSONObject? = null

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
        .put("credentials_revision", meta.getLong("credential_revision", 0L))
        .put("device_settings", try { JSONObject(meta.getString("device_settings", "{}") ?: "{}") } catch (_: Exception) { JSONObject() })
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

    /** Bundle is native-only: callers must not pass it to the WebView or usage reporting. */
    fun takeCredentialBundle(): JSONObject? {
        val bundle = pendingCredentialBundle ?: return null
        val revision = bundle.optJSONObject("credentials")?.optLong("revision", 0L) ?: return null
        // Equal revisions must also restore a reset native key store. Applying values is idempotent.
        return if (revision >= meta.getLong("credential_revision", 0L)) JSONObject(bundle.toString()) else null
    }

    fun noteCredentialsApplied(revision: Long) {
        if (revision > meta.getLong("credential_revision", 0L)) meta.edit().putLong("credential_revision", revision).commit()
        pendingCredentialBundle = null
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
            if (!response.optBoolean("ok")) return failureJson("Pairing code expire ya invalid ho sakta hai.")
            val deviceToken = response.optString("device_token")
            val config = response.optJSONObject("config")
            val revision = response.optLong("revision", 0L)
            if (deviceToken.length !in 32..256 || !deviceToken.matches(Regex("[A-Za-z0-9_-]+")) || config == null || revision < 0) {
                return failureJson("Controller ka pairing jawab valid nahi tha.")
            }
            if (!stageConfig(config, revision)) return failureJson("Controller config bahut badi ya unreadable hai.")
            if (!tokenPrefs.edit().putString(TOKEN_KEY, deviceToken).commit()) {
                try { configPending.delete() } catch (_: Exception) {}
                return failureJson("Encrypted controller token save nahi hua.")
            }
            captureCredentialBundle(response)
            meta.edit().putLong("revision", revision).putLong("last_sync", System.currentTimeMillis()).apply()
            lastAttemptStatus = "paired"
            JSONObject().put("ok", true).put("revision", revision).toString()
        } catch (_: Exception) {
            failureJson("Controller se secure connection nahi ho paya. Dobara try karo.")
        }
    }

    /** User-triggered config refresh (and optional prompt-free usage snapshots). */
    fun sync(reportsJson: String?, force: Boolean = true): String = lock.withLock {
        val result = syncInternal(reportsJson, force)
        result.toString()
    }

    /** Read only the assistant-safe Controller snapshot; the paired token never leaves native code. */
    fun assistantState(): String = lock.withLock {
        val deviceToken = token() ?: return assistantFailure("App abhi pair nahi hai.")
        try {
            val response = post(JSONObject().put("action", "assistant_state"), deviceToken)
            val revision = response.optLong("revision", 0L)
            val config = response.optJSONObject("config")
            if (!response.optBoolean("ok") || revision < 1L || config == null || !stageConfig(config, revision)) {
                return assistantFailure("Controller safe state ya config stage nahi hui.")
            }
            meta.edit().putLong("revision", revision).putLong("last_sync", System.currentTimeMillis()).apply()
            safeAssistantResponse(response).toString()
        } catch (_: Exception) {
            assistantFailure("Controller offline hai.")
        }
    }

    /** Only model/route, News-limit, and briefing-setting patches are accepted from the WebView. */
    fun assistantUpdate(payloadJson: String): String = lock.withLock {
        val deviceToken = token() ?: return assistantFailure("App abhi pair nahi hai.")
        if (payloadJson.toByteArray(Charsets.UTF_8).size > MAX_ASSISTANT_REQUEST_BYTES) {
            return assistantFailure("Controller change bahut bada hai.")
        }
        val payload = try { validateAssistantPayload(JSONObject(payloadJson)) }
            catch (_: Exception) { null }
            ?: return assistantFailure("Controller change valid nahi hai.")
        try {
            val request = JSONObject().put("action", "assistant_update")
                .put("kind", payload.getString("kind")).put("values", payload.getJSONObject("values"))
                .put("reason", payload.getString("reason"))
            if (payload.has("expected_revision")) request.put("expected_revision", payload.getLong("expected_revision"))
            safeAssistantResponse(post(request, deviceToken)).toString()
        } catch (_: Exception) {
            assistantFailure("Controller update nahi ho paya.")
        }
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
            captureCredentialBundle(response)
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

    private fun captureCredentialBundle(response: JSONObject) {
        val credentials = response.optJSONObject("credentials") ?: return
        if (credentials.optJSONObject("values") == null || credentials.optJSONArray("managed") == null || credentials.optLong("revision", 0L) < 1L) return
        val settings = response.optJSONObject("device_settings") ?: JSONObject()
        val setup = response.optJSONObject("setup") ?: JSONObject()
        val setupManaged = response.optJSONArray("setup_managed") ?: org.json.JSONArray()
        pendingCredentialBundle = JSONObject().put("credentials", JSONObject(credentials.toString()))
            .put("device_settings", JSONObject(settings.toString())).put("setup", JSONObject(setup.toString()))
            .put("setup_managed", org.json.JSONArray(setupManaged.toString()))
        // Ordinary preferences contain only the non-secret device settings and metadata revision.
        meta.edit().putString("device_settings", settings.toString())
            .putLong("remote_credentials_revision", credentials.optLong("revision", 0L)).commit()
    }

    /** Exact agreed request envelope. The kind-specific value allowlists exclude URLs, packages, credentials, and commands. */
    private fun validateAssistantPayload(input: JSONObject): JSONObject? {
        if (input.length() !in 3..4 || input.keys().asSequence().any { it !in ASSISTANT_PAYLOAD_FIELDS }) return null
        if (input.opt("kind") !is String || input.opt("reason") !is String) return null
        val kind = input.optString("kind", "")
        if (kind !in ASSISTANT_KINDS) return null
        val reason = input.optString("reason", "")
        if (reason.isBlank() || reason.length > 300 || reason.trim() != reason ||
            reason.any { it.code < 0x20 || it.code == 0x7f } ||
            Regex("(?:api[_ -]?key|secret|token)\\s*[:=]", RegexOption.IGNORE_CASE).containsMatchIn(reason) || looksSecretLike(reason)) return null
        val values = input.optJSONObject("values") ?: return null
        if (values.length() == 0) return null
        if (kind == "config" && !input.has("expected_revision")) return null
        val cleanValues = when (kind) {
            "config" -> validateConfigValues(values)
            "news_settings" -> validateNewsLimits(values)
            "briefing_settings" -> validateBriefingSettings(values)
            else -> null
        } ?: return null
        if (cleanValues.length() == 0) return null
        val result = JSONObject().put("kind", kind).put("values", cleanValues).put("reason", reason.trim())
        if (input.has("expected_revision")) {
            val revision = safeInteger(input.opt("expected_revision"), 1L, MAX_SAFE_INTEGER) ?: return null
            result.put("expected_revision", revision)
        }
        return result
    }

    private fun validateConfigValues(values: JSONObject): JSONObject? {
        if (values.length() != 2 || values.keys().asSequence().any { it !in setOf("models", "routes") } ||
            !values.has("models") || !values.has("routes")) return null
        val output = JSONObject()
        if (values.has("models")) {
            val models = values.optJSONArray("models") ?: return null
            if (models.length() !in 1..100) return null
            val clean = JSONArray()
            val labels = HashSet<String>()
            for (i in 0 until models.length()) {
                val model = models.optJSONObject(i) ?: return null
                if (model.keys().asSequence().any { it !in MODEL_FIELDS }) return null
                if (model.opt("label") !is String || model.opt("provider") !is String ||
                    model.opt("model") !is String || model.opt("extra") !is JSONObject) return null
                val label = model.optString("label", "")
                val provider = model.optString("provider", "")
                val modelId = model.optString("model", "")
                if (!MODEL_LABEL.matches(label) || looksSecretLike(label) || !labels.add(label) || provider !in PROVIDERS ||
                    !validModelId(modelId) || !model.has("enabled") || model.opt("enabled") !is Boolean) return null
                val item = JSONObject().put("label", label).put("provider", provider)
                    .put("model", modelId).put("enabled", model.optBoolean("enabled"))
                val extra = model.optJSONObject("extra") ?: return null
                if (extra.keys().asSequence().any { it !in MODEL_EXTRA_FIELDS }) return null
                val safeExtra = JSONObject()
                if (extra.has("reasoning_effort")) {
                    if (extra.opt("reasoning_effort") !is String) return null
                    val value = extra.optString("reasoning_effort", "")
                    if (value !in setOf("low", "medium", "high")) return null
                    safeExtra.put("reasoning_effort", value)
                }
                if (extra.has("reasoning_format")) {
                    if (extra.opt("reasoning_format") !is String) return null
                    val value = extra.optString("reasoning_format", "")
                    if (value !in setOf("hidden", "raw", "parsed")) return null
                    safeExtra.put("reasoning_format", value)
                }
                item.put("extra", safeExtra)
                clean.put(item)
            }
            output.put("models", clean)
        }
        if (values.has("routes")) {
            val routes = values.optJSONObject("routes") ?: return null
            if (routes.length() !in 0..100) return null
            val clean = JSONObject()
            for (key in routes.keys()) {
                if (!ROUTE_KEY.matches(key)) return null
                val chain = routes.optJSONArray(key) ?: return null
                if (chain.length() !in 1..10) return null
                val safeChain = JSONArray()
                val labels = HashSet<String>()
                for (i in 0 until chain.length()) {
                    if (chain.opt(i) !is String) return null
                    val label = chain.optString(i, "")
                    if (!MODEL_LABEL.matches(label) || looksSecretLike(label) || !labels.add(label)) return null
                    safeChain.put(label)
                }
                clean.put(key, safeChain)
            }
            output.put("routes", clean)
        }
        return output
    }

    /** Copy only public assistant state fields; credential bundles, URLs, setup data, and raw errors stay native. */
    private fun safeAssistantResponse(response: JSONObject): JSONObject {
        if (!response.optBoolean("ok")) return JSONObject().put("ok", false).put("error", "Controller request reject hua.")
        val safe = JSONObject().put("ok", true)
        val root = response.optJSONObject("state") ?: response.optJSONObject("assistant_state") ?: response
        val config = root.optJSONObject("config") ?: response.optJSONObject("config")
        val revision = root.optLong("revision", response.optLong("revision", 0L))
        if (revision in 0..9_000_000_000_000_000L) safe.put("revision", revision)

        val models = root.optJSONArray("models") ?: config?.optJSONArray("models")
        val safeConfig = JSONObject()
        if (models != null) safeConfig.put("models", safeModels(models))
        val routes = root.optJSONObject("routes") ?: config?.optJSONObject("routes")
        if (routes != null) safeConfig.put("routes", safeRoutes(routes))
        safe.put("config", safeConfig)

        val news = root.optJSONObject("news") ?: JSONObject()
        val newsSettings = news.optJSONObject("settings") ?: root.optJSONObject("settings")
            ?: root.optJSONObject("news_settings") ?: root.optJSONObject("news_limits") ?: JSONObject()
        val safeNewsSettings = validateNewsLimits(newsSettings) ?: JSONObject()
        val safeNews = JSONObject().put("settings", safeNewsSettings)
        val rawBudget = news.optJSONObject("budget")
        if (rawBudget != null) {
            val safeBudget = JSONObject()
            safeBudget.put("groq", safeBudgetGroup(rawBudget.optJSONObject("groq"), listOf("tokens_used", "tokens_cap", "calls_used", "calls_cap")))
            safeBudget.put("tavily", safeBudgetGroup(rawBudget.optJSONObject("tavily"), listOf("day_used", "day_cap", "month_used", "month_cap")))
            safeBudget.put("alerts", safeBudgetGroup(rawBudget.optJSONObject("alerts"), listOf("today", "cap")))
            safeNews.put("budget", safeBudget)
        }
        val localDay = news.optString("local_day", "")
        if (Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(localDay)) safeNews.put("local_day", localDay)
        val timezone = news.optString("tz", "")
        if (timezone.length in 1..80 && timezone.none { it.code < 0x20 || it.code == 0x7f }) safeNews.put("tz", timezone)
        safe.put("news", safeNews)
        val briefing = root.optJSONObject("device_settings") ?: root.optJSONObject("briefing_settings")
        safe.put("device_settings", if (briefing != null) validateBriefingSettings(briefing) ?: JSONObject() else JSONObject())
        return safe
    }

    private fun safeBudgetGroup(source: JSONObject?, fields: List<String>): JSONObject {
        val safe = JSONObject()
        if (source == null) return safe
        for (key in fields) {
            val value = source.opt(key) as? Number ?: continue
            val number = value.toDouble()
            if (number.isFinite() && number >= 0 && number % 1.0 == 0.0 && number <= MAX_SAFE_INTEGER.toDouble()) {
                safe.put(key, number.toLong())
            }
        }
        return safe
    }

    private fun safeModels(models: JSONArray): JSONArray {
        val safe = JSONArray()
        for (i in 0 until minOf(models.length(), 100)) {
            val model = models.optJSONObject(i) ?: continue
            if (model.opt("label") !is String || model.opt("provider") !is String ||
                model.opt("model") !is String) continue
            val label = model.optString("label", "")
            val provider = model.optString("provider", "")
            val modelId = model.optString("model", "")
            val enabled = model.opt("enabled")
            if (!MODEL_LABEL.matches(label) || looksSecretLike(label) || provider !in PROVIDERS || !validModelId(modelId) || enabled !is Boolean) continue
            val item = JSONObject().put("label", label).put("provider", provider).put("model", modelId).put("enabled", enabled)
            val extra = model.optJSONObject("extra") ?: JSONObject()
            val safeExtra = JSONObject()
            if (extra.opt("reasoning_effort") is String && extra.optString("reasoning_effort") in setOf("low", "medium", "high")) {
                safeExtra.put("reasoning_effort", extra.optString("reasoning_effort"))
            }
            if (extra.opt("reasoning_format") is String && extra.optString("reasoning_format") in setOf("hidden", "raw", "parsed")) {
                safeExtra.put("reasoning_format", extra.optString("reasoning_format"))
            }
            item.put("extra", safeExtra)
            safe.put(item)
        }
        return safe
    }

    private fun safeRoutes(routes: JSONObject): JSONObject {
        val safe = JSONObject()
        for (key in routes.keys()) {
            if (!ROUTE_KEY.matches(key)) continue
            val chain = routes.optJSONArray(key) ?: continue
            if (chain.length() !in 1..10) continue
            val safeChain = JSONArray()
            val labels = HashSet<String>()
            var valid = true
            for (i in 0 until chain.length()) {
                if (chain.opt(i) !is String) { valid = false; break }
                val label = chain.optString(i, "")
                if (!MODEL_LABEL.matches(label) || looksSecretLike(label) || !labels.add(label)) { valid = false; break }
                safeChain.put(label)
            }
            if (valid) safe.put(key, safeChain)
        }
        return safe
    }

    private fun validateNewsLimits(input: JSONObject): JSONObject? {
        val safe = JSONObject()
        for (key in input.keys()) {
            val range = NEWS_LIMIT_RANGES[key] ?: return null
            val value = input.opt(key)
            if (value !is Number || value.toDouble() % 1.0 != 0.0) return null
            val number = value.toLong()
            if (number < range.first || number > range.second) return null
            safe.put(key, number)
        }
        return safe
    }

    private fun validateBriefingSettings(input: JSONObject): JSONObject? {
        val safe = JSONObject()
        for (key in input.keys()) {
            when (key) {
                "briefingOn", "newsBriefing", "briefingTelegram" -> {
                    val value = input.opt(key)
                    if (value !is Boolean) return null
                    safe.put(key, value)
                }
                "briefingTime" -> {
                    if (input.opt(key) !is String) return null
                    val value = input.optString(key, "")
                    if (!TIME_24H.matches(value)) return null
                    safe.put(key, value)
                }
                else -> return null
            }
        }
        return safe
    }

    private fun validModelId(value: String): Boolean = value.length in 1..128 &&
        MODEL_ID.matches(value) && !value.contains("://") && !value.startsWith("//") && !looksSecretLike(value)

    private fun looksSecretLike(value: String): Boolean = Regex(
        "(?:bearer\\s+\\S+|(?:sk|rk|pk|nvapi|gsk)[_-][A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{40,})",
        RegexOption.IGNORE_CASE
    ).containsMatchIn(value)

    private fun safeInteger(value: Any?, minimum: Long, maximum: Long): Long? {
        if (value !is Number) return null
        val number = value.toDouble()
        if (!number.isFinite() || number % 1.0 != 0.0 || number < minimum.toDouble() || number > maximum.toDouble()) return null
        return number.toLong()
    }

    private fun assistantFailure(message: String): String = JSONObject().put("ok", false).put("error", message).toString()

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
            return JSONObject(output.toString(Charsets.UTF_8.name()))
        } finally {
            connection.disconnect()
        }
    }

    private fun deviceName(): String = (Build.MODEL.ifBlank { "Android device" }).take(60)
    private fun appVersion(): String = try { app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: "unknown" } catch (_: Exception) { "unknown" }
    private fun failureJson(message: String): String = failure(message).toString()
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
        private const val MAX_ASSISTANT_REQUEST_BYTES = 64 * 1024
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        private val PROVIDERS = setOf("groq", "openrouter", "gemini", "nvidia", "cloudflare")
        private val ASSISTANT_PAYLOAD_FIELDS = setOf("kind", "values", "expected_revision", "reason")
        private val ASSISTANT_KINDS = setOf("config", "news_settings", "briefing_settings")
        private val MODEL_FIELDS = setOf("label", "provider", "model", "enabled", "extra")
        private val MODEL_EXTRA_FIELDS = setOf("reasoning_effort", "reasoning_format")
        private val MODEL_LABEL = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
        private val MODEL_ID = Regex("^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,127}$")
        private val ROUTE_KEY = Regex("^(?:mode:(?:standard|verified|physics|math|business|coding):(?:architect|theorist|empiricist|specialist|pattern|skeptic|debater|judge|method|evidence|refiner|verifier|falsifier[123])|utility:(?:quick|auditor|master_writer|master_auditor|classifier|stripper|verifier|judge|synthesizer|guard_llm))$")
        private val TIME_24H = Regex("^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")
        private val NEWS_LIMIT_RANGES = mapOf(
            "alerts_per_day" to (0L to 10L), "alert_min_score" to (1L to 10L),
            "list_min_score" to (1L to 10L), "tavily_day_cap" to (0L to 1_000L),
            "tavily_month_cap" to (2L to 100_000L), "groq_tokens_cap" to (1_000L to 10_000_000L),
            "groq_calls_cap" to (1L to 100_000L)
        )
    }
}
