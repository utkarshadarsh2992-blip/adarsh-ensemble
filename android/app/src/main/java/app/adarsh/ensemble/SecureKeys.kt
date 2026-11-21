package app.adarsh.ensemble

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Provider API keys, encrypted with a key held in Android Keystore. Values are never logged or returned to JS in full. */
class SecureKeys(private val ctx: Context) {
    private val prefs: SharedPreferences = open()

    private fun create(): SharedPreferences {
        val master = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        return EncryptedSharedPreferences.create(
            ctx, FILE, master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    // If the Keystore entry was lost (backup restore, lock-screen reset), the old file cannot be read: start clean.
    private fun open(): SharedPreferences = try {
        create()
    } catch (e: Exception) {
        ctx.deleteSharedPreferences(FILE)
        create()
    }

    fun get(name: String): String? = if (name in NAMES) prefs.getString(name, null)?.takeIf { it.isNotBlank() } else null

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
        val NAMES = listOf("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY")
    }
}
