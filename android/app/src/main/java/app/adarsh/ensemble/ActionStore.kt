package app.adarsh.ensemble

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Reminders, alarms, timers and notes on disk (app-private JSON). They survive restarts and are re-armed on boot,
 * so a reminder set today still fires tomorrow after the phone reboots.
 */
class ActionStore(ctx: Context) {
    private val file = File(ctx.filesDir, "actions.json")
    private val lock = Any()

    private fun read(): JSONArray = synchronized(lock) {
        try { if (file.exists()) JSONArray(file.readText()) else JSONArray() } catch (_: Exception) { JSONArray() }
    }

    private fun write(a: JSONArray) = synchronized(lock) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(a.toString())
        tmp.renameTo(file)
    }

    fun all(): List<JSONObject> = (0 until read().length()).map { read().getJSONObject(it) }

    fun add(kind: String, text: String, at: Long): JSONObject {
        val o = JSONObject().put("id", "a" + System.currentTimeMillis().toString(36) + ((System.nanoTime() % 9000) + 1000))
            .put("kind", kind).put("text", text).put("at", at).put("created", System.currentTimeMillis())
        val a = read(); a.put(o); write(a)
        return o
    }

    fun remove(id: String) {
        val a = read(); val out = JSONArray()
        for (i in 0 until a.length()) if (a.getJSONObject(i).optString("id") != id) out.put(a.getJSONObject(i))
        write(out)
    }

    fun notes(): List<JSONObject> = all().filter { it.optString("kind") == "note" }.sortedByDescending { it.optLong("created") }

    fun clearNotes() {
        val a = read(); val out = JSONArray()
        for (i in 0 until a.length()) if (a.getJSONObject(i).optString("kind") != "note") out.put(a.getJSONObject(i))
        write(out)
    }

    /** Everything still in the future (used by the boot receiver). */
    fun upcoming(now: Long = System.currentTimeMillis()): List<JSONObject> =
        all().filter { it.optLong("at") > now && it.optString("kind") != "note" }
}
