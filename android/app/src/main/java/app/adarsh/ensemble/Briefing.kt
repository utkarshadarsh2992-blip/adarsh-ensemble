package app.adarsh.ensemble

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZonedDateTime

/**
 * Night briefing (change 1.3).
 * Battery / CPU: one alarm a day that only posts a notification. No engine start, no network and no model
 * call happen here; the single Groq call runs when sir opens the briefing (04-briefing.js -> briefing.py).
 * Prefs "adarsh_briefing": on, time (HH:MM, local), next (epoch ms of the armed alarm), firedDate (YYYY-MM-DD).
 */
object BriefingScheduler {
    const val ACTION_FIRE = "app.adarsh.ensemble.BRIEFING_FIRE"
    const val ACTION_OPEN = "app.adarsh.ensemble.OPEN_BRIEFING"
    private const val CHANNEL = "adarsh_briefing"
    private const val REQ = 4242
    private const val NOTE_ID = 4242
    private const val TAG = "AdarshBriefing"
    private val TIME = Regex("^([01]\\d|2[0-3]):([0-5]\\d)$")
    /** Set when the notification opened the app; the page takes it once (AdarshNative.takeOpen). */
    @Volatile var pendingOpen = false
    /** News notification target; only sanitized values from NewsFcm are assigned. */
    @Volatile var pendingNewsOpen: String? = null

    private fun prefs(c: Context) = c.getSharedPreferences("adarsh_briefing", Context.MODE_PRIVATE)
    private fun err(msg: String) = JSONObject().put("ok", false).put("error", msg).toString()

    /** {on, time} from the page (Settings > Mission & briefing). Returns status() as JSON. */
    fun configure(ctx: Context, json: String): String {
        val o = try { JSONObject(json) } catch (_: Exception) { return err("bad json") }
        val on = o.optBoolean("on", true)
        val time = o.optString("time", "21:30")
        if (!TIME.matches(time)) return err("time must be HH:MM")
        prefs(ctx).edit().putBoolean("on", on).putString("time", time).apply()
        if (on) arm(ctx) else cancel(ctx)
        return status(ctx).toString()
    }

    fun status(ctx: Context): JSONObject {
        val p = prefs(ctx)
        val am = ctx.getSystemService(AlarmManager::class.java)
        return JSONObject().put("ok", true).put("on", p.getBoolean("on", false)).put("time", p.getString("time", "21:30"))
            .put("next", p.getLong("next", 0L)).put("notify", notifyAllowed(ctx))
            .put("exact", Build.VERSION.SDK_INT < 31 || am?.canScheduleExactAlarms() == true)
    }

    /** Next local occurrence of HH:MM strictly after now (DST gaps resolve forward through ZonedDateTime). */
    fun nextAt(time: String, now: ZonedDateTime = ZonedDateTime.now()): Long {
        val m = TIME.matchEntire(time) ?: return 0L
        val t = LocalTime.of(m.groupValues[1].toInt(), m.groupValues[2].toInt())
        var at = ZonedDateTime.of(now.toLocalDate(), t, now.zone)
        if (!at.isAfter(now)) at = ZonedDateTime.of(now.toLocalDate().plusDays(1), t, now.zone)
        return at.toInstant().toEpochMilli()
    }

    private fun firePending(ctx: Context): PendingIntent = PendingIntent.getBroadcast(ctx, REQ,
        Intent(ctx, BriefingReceiver::class.java).setAction(ACTION_FIRE),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    /** One alarm (same request code, so re-arming replaces it). Exact when Android allows it, else inexact. */
    fun arm(ctx: Context) {
        val p = prefs(ctx)
        if (!p.getBoolean("on", false)) return
        val at = nextAt(p.getString("time", "21:30") ?: "21:30")
        if (at <= 0L) return
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val pi = firePending(ctx)
        try {
            if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        } catch (_: SecurityException) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
        p.edit().putLong("next", at).apply()
    }

    fun cancel(ctx: Context) {
        ctx.getSystemService(AlarmManager::class.java)?.cancel(firePending(ctx))
        prefs(ctx).edit().putLong("next", 0L).apply()
    }

    /** Alarm time: post the notification once per date, then arm tomorrow's alarm. */
    fun fire(ctx: Context) {
        val p = prefs(ctx)
        if (!p.getBoolean("on", false)) return
        val today = LocalDate.now().toString()
        val next = p.getLong("next", 0L)
        // A queued old broadcast (time changed, re-armed) or a duplicate must not post twice a night.
        if (p.getString("firedDate", "") != today && (next == 0L || System.currentTimeMillis() >= next - 60_000L)) {
            p.edit().putString("firedDate", today).apply()
            notify(ctx)
        }
        arm(ctx)
    }

    fun notifyAllowed(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        return ctx.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() == true
    }

    private fun notify(ctx: Context): Boolean = try {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(CHANNEL, "Raat ki briefing", NotificationManager.IMPORTANCE_DEFAULT)
        ch.description = "Roz raat ek yaad: aaj ka hisaab aur kal ka plan"
        nm.createNotificationChannel(ch)
        if (!notifyAllowed(ctx)) false else {
            val open = PendingIntent.getActivity(ctx, REQ,
                Intent(ctx, MainActivity::class.java).setAction(ACTION_OPEN).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val text = "Aaj ka hisaab aur kal ka plan. Kholne par hi ek Groq call hogi."
            val n = Notification.Builder(ctx, CHANNEL).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Raat ki briefing ka time").setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(open).setAutoCancel(true).build()
            nm.notify(NOTE_ID, n)
            true
        }
    } catch (e: Exception) {
        Log.e(TAG, "Could not post the briefing notification", e)
        false
    }

    /** The page asks once after it loads (or after onNewIntent); returns one target a single time. */
    fun takeOpen(): String {
        if (pendingOpen) { pendingOpen = false; return "briefing" }
        val target = pendingNewsOpen ?: return ""
        pendingNewsOpen = null
        return target
    }
}

/** Briefing alarm + the system events after which Android's alarm queue must be armed again. Not exported:
 *  only this app's PendingIntent and the system can reach it. */
class BriefingReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        try {
            when (intent.action) {
                BriefingScheduler.ACTION_FIRE -> BriefingScheduler.fire(ctx)
                Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_MY_PACKAGE_REPLACED -> BriefingScheduler.arm(ctx)
            }
        } catch (e: Exception) {
            Log.e("AdarshBriefing", "Briefing receiver failed", e)
        }
    }
}
