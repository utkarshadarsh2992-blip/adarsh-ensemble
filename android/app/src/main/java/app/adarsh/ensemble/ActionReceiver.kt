package app.adarsh.ensemble

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Fires a reminder / alarm / timer: notification + cleanup. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val id = intent.getStringExtra("id") ?: return
        val kind = intent.getStringExtra("kind") ?: "reminder"
        val text = intent.getStringExtra("text") ?: "Reminder"
        val title = when (kind) {
            "alarm" -> "Alarm"
            "timer" -> "Timer khatam"
            else -> "Reminder"
        }
        ActionRunner.notify(ctx, id, title, text)
        ActionStore(ctx).remove(id)
    }
}

/** After a reboot the alarm queue is empty: re-arm everything still in the future. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != "android.intent.action.QUICKBOOT_POWERON") return
        try { ActionRunner(ctx).rearmAll() } catch (_: Exception) {}
    }
}
