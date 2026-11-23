package app.adarsh.ensemble

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Private, bounded inbox for replies produced while the WebView is not attached.
 * peek() never removes data; the UI must persist it before ack() is called.
 */
class BackgroundVoiceStore(context: android.content.Context) {
    private val dir = File(context.applicationContext.filesDir, "background_voice")
    private val file = File(dir, "inbox.json")

    fun append(record: JSONObject) = synchronized(LOCK) {
        val normalized = normalize(record)
        val records = readLocked().filterNot { it.optString("id") == normalized.getString("id") }.toMutableList()
        records += normalized
        val bounded = records.sortedBy { it.optLong("ts", 0L) }.takeLast(MAX_RECORDS)
        writeLocked(bounded)
    }

    fun peek(): JSONArray = synchronized(LOCK) {
        val out = JSONArray()
        readLocked().forEach { out.put(JSONObject(it.toString())) }
        out
    }

    fun ack(ids: JSONArray): JSONObject = synchronized(LOCK) {
        val wanted = LinkedHashSet<String>()
        for (i in 0 until ids.length()) {
            val value = ids.opt(i)
            if (value !is String || value.isBlank() || value.length > 160) {
                return@synchronized JSONObject().put("ok", false).put("error", "ids must contain non-empty strings")
            }
            wanted += value
        }
        val before = readLocked()
        val kept = before.filterNot { it.optString("id") in wanted }
        writeLocked(kept)
        JSONObject().put("ok", true).put("acked", before.size - kept.size).put("remaining", kept.size)
    }

    private fun readLocked(): MutableList<JSONObject> {
        if (!file.exists()) return mutableListOf()
        val root = try { JSONArray(file.readText(Charsets.UTF_8)) } catch (_: Exception) {
            throw IllegalStateException("Background voice inbox is corrupted; no changes made")
        }
        val out = mutableListOf<JSONObject>()
        for (i in 0 until root.length()) {
            val raw = root.optJSONObject(i) ?: throw IllegalStateException("Background voice inbox record $i is invalid")
            out += normalize(raw)
        }
        return out
    }

    private fun writeLocked(records: List<JSONObject>) {
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("Could not create background voice inbox")
        val tmp = File(dir, "inbox.json.tmp")
        try {
            FileOutputStream(tmp).use { stream ->
                val root = JSONArray()
                records.forEach { root.put(it) }
                stream.write(root.toString().toByteArray(Charsets.UTF_8))
                stream.fd.sync()
            }
            try {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: Exception) {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } catch (e: Exception) {
            tmp.delete()
            throw IllegalStateException("Could not persist background voice inbox: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    private fun normalize(raw: JSONObject): JSONObject {
        val id = raw.optString("id", "").trim()
        val chatId = raw.optString("chatId", "").trim()
        val text = raw.optString("text", "").trim()
        val mode = raw.optString("mode", "").trim()
        val ts = raw.optLong("ts", 0L)
        if (id.isBlank() || id.length > 160 || chatId.length > 200 || mode.isBlank() || mode.length > 80 || text.isBlank() || text.length > 4000 || ts <= 0L) {
            throw IllegalArgumentException("Invalid background voice inbox record")
        }
        val reply = raw.opt("reply")
        if (reply !is JSONObject && reply !is JSONArray) throw IllegalArgumentException("reply must be an object or array")
        if (raw.opt("localOnly") !is Boolean || raw.opt("personalContext") !is Boolean) {
            throw IllegalArgumentException("localOnly and personalContext must be boolean")
        }
        val out = JSONObject()
            .put("id", id).put("chatId", chatId).put("text", text)
            .put("reply", if (reply is JSONObject) JSONObject(reply.toString()) else JSONArray(reply.toString()))
            .put("mode", mode).put("ts", ts)
            .put("localOnly", raw.getBoolean("localOnly"))
            .put("personalContext", raw.getBoolean("personalContext"))
        if (out.toString().length > MAX_SERIALIZED) throw IllegalArgumentException("Background voice reply is too large")
        return out
    }

    companion object {
        private const val MAX_RECORDS = 64
        private const val MAX_SERIALIZED = 24000
        private val LOCK = Any()
    }
}
