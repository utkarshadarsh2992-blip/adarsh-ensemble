package app.adarsh.ensemble

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Public-release updater. Network and APK work is deliberately kept here so the bridge/UI only
 * needs to display status and make an explicit install request.
 */
class UpdateManager(ctx: Context, private val emit: (JSONObject) -> Unit) {
    private val app = ctx.applicationContext
    private val lock = Any()
    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "adarsh-update").apply { isDaemon = true }
    }
    private val preferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val destroyed = AtomicBoolean(false)

    private var state = STATE_IDLE
    private var message = ""
    private var progress = 0
    private var metadata: UpdateMetadata? = readCachedMetadata()
    private var installInFlight = false

    init {
        synchronized(lock) {
            if (metadata != null) {
                setStateForMetadataLocked()
                message = when (state) {
                    STATE_READY -> "Update is ready to install"
                    STATE_AVAILABLE -> "Update available"
                    else -> "You are up to date"
                }
            }
        }
    }

    data class UpdateMetadata(
        val applicationId: String,
        val versionCode: Long,
        val versionName: String,
        val notes: String,
        val apkName: String,
        val apkUrl: String,
        val sha256: String,
        val size: Long,
        val commit: String,
        val releaseTag: String
    )

    /** Always returns the stable JSON shape consumed by the WebView. */
    fun status(): JSONObject = synchronized(lock) { statusLocked() }

    /** Starts a check unless the successful public-release result is still within the throttle window. */
    fun check(force: Boolean = false): JSONObject {
        synchronized(lock) {
            if (destroyed.get()) return errorLocked("Updater is closed")
            if (state == STATE_CHECKING || state == STATE_DOWNLOADING) return statusLocked()
            if (!force && (state == STATE_READY || state == STATE_PERMISSION_REQUIRED)) return statusLocked()

            val now = System.currentTimeMillis()
            val last = preferences.getLong(KEY_LAST_CHECK, 0L)
            if (!force && now >= last && now - last < CHECK_INTERVAL_MS) {
                setStateForMetadataLocked()
                message = if (metadata == null) "Checked recently" else "Using cached update check"
                return statusLocked()
            }

            state = STATE_CHECKING
            progress = 0
            message = "Checking for updates"
            val result = statusLocked()
            emitSafe(result)
            executor.execute { performCheck() }
            return result
        }
    }

    /** Downloads only the metadata previously accepted by check(), then verifies the APK fully. */
    fun download(): JSONObject {
        synchronized(lock) {
            if (destroyed.get()) return errorLocked("Updater is closed")
            if (state == STATE_CHECKING || state == STATE_DOWNLOADING || installInFlight) return statusLocked()
            val cached = metadata
            if (cached == null) return errorLocked("No verified update is available")
            val validation = validateMetadata(cached, cached.releaseTag, requireNewer = false)
            if (validation != null) return errorLocked(validation)
            if (cached.versionCode <= installedVersionCode()) {
                state = STATE_CURRENT
                message = "Already on the latest version"
                return statusLocked()
            }
            state = STATE_DOWNLOADING
            progress = 0
            message = "Downloading update"
            val result = statusLocked()
            emitSafe(result)
            executor.execute { performDownload(cached) }
            return result
        }
    }

    /**
     * Opens Android's package installer only after the caller's explicit Install tap. On Android O+
     * the first tap opens the per-app unknown-sources screen and returns permission_required; the UI
     * must call install() again after the user grants it.
     */
    fun install(): JSONObject {
        synchronized(lock) {
            if (destroyed.get()) return errorLocked("Updater is closed")
            if (state != STATE_READY && state != STATE_PERMISSION_REQUIRED) return errorLocked("Update is not ready")
            val cached = metadata ?: return errorLocked("No verified update is available")
            val apk = apkFile(cached)
            if (!apk.isFile) return errorLocked("Downloaded update is missing")

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !app.packageManager.canRequestPackageInstalls()) {
                state = STATE_PERMISSION_REQUIRED
                message = "Allow installs from this source, then tap Install again"
                try {
                    val intent = Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${app.packageName}")
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    app.startActivity(intent)
                } catch (_: Exception) {
                    message = "Allow installs from this source in Android settings, then tap Install again"
                }
                val result = statusLocked()
                emitSafe(result)
                return result
            }

            if (installInFlight) return statusLocked()
            installInFlight = true
            val result = statusLocked().put("message", "Opening system installer")
            emitSafe(result)
            executor.execute {
                try {
                    verifyApk(apk, cached)
                    val contentUri = FileProvider.getUriForFile(app, FILE_PROVIDER_AUTHORITY, apk)
                    val intent = Intent(Intent.ACTION_VIEW)
                        .setDataAndType(contentUri, APK_MIME)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    synchronized(lock) {
                        if (destroyed.get()) {
                            installInFlight = false
                        } else {
                            app.startActivity(intent)
                            installInFlight = false
                            message = "System installer opened"
                            emitSafe(statusLocked())
                        }
                    }
                } catch (e: Exception) {
                    synchronized(lock) {
                        if (destroyed.get()) return@synchronized
                        installInFlight = false
                        state = STATE_ERROR
                        message = safeMessage(e)
                        emitSafe(statusLocked())
                    }
                }
            }
            return result
        }
    }

    fun destroy() {
        if (destroyed.compareAndSet(false, true)) {
            executor.shutdownNow()
            synchronized(lock) {
                state = STATE_IDLE
                message = ""
                installInFlight = false
            }
        }
    }

    private fun performCheck() {
        try {
            val releaseJson = fetchJson(LATEST_RELEASE_URL, MAX_RELEASE_BYTES, RequestKind.API)
            val tag = releaseJson.optString("tag_name", "")
            if (!SAFE_TAG.matches(tag)) throw IOException("Invalid release tag")
            val assets = releaseJson.optJSONArray("assets") ?: throw IOException("Release has no assets")
            val updateAsset = findAsset(assets, UPDATE_MANIFEST_NAME)
                ?: throw IOException("Release has no update.json asset")
            val updateUrl = updateAsset.optString("browser_download_url", "")
            requireExactAssetUrl(updateUrl, tag, UPDATE_MANIFEST_NAME)
            val manifest = fetchJson(updateUrl, MAX_MANIFEST_BYTES, RequestKind.RELEASE_ASSET)
            val parsed = parseAndValidateManifest(manifest, tag)
            synchronized(lock) {
                metadata = parsed
                preferences.edit()
                    .putLong(KEY_LAST_CHECK, System.currentTimeMillis())
                    .putString(KEY_METADATA, metadataJson(parsed).toString())
                    .apply()
                setStateForMetadataLocked()
                message = if (state == STATE_AVAILABLE) "Update available" else "You are up to date"
                emitSafe(statusLocked())
            }
        } catch (e: Exception) {
            synchronized(lock) {
                state = STATE_ERROR
                progress = 0
                message = safeMessage(e)
                emitSafe(statusLocked())
            }
        }
    }

    private fun performDownload(cached: UpdateMetadata) {
        val updateDir = File(app.cacheDir, UPDATE_DIRECTORY)
        val apk = apkFile(cached)
        val part = File(apk.path + ".part")
        try {
            updateDir.mkdirs()
            updateDir.listFiles()?.filter { it.name.endsWith(".part") && it != part }?.forEach { it.delete() }
            part.delete()
            downloadToFile(cached.apkUrl, part, cached.size)
            if (sha256(part) != cached.sha256) throw IOException("Downloaded update checksum does not match")
            verifyApk(part, cached)
            if (apk.exists() && !apk.delete()) throw IOException("Could not replace cached update")
            if (!part.renameTo(apk)) {
                if (!part.delete()) throw IOException("Could not finalize downloaded update")
                throw IOException("Could not finalize downloaded update")
            }
            synchronized(lock) {
                state = STATE_READY
                progress = 100
                message = "Update is ready to install"
                emitSafe(statusLocked())
            }
        } catch (e: Exception) {
            part.delete()
            synchronized(lock) {
                state = STATE_ERROR
                progress = 0
                message = safeMessage(e)
                emitSafe(statusLocked())
            }
        }
    }

    private fun downloadToFile(url: String, destination: File, expectedSize: Long) {
        val connection = openConnection(url, RequestKind.RELEASE_ASSET)
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                throw IOException("Download failed with HTTP ${connection.responseCode}")
            }
            val reported = connection.contentLengthLong
            if (reported > MAX_APK_BYTES || (reported >= 0 && reported != expectedSize)) {
                throw IOException("Downloaded update has an unexpected size")
            }
            var total = 0L
            val buffer = ByteArray(32 * 1024)
            destination.outputStream().use { output ->
                connection.inputStream.use { input ->
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > expectedSize || total > MAX_APK_BYTES) throw IOException("Update is too large")
                        output.write(buffer, 0, count)
                        val nextProgress = ((total * 100L) / expectedSize.coerceAtLeast(1L)).toInt().coerceAtMost(99)
                        synchronized(lock) {
                            if (nextProgress != progress) {
                                progress = nextProgress
                                message = "Downloading update ($progress%)"
                                emitSafe(statusLocked())
                            }
                        }
                    }
                }
            }
            if (total != expectedSize) throw IOException("Downloaded update is incomplete")
        } finally {
            connection.disconnect()
        }
    }

    private fun parseAndValidateManifest(json: JSONObject, releaseTag: String): UpdateMetadata {
        val schema = json.optInt("schema", -1)
        if (schema != 1) throw IOException("Unsupported update manifest schema")
        val applicationId = json.optString("applicationId", "")
        if (applicationId != app.packageName) throw IOException("Update belongs to another application")
        val versionCode = json.optLong("versionCode", -1L)
        val versionName = json.optString("versionName", "")
        if (versionCode <= 0L || versionName.isBlank()) throw IOException("Invalid update version")
        val apk = json.optJSONObject("apk") ?: throw IOException("Manifest has no APK")
        val name = apk.optString("name", "")
        val url = apk.optString("url", "")
        val sha = apk.optString("sha256", "").lowercase(Locale.US)
        val size = apk.optLong("size", -1L)
        val commit = json.optString("commit", "")
        if (!SAFE_ASSET_NAME.matches(name)) throw IOException("Invalid APK asset name")
        requireExactAssetUrl(url, releaseTag, name)
        if (!SHA256.matches(sha)) throw IOException("Invalid APK checksum")
        if (size <= 0L || size > MAX_APK_BYTES) throw IOException("Invalid APK size")
        if (!SAFE_COMMIT.matches(commit)) throw IOException("Invalid release commit")
        val notes = json.optString("notes", "").take(MAX_NOTES_LENGTH)
        val result = UpdateMetadata(app.packageName, versionCode, versionName, notes, name, url, sha, size, commit, releaseTag)
        validateMetadata(result, releaseTag, requireNewer = false)?.let { throw IOException(it) }
        return result
    }

    private fun validateMetadata(value: UpdateMetadata, expectedTag: String, requireNewer: Boolean = true): String? {
        if (value.applicationId != app.packageName) return "Update belongs to another application"
        if (value.versionCode <= 0L) return "Invalid update version"
        if (requireNewer && value.versionCode <= installedVersionCode()) return "Update is not newer than installed version"
        if (!value.versionName.isNotBlank()) return "Manifest has no version name"
        if (!SAFE_ASSET_NAME.matches(value.apkName)) return "Invalid APK asset name"
        if (!SHA256.matches(value.sha256)) return "Invalid APK checksum"
        if (value.size <= 0L || value.size > MAX_APK_BYTES) return "Invalid APK size"
        if (!SAFE_COMMIT.matches(value.commit)) return "Invalid release commit"
        return try {
            requireExactAssetUrl(value.apkUrl, expectedTag, value.apkName)
            null
        } catch (e: Exception) { safeMessage(e) }
    }

    private fun verifyApk(file: File, expected: UpdateMetadata) {
        if (!file.isFile || file.length() != expected.size) throw IOException("APK size verification failed")
        if (sha256(file) != expected.sha256) throw IOException("APK checksum verification failed")
        if (expected.versionCode <= installedVersionCode()) throw IOException("APK is not newer than installed app")
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION") android.content.pm.PackageManager.GET_SIGNATURES
        }
        val info = app.packageManager.getPackageArchiveInfo(file.path, flags)
            ?: throw IOException("Downloaded file is not a valid APK")
        val actualVersion = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else {
            @Suppress("DEPRECATION") info.versionCode.toLong()
        }
        if (info.packageName != app.packageName) throw IOException("APK package name does not match")
        if (actualVersion != expected.versionCode || info.versionName != expected.versionName) {
            throw IOException("APK version does not match update manifest")
        }
        val installedCertificates = signingDigests(app.packageManager.getPackageInfo(app.packageName, flags))
        val apkCertificates = signingDigests(info)
        if (installedCertificates.isEmpty() || apkCertificates.intersect(installedCertificates).isEmpty()) {
            throw IOException("APK signing certificate does not match installed app")
        }
    }

    private fun signingDigests(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signing = info.signingInfo ?: return emptySet()
            signing.apkContentsSigners.toList()
        } else {
            @Suppress("DEPRECATION") info.signatures?.toList() ?: emptyList()
        }
        return signatures.map { sha256(it.toByteArray()) }.toSet()
    }

    private fun readCachedMetadata(): UpdateMetadata? {
        val raw = preferences.getString(KEY_METADATA, null) ?: return null
        return try {
            val json = JSONObject(raw)
            val tag = json.optString("releaseTag", "")
            val apk = json.getJSONObject("apk")
            val value = UpdateMetadata(
                json.getString("applicationId"), json.getLong("versionCode"), json.getString("versionName"),
                json.optString("notes", ""), apk.getString("name"), apk.getString("url"),
                apk.getString("sha256").lowercase(Locale.US), apk.getLong("size"), json.getString("commit"), tag
            )
            if (validateMetadata(value, tag, requireNewer = false) == null) value else null
        } catch (_: Exception) { null }
    }

    private fun metadataJson(value: UpdateMetadata): JSONObject = JSONObject()
        .put("schema", 1)
        .put("applicationId", value.applicationId)
        .put("versionCode", value.versionCode)
        .put("versionName", value.versionName)
        .put("notes", value.notes)
        .put("commit", value.commit)
        .put("releaseTag", value.releaseTag)
        .put("apk", JSONObject().put("name", value.apkName).put("url", value.apkUrl).put("sha256", value.sha256).put("size", value.size))

    private fun findAsset(assets: JSONArray, name: String): JSONObject? {
        for (i in 0 until assets.length()) {
            val asset = assets.optJSONObject(i) ?: continue
            if (asset.optString("name") == name) return asset
        }
        return null
    }

    private fun fetchJson(url: String, maxBytes: Int, kind: RequestKind): JSONObject {
        val connection = openConnection(url, kind)
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) throw IOException("Update check failed with HTTP ${connection.responseCode}")
            return JSONObject(readLimited(connection, maxBytes).toString(Charsets.UTF_8))
        } finally { connection.disconnect() }
    }

    private fun readLimited(connection: HttpURLConnection, maxBytes: Int): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        connection.inputStream.use { input ->
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size() + count > maxBytes) throw IOException("Update response is too large")
                output.write(buffer, 0, count)
            }
        }
        return output.toByteArray()
    }

    private fun openConnection(initialUrl: String, kind: RequestKind): HttpURLConnection {
        var current = URI(initialUrl)
        repeat(MAX_REDIRECTS + 1) { hop ->
            validateUrl(current, kind, hop == 0)
            val connection = (current.toURL().openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = NETWORK_TIMEOUT_MS
                readTimeout = NETWORK_TIMEOUT_MS
                requestMethod = "GET"
                setRequestProperty("Accept", if (kind == RequestKind.API) "application/vnd.github+json" else "application/octet-stream")
                setRequestProperty("User-Agent", "Adarsh-Ensemble-Updater")
            }
            val code = connection.responseCode
            if (code in 300..399) {
                val location = connection.getHeaderField("Location") ?: throw IOException("Update redirect has no location")
                connection.disconnect()
                current = current.resolve(location)
                if (hop == MAX_REDIRECTS) throw IOException("Too many update redirects")
            } else return connection
        }
        throw IOException("Too many update redirects")
    }

    private fun validateUrl(uri: URI, kind: RequestKind, firstHop: Boolean) {
        if (uri.scheme != "https" || uri.userInfo != null || uri.port != -1) throw IOException("Update URL must use HTTPS")
        val host = uri.host?.lowercase(Locale.US) ?: throw IOException("Update URL has no host")
        when (kind) {
            RequestKind.API -> {
                if (host != "api.github.com" || uri.path != API_RELEASE_PATH) throw IOException("Unexpected GitHub API URL")
            }
            RequestKind.RELEASE_ASSET -> {
                if (firstHop) {
                    if (host != "github.com") throw IOException("Unexpected GitHub release URL")
                } else if (host !in CDN_HOSTS) {
                    throw IOException("Unexpected GitHub asset redirect")
                }
            }
        }
    }

    private fun requireExactAssetUrl(raw: String, tag: String, assetName: String) {
        val uri = try { URI(raw) } catch (_: Exception) { throw IOException("Invalid GitHub asset URL") }
        if (uri.scheme != "https" || uri.host?.lowercase(Locale.US) != "github.com" || uri.userInfo != null || uri.port != -1) {
            throw IOException("APK asset must be a GitHub HTTPS release URL")
        }
        val expected = "/$REPOSITORY/releases/download/$tag/$assetName"
        if (uri.path != expected || uri.rawQuery != null || uri.rawFragment != null) throw IOException("Unexpected GitHub asset path")
    }

    private fun setStateForMetadataLocked() {
        val cached = metadata
        state = when {
            cached == null || cached.versionCode <= installedVersionCode() -> STATE_CURRENT
            apkFile(cached).isFile -> STATE_READY
            else -> STATE_AVAILABLE
        }
        progress = if (state == STATE_READY) 100 else 0
    }

    private fun installedVersionCode(): Long = try {
        val info = app.packageManager.getPackageInfo(app.packageName, 0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else {
            @Suppress("DEPRECATION") info.versionCode.toLong()
        }
    } catch (_: Exception) { 0L }

    private fun installedVersionName(): String = try {
        app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: ""
    } catch (_: Exception) { "" }

    private fun apkFile(value: UpdateMetadata): File = File(File(app.cacheDir, UPDATE_DIRECTORY), "${value.sha256}.apk")

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().toHex()
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

    private fun statusLocked(): JSONObject {
        val installedCode = installedVersionCode()
        val current = metadata
        return JSONObject()
            .put("ok", state != STATE_ERROR)
            .put("state", state)
            .put("installedVersion", installedVersionName())
            .put("versionCode", current?.versionCode ?: installedCode)
            .put("versionName", current?.versionName ?: "")
            .put("notes", current?.notes ?: "")
            .put("progress", progress.coerceIn(0, 100))
            .put("message", message)
    }

    private fun errorLocked(text: String): JSONObject {
        state = STATE_ERROR
        message = text
        return statusLocked()
    }

    private fun emitSafe(value: JSONObject) {
        if (!destroyed.get()) try { emit(value) } catch (_: Exception) {}
    }

    private fun safeMessage(error: Throwable): String = error.message?.take(240)?.ifBlank { error.javaClass.simpleName } ?: error.javaClass.simpleName

    private enum class RequestKind { API, RELEASE_ASSET }

    private companion object {
        const val PREFS = "adarsh_updates"
        const val KEY_LAST_CHECK = "last_check_ms"
        const val KEY_METADATA = "verified_manifest"
        const val UPDATE_DIRECTORY = "updates"
        const val UPDATE_MANIFEST_NAME = "update.json"
        const val FILE_PROVIDER_AUTHORITY = "app.adarsh.ensemble.updates"
        const val APK_MIME = "application/vnd.android.package-archive"
        const val REPOSITORY = "utkarshadarsh2992-blip/adarsh-ensemble"
        const val LATEST_RELEASE_URL = "https://api.github.com/repos/$REPOSITORY/releases/latest"
        const val API_RELEASE_PATH = "/repos/$REPOSITORY/releases/latest"
        const val CHECK_INTERVAL_MS = 6L * 60L * 60L * 1000L
        const val NETWORK_TIMEOUT_MS = 20_000
        const val MAX_REDIRECTS = 4
        const val MAX_RELEASE_BYTES = 64 * 1024
        const val MAX_MANIFEST_BYTES = 64 * 1024
        const val MAX_APK_BYTES = 150L * 1024L * 1024L
        const val MAX_NOTES_LENGTH = 8_192
        val SAFE_TAG = Regex("[A-Za-z0-9._-]{1,80}")
        val SAFE_ASSET_NAME = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
        val SAFE_COMMIT = Regex("[0-9a-fA-F]{7,64}")
        val SHA256 = Regex("[0-9a-fA-F]{64}")
        val CDN_HOSTS = setOf(
            "objects.githubusercontent.com",
            "release-assets.githubusercontent.com",
            "github-releases.githubusercontent.com"
        )

        const val STATE_IDLE = "idle"
        const val STATE_CHECKING = "checking"
        const val STATE_AVAILABLE = "available"
        const val STATE_CURRENT = "current"
        const val STATE_DOWNLOADING = "downloading"
        const val STATE_READY = "ready"
        const val STATE_PERMISSION_REQUIRED = "permission_required"
        const val STATE_ERROR = "error"

        private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(Locale.US, it.toInt() and 0xff) }
    }
}
