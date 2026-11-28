package app.adarsh.ensemble

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.CalendarContract
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeParseException
import java.util.Calendar

/** Native standard-mode executor. It never trusts action risk metadata supplied by JavaScript. */
class ActionRunner(private val ctx: Context) {
    private val store = ActionStore(ctx)

    private val packages = mapOf(
        "whatsapp" to "com.whatsapp", "youtube" to "com.google.android.youtube",
        "instagram" to "com.instagram.android", "telegram" to "org.telegram.messenger",
        "gmail" to "com.google.android.gm", "maps" to "com.google.android.apps.maps",
        "settings" to "com.android.settings", "chrome" to "com.android.chrome",
        "spotify" to "com.spotify.music", "messages" to "com.google.android.apps.messaging",
        "calculator" to "com.google.android.calculator", "clock" to "com.google.android.deskclock",
        "photos" to "com.google.android.apps.photos", "calendar" to "com.google.android.calendar",
        "drive" to "com.google.android.apps.docs", "facebook" to "com.facebook.katana",
        "twitter" to "com.twitter.android", "netflix" to "com.netflix.mediaclient",
        "paytm" to "net.one97.paytm", "phonepe" to "com.phonepe.app",
        "gpay" to "com.google.android.apps.nbu.paisa.user", "playstore" to "com.android.vending"
    )
    private val names = mapOf("whatsapp" to "WhatsApp", "youtube" to "YouTube", "instagram" to "Instagram",
        "telegram" to "Telegram", "gmail" to "Gmail", "maps" to "Maps", "settings" to "Settings",
        "chrome" to "Chrome", "spotify" to "Spotify", "messages" to "Messages", "calculator" to "Calculator",
        "clock" to "Clock", "photos" to "Photos", "calendar" to "Calendar", "drive" to "Drive",
        "facebook" to "Facebook", "twitter" to "X", "netflix" to "Netflix", "paytm" to "Paytm",
        "phonepe" to "PhonePe", "gpay" to "GPay", "playstore" to "Play Store")

    fun run(step: JSONObject, confirmed: Boolean): JSONObject {
        val id = string(step, "id", "step")
        val action = string(step, "action", "step")
        val args = if (!step.has("args") || step.isNull("args")) JSONObject() else
            step.optJSONObject("args") ?: return error(id, "args must be an object")

        if (action == "note.clear" || action.contains("delete", ignoreCase = true) || action.contains("clear", ignoreCase = true)) {
            return error(id, "Delete and clear actions are not available in native standard mode")
        }
        if (action == "dnd.set" || action == "panel.open") {
            return error(id, "$action is not available in native standard mode")
        }
        val requestedApp = stringOptional(args, "app")?.trim()
        if (action == "app.open" && (requestedApp?.equals("settings", true) == true || requestedApp == "com.android.settings")) {
            return error(id, "Opening Settings is not available in native standard mode")
        }
        if (action == "message.draft" || action == "call.dial") {
            // Risk is derived here, not read from step.risk or args.risk.
            if (!confirmed) return error(id, "Confirmation chahiye for $action")
        }

        return try {
            when (action) {
                "task.add" -> taskAdd(id, args)
                "task.edit" -> taskEdit(id, args)
                "task.done" -> taskDone(id, args)
                "task.list" -> list(id, "task")
                "note.add" -> noteAdd(id, args)
                "note.edit" -> noteEdit(id, args)
                "note.list" -> list(id, "note")
                "reminder.add" -> scheduledAdd(id, "reminder", args)
                "reminder.edit" -> scheduledEdit(id, "reminder", args)
                "reminder.list" -> list(id, "reminder")
                "alarm.add" -> scheduledAdd(id, "alarm", args)
                "alarm.edit" -> scheduledEdit(id, "alarm", args)
                "alarm.list" -> list(id, "alarm")
                "timer.start" -> timerAdd(id, args)
                "work.add" -> workAdd(id, args)
                "work.edit" -> workEdit(id, args)
                "work.log" -> workLog(id, args)
                "work.list" -> list(id, "work")
                // Existing non-record standard actions remain compatible, except for denied settings/DND/panel paths.
                "app.open" -> openApp(id, requiredString(args, "app"))
                "web.search" -> {
                    val query = requiredString(args, "query")
                    go(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/search?q=" + Uri.encode(query))))
                    ok(id, "Search khol raha hoon")
                }
                "phone.status" -> ok(id, statusText(), "status")
                "calendar.add" -> calendar(id, args)
                "voice.open" -> ok(id, "Voice mode", "voice")
                "message.draft" -> draft(id, args)
                "call.dial" -> dial(id, args)
                "torch.set" -> torch(id, requiredBoolean(args, "on"))
                "settings.update", "memory.add", "memory.update", "memory.delete" ->
                    error(id, "Settings and memory operations are JS-only")
                else -> error(id, "Unsupported native action '$action'")
            }
        } catch (e: Exception) {
            error(id, e.message ?: e.javaClass.simpleName)
        }
    }

    // ---- task / note records
    private fun taskAdd(id: String, a: JSONObject): JSONObject {
        val title = requiredString(a, "title")
        val at = optionalTime(a, "at")
        if (at != null) requireFuture(at)
        val record = ActionStore.nowRecord("task", store.newId("t"), title = title, at = at)
            .put("done", false)
        return saveNew(id, record, schedule = at != null, label = "Task", success = "Task save ho gaya")
    }

    private fun taskEdit(id: String, a: JSONObject): JSONObject = store.transaction { records ->
        val index = resolveIndex(records, a, "task")
        val old = JSONObject(records[index].toString())
        if (old.optString("kind") != "task") throw IllegalArgumentException("Record is not a task")
        val record = records[index]
        var changed = false
        if (a.has("title")) { record.put("title", requiredString(a, "title")); changed = true }
        val timeChanged = a.has("at")
        if (a.has("at")) {
            val at = requiredTime(a, "at"); requireFuture(at); record.put("at", at); changed = true
        }
        if (!changed) throw IllegalArgumentException("task.edit requires title or at")
        if (timeChanged) record.remove("firedAt")
        val now = System.currentTimeMillis(); record.put("updated", now)
        val done = record.optBoolean("done", false)
        var armed = false
        if (timeChanged) {
            try {
                cancelPending(record.optString("id"))
                if (!done && record.has("at")) { arm(record); armed = true }
            } catch (e: Exception) {
                cancelPending(record.optString("id"))
                if (!old.optBoolean("done", false) && old.has("at") && old.optLong("at") > System.currentTimeMillis()) try { arm(old) } catch (_: Exception) {}
                throw IllegalStateException("Task saved state was not changed because notification scheduling failed: ${e.message}")
            }
        }
        mutation(id, "Task update ho gaya", record, warningFor(armed))
    }

    private fun taskDone(id: String, a: JSONObject): JSONObject = store.transaction { records ->
        val index = resolveIndex(records, a, "task")
        val record = records[index]
        if (record.optString("kind") != "task") throw IllegalArgumentException("Record is not a task")
        if (!a.has("done")) throw IllegalArgumentException("task.done requires boolean done")
        val done = requiredBoolean(a, "done")
        val old = JSONObject(record.toString())
        record.put("done", done).put("updated", System.currentTimeMillis())
        if (!done) record.remove("firedAt")
        try {
            cancelPending(record.optString("id"))
            if (!done && record.has("at") && record.optLong("at") > System.currentTimeMillis()) arm(record)
        } catch (e: Exception) {
            cancelPending(record.optString("id"))
            if (!old.optBoolean("done", false) && old.has("at") && old.optLong("at") > System.currentTimeMillis()) try { arm(old) } catch (_: Exception) {}
            throw IllegalStateException("Task completion was not saved because notification scheduling failed: ${e.message}")
        }
        mutation(id, if (done) "Task complete ho gaya" else "Task pending kar diya", record, warningFor(!done && record.has("at")))
    }

    private fun noteAdd(id: String, a: JSONObject): JSONObject {
        val text = requiredString(a, "text")
        val record = ActionStore.nowRecord("note", store.newId("n"), text = text)
        return saveNew(id, record, schedule = false, label = "Note", success = "Note save ho gaya")
    }

    private fun noteEdit(id: String, a: JSONObject): JSONObject = store.transaction { records ->
        val index = resolveIndex(records, a, "note")
        val record = records[index]
        if (record.optString("kind") != "note") throw IllegalArgumentException("Record is not a note")
        record.put("text", requiredString(a, "text")).put("updated", System.currentTimeMillis())
        mutation(id, "Note update ho gaya", record)
    }

    // ---- reminders / alarms / timers
    private fun scheduledAdd(id: String, kind: String, a: JSONObject): JSONObject {
        val text = requiredString(a, "text")
        val at = requiredTime(a, "at"); requireFuture(at)
        val record = ActionStore.nowRecord(kind, store.newId(if (kind == "alarm") "a" else "r"), text = text, at = at)
        return saveNew(id, record, schedule = true, label = if (kind == "alarm") "Alarm" else "Reminder",
            success = "${kind.replaceFirstChar { it.uppercase() }} set ho gaya")
    }

    private fun timerAdd(id: String, a: JSONObject): JSONObject {
        val seconds = requiredNumber(a, "seconds")
        if (seconds % 1.0 != 0.0 || seconds !in 1.0..86400.0) {
            throw IllegalArgumentException("seconds must be a whole number from 1 to 86400")
        }
        val text = stringOptional(a, "text") ?: "Timer"
        val at = System.currentTimeMillis() + seconds.toLong() * 1000L
        val record = ActionStore.nowRecord("timer", store.newId("i"), text = text, at = at)
        return saveNew(id, record, schedule = true, label = "Timer", success = "Timer set ho gaya")
    }

    private fun scheduledEdit(id: String, kind: String, a: JSONObject): JSONObject = store.transaction { records ->
        val index = resolveIndex(records, a, kind)
        val old = JSONObject(records[index].toString())
        val record = records[index]
        if (record.optString("kind") != kind) throw IllegalArgumentException("Record is not a $kind")
        if (!a.has("at") && !a.has("text")) throw IllegalArgumentException("$kind.edit requires at or text")
        val timeChanged = a.has("at")
        if (a.has("at")) { val at = requiredTime(a, "at"); requireFuture(at); record.put("at", at) }
        if (a.has("text")) record.put("text", requiredString(a, "text"))
        if (timeChanged) record.remove("firedAt")
        record.put("updated", System.currentTimeMillis())
        if (timeChanged) {
            try {
                cancelPending(record.optString("id")); arm(record)
            } catch (e: Exception) {
                cancelPending(record.optString("id"))
                if (old.has("at") && old.optLong("at") > System.currentTimeMillis()) try { arm(old) } catch (_: Exception) {}
                throw IllegalStateException("$kind edit was not saved because notification scheduling failed: ${e.message}")
            }
        }
        mutation(id, "$kind update ho gaya", record, warningFor(timeChanged))
    }

    private fun saveNew(id: String, record: JSONObject, schedule: Boolean, label: String, success: String): JSONObject {
        try {
            store.transaction { records ->
                records.add(record)
                if (schedule) arm(record)
            }
        } catch (e: Exception) {
            cancelPending(record.optString("id"))
            throw IllegalStateException("Record was not saved because notification scheduling failed: ${e.message}")
        }
        return mutation(id, success, record, if (schedule) warningFor(true) else null)
    }

    // ---- work records and append-only log entries
    private fun workAdd(id: String, a: JSONObject): JSONObject {
        val title = requiredString(a, "title")
        val record = ActionStore.nowRecord("work", store.newId("w"), title = title)
            .put("entries", JSONArray()).put("minutes", 0L).put("progress", 0.0)
        if (a.has("category")) record.put("category", presentString(a, "category"))
        if (a.has("goal")) record.put("goal", presentString(a, "goal"))
        if (a.has("progress")) record.put("progress", progress(a, "progress"))
        if (a.has("outcome")) record.put("outcome", presentString(a, "outcome"))
        return saveNew(id, record, false, "Work", "Work save ho gaya")
    }

    private fun workEdit(id: String, a: JSONObject): JSONObject = store.transaction { records ->
        val index = resolveIndex(records, a, "work")
        val record = records[index]
        if (record.optString("kind") != "work") throw IllegalArgumentException("Record is not work")
        val fields = listOf("title", "category", "goal", "progress", "outcome")
        if (fields.none { a.has(it) }) throw IllegalArgumentException("work.edit requires a work field")
        if (a.has("title")) record.put("title", requiredString(a, "title"))
        if (a.has("category")) record.put("category", presentString(a, "category"))
        if (a.has("goal")) record.put("goal", presentString(a, "goal"))
        if (a.has("progress")) record.put("progress", progress(a, "progress"))
        if (a.has("outcome")) record.put("outcome", presentString(a, "outcome"))
        record.put("updated", System.currentTimeMillis())
        mutation(id, "Work update ho gaya", record)
    }

    private fun workLog(id: String, a: JSONObject): JSONObject = store.transaction { records ->
        val index = resolveIndex(records, a, "work")
        val record = records[index]
        if (record.optString("kind") != "work") throw IllegalArgumentException("Record is not work")
        val text = requiredString(a, "text")
        val date = activityDate(stringOptional(a, "date") ?: LocalDate.now().toString())
        val minutes = if (a.has("minutes")) requiredWholeNumber(a, "minutes", nonNegative = true) else 0L
        if (minutes > 1440L) throw IllegalArgumentException("minutes must be a whole number from 0 to 1440")
        val entry = JSONObject().put("id", store.newId("e")).put("date", date).put("minutes", minutes).put("text", text)
        if (a.has("progress")) entry.put("progress", progress(a, "progress"))
        if (a.has("outcome")) entry.put("outcome", presentString(a, "outcome"))
        val entries = record.optJSONArray("entries") ?: JSONArray().also { record.put("entries", it) }
        entries.put(entry)
        record.put("minutes", record.optLong("minutes", 0L) + minutes)
        if (a.has("progress")) record.put("progress", progress(a, "progress"))
        if (a.has("outcome")) record.put("outcome", presentString(a, "outcome"))
        record.put("updated", System.currentTimeMillis())
        mutation(id, "Work log save ho gaya", record)
    }

    private fun list(id: String, kind: String): JSONObject = store.readLocked { records ->
        val out = JSONArray()
        records.filter { it.optString("kind") == kind }.forEach { out.put(JSONObject(it.toString())) }
        JSONObject().put("id", id).put("ok", true).put("records", out).put("message", "${out.length()} $kind record(s)")
    }

    // ---- matching / validation
    private fun string(o: JSONObject, key: String, label: String): String {
        val value = o.opt(key)
        if (value !is String || value.isBlank()) throw IllegalArgumentException("$label.$key must be a non-empty string")
        return value.trim()
    }

    private fun resolveIndex(records: List<JSONObject>, a: JSONObject, expectedKind: String? = null): Int {
        val id = stringOptional(a, "id")
        val query = stringOptional(a, "query")
        if (id == null && query == null) throw IllegalArgumentException("Provide exact id or query")
        if (id != null && query != null) throw IllegalArgumentException("Provide id or query, not both")
        if (id != null) {
            val index = records.indexOfFirst { it.optString("id") == id }
            if (index < 0) throw IllegalArgumentException("No record has id '$id'")
            return index
        }
        val needle = query!!.trim().lowercase()
        if (needle.isBlank()) throw IllegalArgumentException("query must not be blank")
        val candidates = records.withIndex().filter {
            if (expectedKind != null && it.value.optString("kind") != expectedKind) {
                false
            } else {
                true
            }
        }
        // Match the JS resolver: an exact title/text match wins over any substring hits.
        val exact = candidates.filter {
            it.value.optString("title").trim().lowercase() == needle ||
                it.value.optString("text").trim().lowercase() == needle
        }
        if (exact.size == 1) return exact.single().index
        if (exact.size > 1) throw IllegalArgumentException("Query '$query' is ambiguous (${exact.size} records match)")
        val matches = candidates.filter {
            val value = it.value.optString("title") + "\n" + it.value.optString("text")
            value.lowercase().contains(needle)
        }
        if (matches.isEmpty()) throw IllegalArgumentException("No unique record matches '$query'")
        if (matches.size > 1) throw IllegalArgumentException("Query '$query' is ambiguous (${matches.size} records match)")
        return matches.single().index
    }

    private fun requiredString(o: JSONObject, key: String): String {
        val value = stringOptional(o, key) ?: throw IllegalArgumentException("$key must be a non-empty string")
        if (value.isBlank()) throw IllegalArgumentException("$key must be a non-empty string")
        return value.trim()
    }

    private fun stringOptional(o: JSONObject, key: String): String? {
        if (!o.has(key) || o.isNull(key)) return null
        val value = o.opt(key)
        if (value !is String) throw IllegalArgumentException("$key must be a string")
        return value
    }

    private fun presentString(o: JSONObject, key: String): String {
        if (!o.has(key) || o.isNull(key) || o.opt(key) !is String) {
            throw IllegalArgumentException("$key must be a string")
        }
        return o.getString(key)
    }

    private fun requiredBoolean(o: JSONObject, key: String): Boolean {
        if (!o.has(key) || o.isNull(key) || o.opt(key) !is Boolean) throw IllegalArgumentException("$key must be boolean")
        return o.getBoolean(key)
    }

    private fun requiredNumber(o: JSONObject, key: String): Double {
        if (!o.has(key) || o.isNull(key) || o.opt(key) !is Number) throw IllegalArgumentException("$key must be a number")
        val n = (o.opt(key) as Number).toDouble()
        if (!n.isFinite()) throw IllegalArgumentException("$key must be finite")
        return n
    }

    private fun requiredWholeNumber(o: JSONObject, key: String, nonNegative: Boolean): Long {
        val n = requiredNumber(o, key)
        if (n % 1.0 != 0.0 || (nonNegative && n < 0)) throw IllegalArgumentException("$key must be a non-negative integer")
        return n.toLong()
    }

    private fun activityDate(value: String): String {
        if (value.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) {
            return try {
                LocalDate.parse(value).toString()
            } catch (_: DateTimeParseException) {
                throw IllegalArgumentException("date must be ISO YYYY-MM-DD or an ISO instant")
            }
        }
        return try {
            Instant.parse(value).atZone(ZoneId.systemDefault()).toLocalDate().toString()
        } catch (_: DateTimeParseException) {
            throw IllegalArgumentException("date must be ISO YYYY-MM-DD or an ISO instant")
        }
    }

    private fun optionalTime(o: JSONObject, key: String): Long? {
        if (!o.has(key) || o.isNull(key)) return null
        return requiredTime(o, key)
    }

    private fun requiredTime(o: JSONObject, key: String): Long {
        val n = requiredNumber(o, key)
        if (n % 1.0 != 0.0 || n <= 0) throw IllegalArgumentException("$key must be a positive epoch-millisecond integer")
        return n.toLong()
    }

    private fun requireFuture(at: Long) {
        if (at <= System.currentTimeMillis() + 500L) throw IllegalArgumentException("Time must be in the future")
    }

    private fun progress(o: JSONObject, key: String): Double {
        val p = requiredNumber(o, key)
        if (p !in 0.0..100.0) throw IllegalArgumentException("$key must be between 0 and 100")
        return p
    }

    // ---- alarms and notification side effects
    private fun arm(record: JSONObject) {
        val at = record.optLong("at", 0L)
        if (at <= System.currentTimeMillis()) throw IllegalArgumentException("Time must be in the future")
        val sid = record.getString("id")
        val kind = record.getString("kind")
        val text = record.optString("text", record.optString("title", "Reminder"))
        val title = when (kind) { "task" -> "Task"; "alarm" -> "Alarm"; "timer" -> "Timer khatam"; else -> "Reminder" }
        val manager = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(ctx, ActionReceiver::class.java).setData(Uri.parse("adarsh://action/$sid"))
            .putExtra("id", sid).putExtra("kind", kind).putExtra("text", text).putExtra("title", title)
        val pending = PendingIntent.getBroadcast(ctx, sid.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val exact = Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms()
        if (exact) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
        else manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
    }

    private fun cancelPending(id: String) {
        if (id.isBlank()) return
        val manager = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(ctx, ActionReceiver::class.java).setData(Uri.parse("adarsh://action/$id"))
        val pending = PendingIntent.getBroadcast(ctx, id.hashCode(), intent,
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
        if (pending != null) manager.cancel(pending)
        pending?.cancel()
    }

    fun rearmAll() {
        store.upcoming().forEach { try { arm(it) } catch (_: Exception) {} }
    }

    fun deleteRecord(id: String): Boolean {
        val existing = store.find(id) ?: return false
        cancelPending(id)
        return try { store.remove(id) } catch (e: Exception) {
            if (existing.has("at") && existing.optLong("at") > System.currentTimeMillis()) try { arm(existing) } catch (_: Exception) {}
            throw e
        }
    }

    private fun warningFor(armed: Boolean): String? {
        if (!armed) return null
        val warnings = mutableListOf<String>()
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notificationsOff = Build.VERSION.SDK_INT >= 33 && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED || !nm.areNotificationsEnabled()
        if (notificationsOff) warnings += "notification permission disabled; record saved but Android will hide the notification"
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) warnings += "exact alarms unavailable; timing may be inexact"
        return warnings.takeIf { it.isNotEmpty() }?.joinToString("; ")
    }

    // ---- retained standard helpers
    private fun openApp(id: String, app: String): JSONObject {
        if (app.equals("controller", ignoreCase = true)) {
            go(Intent(Intent.ACTION_VIEW, Uri.parse("https://adarshctl-pc68aukk.manus.space")))
            return ok(id, "Adarsh Controller khul raha hai")
        }
        if (app == "camera") { go(Intent("android.media.action.STILL_IMAGE_CAMERA")); return ok(id, "Camera khul gaya") }
        if (app == "phone") { go(Intent(Intent.ACTION_DIAL)); return ok(id, "Dialer khul gaya") }
        val pkg = packages[app.lowercase()] ?: return error(id, "App nahi mili")
        val intent = ctx.packageManager.getLaunchIntentForPackage(pkg)
        if (intent == null) {
            go(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/search?q=" + Uri.encode(names[app] ?: app))))
            return error(id, "${names[app] ?: app} install nahi hai — Play Store khol diya")
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(intent)
        return ok(id, "${names[app] ?: app} khul gaya")
    }

    private fun calendar(id: String, a: JSONObject): JSONObject {
        val start = requiredTime(a, "at")
        val minutes = if (a.has("minutes")) requiredWholeNumber(a, "minutes", true) else 60L
        val title = stringOptional(a, "title") ?: "Event"
        val intent = Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start).putExtra(CalendarContract.EXTRA_EVENT_END_TIME, start + minutes * 60_000L)
            .putExtra(CalendarContract.Events.TITLE, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(intent); return ok(id, "Calendar khol diya — Save dabana hoga")
    }

    private fun draft(id: String, a: JSONObject): JSONObject {
        val text = requiredString(a, "text"); val to = stringOptional(a, "to") ?: ""
        if (stringOptional(a, "channel")?.equals("whatsapp", true) == true) {
            go(Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/?text=" + Uri.encode(text))))
        } else {
            go(Intent(Intent.ACTION_SENDTO, if (to.isBlank()) Uri.parse("sms:") else Uri.parse("smsto:" + Uri.encode(to))).putExtra("sms_body", text))
        }
        return ok(id, "Message draft khol diya — Send tum dabana")
    }

    private fun dial(id: String, a: JSONObject): JSONObject {
        val to = requiredString(a, "to")
        go(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(to))))
        return ok(id, "Dialer khol diya: $to")
    }

    private fun torch(id: String, on: Boolean): JSONObject {
        val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cam = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
            ?: return error(id, "Is phone mein flash nahi hai")
        cm.setTorchMode(cam, on); return ok(id, if (on) "Torch on" else "Torch off")
    }

    fun statusText(): String {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = bm.isCharging
        val st = StatFs(Environment.getDataDirectory().path)
        val freeGb = st.availableBytes / 1e9
        return "Battery $level%" + (if (charging) " (charging)" else "") + ", storage " + String.format("%.1f", freeGb) + " GB free, " + Build.MANUFACTURER + " " + Build.MODEL
    }

    private fun go(i: Intent) { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(i) }

    private fun mutation(id: String, message: String, record: JSONObject, warning: String? = null): JSONObject {
        val result = ok(id, if (warning == null) message else "$message; warning: $warning", record.getString("id"))
            .put("record", JSONObject(record.toString()))
        if (warning != null) result.put("warning", warning)
        return result
    }

    private fun ok(id: String, message: String, detail: String = "") = JSONObject()
        .put("id", id).put("ok", true).put("message", message).put("detail", detail)

    private fun error(id: String, message: String) = JSONObject().put("id", id).put("ok", false).put("message", message)

    companion object {
        const val CHANNEL = "adarsh_reminders"
        /** Channel id used by older builds; removed so Settings > Notifications shows only the renamed channel. */
        private const val OLD_CHANNEL = "jarvis"
        fun notify(ctx: Context, id: String, title: String, text: String): Boolean {
            return try {
                val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (Build.VERSION.SDK_INT >= 26) {
                    if (nm.getNotificationChannel(OLD_CHANNEL) != null) nm.deleteNotificationChannel(OLD_CHANNEL)
                    val ch = NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH)
                    ch.description = "Reminders, alarms, tasks and timers set by Adarsh"
                    ch.enableVibration(true); nm.createNotificationChannel(ch)
                }
                if (Build.VERSION.SDK_INT >= 33 && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
                if (!nm.areNotificationsEnabled()) return false
                val open = PendingIntent.getActivity(ctx, 2, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                val n = Notification.Builder(ctx, CHANNEL).setSmallIcon(R.drawable.ic_notification).setContentTitle(title)
                    .setContentText(text).setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(open).setAutoCancel(true).build()
                nm.notify(id.hashCode(), n); true
            } catch (_: Exception) { false }
        }
    }
}
