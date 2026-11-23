package app.adarsh.ensemble

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.GeneralSecurityException

/** Provider API keys, encrypted with a key held in Android Keystore. Values are never logged or returned to JS in full. */
class SecureKeys(private val ctx: Context) {
    @Volatile private var resetNotice: String? = null
    private val prefs: SharedPreferences = open()

    private fun create(): SharedPreferences {
        val master = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        return EncryptedSharedPreferences.create(
            ctx, FILE, master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    /** Audit L5: a busy Keystore right after boot / unlock is retried first. Only when the file still can not be
     *  opened (Keystore entry lost after a backup restore or lock-screen reset) is it started clean, and the key
     *  screen then tells the user once that the keys must be entered again. */
    private fun open(): SharedPreferences {
        var last: Exception? = null
        for (attempt in 0 until OPEN_ATTEMPTS) {
            try {
                return create()
            } catch (e: Exception) {
                last = e
                Log.w(TAG, "key store open failed (attempt ${attempt + 1}): ${e.javaClass.simpleName}")
                if (attempt + 1 < OPEN_ATTEMPTS) {
                    try { Thread.sleep(250L * (attempt + 1)) } catch (_: InterruptedException) { break }
                }
            }
        }
        val permanent = last?.let { unreadable(it) } ?: false
        Log.w(TAG, "key store unreadable (${last?.javaClass?.simpleName}, permanent=$permanent): starting clean")
        ctx.deleteSharedPreferences(FILE)
        resetNotice = if (permanent)
            "Phone ka secure key store reset ho gaya (backup restore ya screen-lock change). API keys dobara daalo."
        else
            "Secure key store abhi khul nahi paya, isliye reset karna pada. API keys dobara daalo."
        return create()
    }

    private fun unreadable(e: Throwable): Boolean {
        var c: Throwable? = e
        var depth = 0
        while (c != null && depth < 8) {
            if (c is GeneralSecurityException || c.javaClass.name.contains("InvalidProtocolBuffer")) return true
            c = c.cause
            depth++
        }
        return false
    }

    /** One-time message for the key screen after a reset; null normally. */
    fun takeResetNotice(): String? {
        val n = resetNotice
        resetNotice = null
        return n
    }

    fun get(name: String): String? = if (name in NAMES) prefs.getString(name, null)?.takeIf { it.isNotBlank() } else null

    /** The first saved key of a provider: base name, then _2, then _3 (Settings has 3 slots per provider). */
    fun first(base: String): String? = slots(base).firstNotNullOfOrNull { get(it) }

    fun put(name: String, value: String): Boolean {
        if (name !in NAMES || value.isBlank()) return false
        return prefs.edit().putString(name, value.trim()).commit()
    }

    fun remove(name: String): Boolean = name in NAMES && prefs.edit().remove(name).commit()

    /** "…wxyz" for the settings screen, nothing for short keys. */
    fun hint(name: String): String {
        val v = get(name) ?: return ""
        return if (v.length >= 12) "…" + v.takeLast(4) else "saved"
    }

    companion object {
        const val FILE = "adarsh_keys"
        private const val TAG = "SecureKeys"
        private const val OPEN_ATTEMPTS = 3
        const val KEY_SLOTS = 3

        /** Provider env names that have 3 slots: X, X_2, X_3 (Cloudflare: token + account id per slot). */
        private val SLOTTED = listOf(
            "GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
            "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "NVIDIA_API_KEY"
        )

        fun slots(base: String): List<String> = (1..KEY_SLOTS).map { if (it == 1) base else "${base}_$it" }

        /** Keep in sync with android_entry.KEY_NAMES / config.SECRET_ENVS: 15 provider keys + 3 Cloudflare ids + Tavily. */
        val NAMES: List<String> = (1..KEY_SLOTS).flatMap { s -> SLOTTED.map { if (s == 1) it else "${it}_$s" } } +
            listOf("TAVILY_API_KEY")
    }
}
