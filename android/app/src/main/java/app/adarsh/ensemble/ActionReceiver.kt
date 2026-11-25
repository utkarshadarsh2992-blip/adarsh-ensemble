package app.adarsh.ensemble

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Fires a persisted task/reminder/alarm/timer without deleting its history. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        // ActionRunner's explicit PendingIntent historically has no action; reject every
        // non-null action except the reserved one, and bind the record ID to its URI.
        if (intent.action != null && intent.action != ACTION_FIRE) return
        val uri = intent.data ?: return
        if (uri.scheme != "adarsh" || uri.host != "action" || uri.pathSegments.size != 1) return
        val id = uri.pathSegments[0]
        if (intent.hasExtra("id") && intent.getStringExtra("id") != id) return
        try {
            ActionStore(ctx).transaction { records ->
                val record = records.firstOrNull { it.optString("id") == id }
                val now = System.currentTimeMillis()
                // A cancelled broadcast can already be queued. Re-check the canonical record
                // under the same lock as edits/completion and reject duplicates or old schedules.
                if (record == null || record.optBoolean("done", false) || record.has("firedAt") ||
                    record.optLong("at", 0L) <= 0L || record.optLong("at") > now + 1000L) {
                    Log.w(TAG, "Ignoring stale/duplicate alarm for $id")
                    return@transaction
                }
                val kind = record.optString("kind")
                if (kind !in setOf("task", "reminder", "alarm", "timer")) return@transaction
                val text = record.optString("text", record.optString("title", "Reminder"))
                val title = when (kind) {
                    "task" -> "Task"
                    "alarm" -> "Alarm"
                    "timer" -> "Timer khatam"
                    else -> "Reminder"
                }
                ActionRunner.notify(ctx, id, title, text)
                // Retain the record, even when Android hides a permission-blocked notification.
                record.put("firedAt", now).put("updated", now)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Could not fire native record $id", e)
        }
    }

    companion object {
        private const val TAG = "AdarshAction"
        private const val ACTION_FIRE = "app.adarsh.ensemble.ACTION_FIRE"
    }
}

/** After a reboot Android's alarm queue is empty: re-arm every future native record. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != "android.intent.action.QUICKBOOT_POWERON") return
        try { ActionRunner(ctx).rearmAll() } catch (e: Exception) { Log.e("AdarshAction", "Could not rearm native records", e) }
        try { BriefingScheduler.arm(ctx) } catch (e: Exception) { Log.e("AdarshBriefing", "Could not rearm the night briefing", e) }
    }
}
