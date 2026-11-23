package app.adarsh.ensemble

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeParseException
import java.util.UUID

/**
 * The native record store. All instances for this process use the same lock: a WebView call,
 * a boot receiver, and a firing receiver must never read/write independent snapshots.
 *
 * The file is replaced through a flushed temporary file. A malformed existing file is an error,
 * never an empty store, so a storage problem cannot silently destroy records.
 */
class ActionStore(ctx: Context) {
    private val file = File(ctx.applicationContext.filesDir, FILE_NAME)

    fun all(): List<JSONObject> = synchronized(PROCESS_LOCK) { readLocked().map { JSONObject(it.toString()) } }

    fun notes(): List<JSONObject> = all()
        .filter { it.optString("kind") == "note" }
        .sortedByDescending { it.optLong("updated", it.optLong("created")) }

    fun upcoming(now: Long = System.currentTimeMillis()): List<JSONObject> = all().filter {
        val kind = it.optString("kind")
        val at = it.optLong("at", 0L)
        at > now && kind in SCHEDULED_KINDS && !(kind == "task" && it.optBoolean("done", false))
    }

    fun find(id: String): JSONObject? = synchronized(PROCESS_LOCK) {
        readLocked().firstOrNull { it.optString("id") == id }?.let { JSONObject(it.toString()) }
    }

    /** Run a read/modify/write operation atomically. The block may mutate the list in place. */
    fun <T> transaction(block: (MutableList<JSONObject>) -> T): T = synchronized(PROCESS_LOCK) {
        val records = readLocked()
        val result = block(records)
        writeLocked(records)
        result
    }

    /** A read-only operation under the same process-wide lock. */
    fun <T> readLocked(block: (List<JSONObject>) -> T): T = synchronized(PROCESS_LOCK) {
        block(readLocked())
    }

    /** Legacy helper retained for existing callers; new callers should use transaction. */
    fun remove(id: String): Boolean = transaction { records ->
        val index = records.indexOfFirst { it.optString("id") == id }
        if (index < 0) false else {
            records.removeAt(index)
            true
        }
    }

    fun clearNotes(): Int = transaction { records ->
        val before = records.size
        records.removeAll { it.optString("kind") == "note" }
        before - records.size
    }

    /** Mark a firing without removing its persistent record. */
    fun markFired(id: String, firedAt: Long = System.currentTimeMillis()): JSONObject? = transaction { records ->
        val record = records.firstOrNull { it.optString("id") == id } ?: return@transaction null
        record.put("firedAt", firedAt).put("updated", firedAt)
        JSONObject(record.toString())
    }

    /** Merge only validated records. A native record wins ties and wins when it is newer. */
    fun importRecords(input: JSONArray): ImportResult = transaction { records ->
        val byId = records.associateBy { it.optString("id") }.toMutableMap()
        var imported = 0
        var skipped = 0
        for (i in 0 until input.length()) {
            val raw = input.opt(i)
            if (raw !is JSONObject) throw StoreException("records[$i] must be an object")
            // Imports may use legacy record shapes, but never arbitrary fields such as paths,
            // secrets, or executable instructions.
            val incoming = normalizeAndValidate(raw, allowLegacy = false, index = i)
            val current = byId[incoming.getString("id")]
            if (current == null) {
                records.add(incoming)
                byId[incoming.getString("id")] = incoming
                imported++
            } else {
                val currentVersion = version(current)
                val incomingVersion = version(incoming)
                if (incomingVersion > currentVersion) {
                    val index = records.indexOf(current)
                    records[index] = incoming
                    byId[incoming.getString("id")] = incoming
                    imported++
                } else {
                    skipped++
                }
            }
        }
        ImportResult(imported, skipped)
    }

    fun newId(prefix: String = "r"): String = prefix + UUID.randomUUID().toString().replace("-", "").take(20)

    private fun readLocked(): MutableList<JSONObject> {
        if (!file.exists()) return mutableListOf()
        val text = try { file.readText(Charsets.UTF_8) } catch (e: Exception) {
            throw StoreException("Could not read native records: ${e.message ?: e.javaClass.simpleName}")
        }
        val root = try { JSONArray(text) } catch (e: Exception) {
            throw StoreException("Native records are corrupted; no changes made")
        }
        val out = mutableListOf<JSONObject>()
        for (i in 0 until root.length()) {
            val raw = root.opt(i)
            if (raw !is JSONObject) throw StoreException("Native records are corrupted at index $i; no changes made")
            out += normalizeAndValidate(raw, allowLegacy = true, index = i)
        }
        return out
    }

    private fun writeLocked(records: List<JSONObject>) {
        val parent = file.parentFile ?: throw StoreException("Native record directory is unavailable")
        if (!parent.exists() && !parent.mkdirs()) throw StoreException("Could not create native record directory")
        val tmp = File(parent, "$FILE_NAME.tmp")
        try {
            FileOutputStream(tmp).use { stream ->
                stream.write(JSONArray(records).toString().toByteArray(Charsets.UTF_8))
                stream.fd.sync()
            }
            try {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: Exception) {
                // Some Android filesystems do not expose ATOMIC_MOVE. Do not delete the old file;
                // a normal replace is still safer than renameTo's silent boolean failure.
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } catch (e: Exception) {
            tmp.delete()
            throw StoreException("Could not persist native records; no changes made: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    companion object {
        private const val FILE_NAME = "actions.json"
        private val PROCESS_LOCK = Any()
        val SCHEDULED_KINDS = setOf("task", "reminder", "alarm", "timer")
        val RECORD_KINDS = setOf("task", "reminder", "alarm", "timer", "note", "work")
        val IMPORT_KEYS = setOf(
            "id", "kind", "title", "text", "at", "created", "updated", "done", "firedAt",
            "category", "goal", "progress", "minutes", "outcome", "entries"
        )
        private val ENTRY_KEYS = setOf("id", "date", "minutes", "text", "progress", "outcome")

        fun nowRecord(kind: String, id: String, title: String? = null, text: String? = null, at: Long? = null): JSONObject {
            val now = System.currentTimeMillis()
            val o = JSONObject().put("id", id).put("kind", kind).put("created", now).put("updated", now)
            if (title != null) o.put("title", title)
            if (text != null) o.put("text", text)
            if (at != null) o.put("at", at)
            return o
        }

        fun normalizeAndValidate(raw: JSONObject, allowLegacy: Boolean, index: Int = -1): JSONObject {
            val o = JSONObject(raw.toString())
            if (!allowLegacy) {
                for (key in o.keys()) if (key !in IMPORT_KEYS) throw StoreException("Unsupported record field '$key'")
            }
            val id = stringField(o, "id", required = true)
            val kind = stringField(o, "kind", required = true)
            if (id.isNullOrBlank()) throw StoreException("Record requires non-empty id")
            if (kind.isNullOrBlank()) throw StoreException("Record requires non-empty kind")
            if (kind !in RECORD_KINDS) throw StoreException("Unsupported record kind '$kind'")
            o.put("id", id).put("kind", kind)

            val now = System.currentTimeMillis()
            val created = longField(o, "created", required = false) ?: now
            val updated = longField(o, "updated", required = false) ?: created
            if (created <= 0L || updated <= 0L) throw StoreException("Record ${label(index, id)} has invalid created/updated time")
            o.put("created", created).put("updated", updated)

            // Old records used text for every kind. Notes and scheduled records keep text;
            // task/work records use title as their canonical notification/display field.
            if ((kind == "task" || kind == "work") && !o.has("title")) {
                val legacyTitle = stringField(o, "text", required = false)
                if (!legacyTitle.isNullOrBlank()) o.put("title", legacyTitle)
            }
            if (kind == "task" || kind == "work") o.remove("text")
            if (kind == "note" && !o.has("text")) {
                val legacyText = stringField(o, "title", required = false)
                if (!legacyText.isNullOrBlank()) o.put("text", legacyText)
            }
            if (kind == "note") requireText(o, "text", label(index, id))
            if (kind == "task" || kind == "work") requireText(o, "title", label(index, id))
            if (kind in setOf("reminder", "alarm", "timer")) {
                if (!o.has("text") && o.has("title")) o.put("text", stringField(o, "title", true)!!)
                requireText(o, "text", label(index, id))
            }
            if (o.has("at")) {
                val at = longField(o, "at", required = true)!!
                if (at <= 0L) throw StoreException("Record ${label(index, id)} has invalid at")
                o.put("at", at)
            }
            if (o.has("done")) booleanField(o, "done")
            if (o.has("firedAt")) {
                val fired = longField(o, "firedAt", required = true)!!
                if (fired <= 0L) throw StoreException("Record ${label(index, id)} has invalid firedAt")
            }
            if (kind == "work") validateWorkFields(o, label(index, id), allowLegacy)
            return o
        }

        private fun validateWorkFields(o: JSONObject, label: String, allowLegacy: Boolean) {
            if (o.has("category")) stringField(o, "category", false)
            if (o.has("goal")) stringField(o, "goal", false)
            if (o.has("outcome")) stringField(o, "outcome", false)
            if (o.has("progress")) {
                val progress = numberField(o, "progress")
                if (progress !in 0.0..100.0) throw StoreException("Work record $label progress must be 0..100")
                o.put("progress", progress)
            }
            if (o.has("minutes")) {
                val minutes = numberField(o, "minutes")
                if (minutes < 0 || minutes % 1.0 != 0.0) throw StoreException("Work record $label minutes must be a non-negative integer")
                o.put("minutes", minutes.toLong())
            }
            if (o.has("entries")) {
                val entries = o.optJSONArray("entries") ?: throw StoreException("Work record $label entries must be an array")
                for (i in 0 until entries.length()) {
                    val entry = entries.optJSONObject(i) ?: throw StoreException("Work record $label entry $i must be an object")
                    for (key in entry.keys()) if (key !in ENTRY_KEYS) throw StoreException("Unsupported work entry field '$key'")
                    stringField(entry, "id", true)
                    val date = stringField(entry, "date", true)!!
                    entry.put("date", normalizeActivityDate(date, "$label entry $i"))
                    stringField(entry, "text", true)
                    if (entry.has("minutes")) {
                        val m = numberField(entry, "minutes")
                        if (m < 0 || m > 1440 || m % 1.0 != 0.0) throw StoreException("Work record $label entry $i minutes must be a whole number from 0 to 1440")
                    }
                    if (entry.has("progress")) {
                        val p = numberField(entry, "progress")
                        if (p !in 0.0..100.0) throw StoreException("Work record $label entry $i progress is invalid")
                    }
                    if (entry.has("outcome")) stringField(entry, "outcome", false)
                }
            } else if (!allowLegacy) {
                o.put("entries", JSONArray())
            }
        }

        private fun requireText(o: JSONObject, key: String, label: String) {
            val value = stringField(o, key, true)?.trim() ?: ""
            if (value.isBlank()) throw StoreException("Record $label requires non-empty $key")
            o.put(key, value)
        }

        private fun stringField(o: JSONObject, key: String, required: Boolean): String? {
            if (!o.has(key) || o.isNull(key)) {
                if (required) throw StoreException("Record requires string $key")
                return null
            }
            val value = o.opt(key)
            if (value !is String) throw StoreException("Record field $key must be a string")
            return value
        }

        private fun longField(o: JSONObject, key: String, required: Boolean): Long? {
            if (!o.has(key) || o.isNull(key)) {
                if (required) throw StoreException("Record requires integer $key")
                return null
            }
            val value = o.opt(key)
            if (value is Int || value is Long || value is Short || value is Byte) return (value as Number).toLong()
            if (value is Double && value.isFinite() && value % 1.0 == 0.0) return value.toLong()
            throw StoreException("Record field $key must be an integer")
        }

        private fun booleanField(o: JSONObject, key: String): Boolean {
            val value = o.opt(key)
            if (value !is Boolean) throw StoreException("Record field $key must be boolean")
            return value
        }

        fun numberField(o: JSONObject, key: String): Double {
            val value = o.opt(key)
            if (value !is Number) throw StoreException("Record field $key must be a number")
            val n = value.toDouble()
            if (!n.isFinite()) throw StoreException("Record field $key must be finite")
            return n
        }

        private fun normalizeActivityDate(value: String, label: String): String {
            if (value.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) {
                return try {
                    LocalDate.parse(value).toString()
                } catch (_: DateTimeParseException) {
                    throw StoreException("Work record $label date must be ISO YYYY-MM-DD or an ISO instant")
                }
            }
            return try {
                Instant.parse(value).atZone(ZoneId.systemDefault()).toLocalDate().toString()
            } catch (_: DateTimeParseException) {
                throw StoreException("Work record $label date must be ISO YYYY-MM-DD or an ISO instant")
            }
        }

        private fun version(o: JSONObject): Long = o.optLong("updated", o.optLong("created", 0L))
        private fun label(index: Int, id: String): String = if (index >= 0) "#$index ($id)" else id
    }

    data class ImportResult(val imported: Int, val skipped: Int)

    class StoreException(message: String) : IllegalStateException(message)

}
