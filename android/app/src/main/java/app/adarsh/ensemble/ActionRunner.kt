package app.adarsh.ensemble

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.CalendarContract
import android.provider.Settings
import org.json.JSONObject

/**
 * Executes one validated step from the Python action layer. Nothing here talks to a model or the network.
 * Sensitive steps (message, call, settings) refuse to run unless the page sent confirmed=true.
 */
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
        val id = step.optString("id")
        val action = step.optString("action")
        val risk = step.optString("risk", "safe")
        val a = step.optJSONObject("args") ?: JSONObject()
        if (risk != "safe" && !confirmed) return err(id, "Confirmation chahiye")
        return try {
            when (action) {
                "reminder.add" -> schedule(id, "reminder", a.optString("text", "Reminder"), a.optLong("at"),
                    "Reminder", a.optString("human"))
                "alarm.add" -> schedule(id, "alarm", a.optString("text", "Alarm"), a.optLong("at"),
                    "Alarm", a.optString("human"))
                "timer.start" -> schedule(id, "timer", a.optString("text", "Timer"),
                    System.currentTimeMillis() + a.optInt("seconds", 60) * 1000L, "Timer", "")
                "note.add" -> {
                    val o = store.add("note", a.optString("text"), 0)
                    ok(id, "Note save ho gaya", o.optString("id"))
                }
                "note.clear" -> { store.clearNotes(); ok(id, "Saare notes hata diye") }
                "app.open" -> openApp(id, a.optString("app"))
                "web.search" -> {
                    go(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/search?q=" + Uri.encode(a.optString("query")))))
                    ok(id, "Search khol raha hoon")
                }
                "phone.status" -> ok(id, statusText(), "status")
                "calendar.add" -> calendar(id, a)
                "voice.open" -> ok(id, "Voice mode", "voice")
                "message.draft" -> draft(id, a)
                "call.dial" -> {
                    val to = a.optString("to")
                    go(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(to))))
                    ok(id, "Dialer khol diya: $to")
                }
                "panel.open" -> panel(id, a.optString("panel"))
                "dnd.set" -> dnd(id, a.optBoolean("on"))
                "torch.set" -> torch(id, a.optBoolean("on"))
                else -> err(id, "Ye action app support nahi karti")
            }
        } catch (e: Exception) {
            err(id, (e.message ?: e.javaClass.simpleName).take(90))
        }
    }

    // ---- scheduling
    private fun schedule(id: String, kind: String, text: String, at: Long, title: String, human: String): JSONObject {
        if (at <= System.currentTimeMillis() + 500) return err(id, "Time nikal gaya")
        val o = store.add(kind, text, at)
        arm(o.optString("id"), kind, text, at, title)
        val when_ = human.ifBlank { clock(at) }
        val msg = when (kind) {
            "reminder" -> "Reminder set: $when_"
            "alarm" -> "Alarm set: $when_"
            else -> "Timer set: " + when_
        }
        return ok(id, msg, o.optString("id"))
    }

    private fun arm(sid: String, kind: String, text: String, at: Long, title: String) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val i = Intent(ctx, ActionReceiver::class.java).putExtra("id", sid).putExtra("kind", kind)
            .putExtra("text", text).putExtra("title", title)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pi = PendingIntent.getBroadcast(ctx, sid.hashCode(), i, flags)
        val exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()
        if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
    }

    fun rearmAll() = store.upcoming().forEach { arm(it.optString("id"), it.optString("kind"), it.optString("text"), it.optLong("at"), "Reminder") }

    // ---- pieces
    private fun openApp(id: String, app: String): JSONObject {
        if (app == "camera") {
            go(Intent("android.media.action.STILL_IMAGE_CAMERA")); return ok(id, "Camera khul gaya")
        }
        if (app == "phone") {
            go(Intent(Intent.ACTION_DIAL)); return ok(id, "Dialer khul gaya")
        }
        val pkg = packages[app] ?: return err(id, "App nahi mili")
        val i = ctx.packageManager.getLaunchIntentForPackage(pkg)
        if (i == null) {
            go(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/search?q=" + Uri.encode(names[app] ?: app))))
            return err(id, "${names[app] ?: app} install nahi hai — Play Store khol diya")
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
        return ok(id, "${names[app] ?: app} khul gaya")
    }

    private fun calendar(id: String, a: JSONObject): JSONObject {
        val start = a.optLong("at")
        val end = start + a.optInt("minutes", 60) * 60_000L
        val i = Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start)
            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
            .putExtra(CalendarContract.Events.TITLE, a.optString("title", "Event"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
        return ok(id, "Calendar khol diya — Save dabana hoga")
    }

    private fun draft(id: String, a: JSONObject): JSONObject {
        val text = a.optString("text")
        val to = a.optString("to")
        if (a.optString("channel") == "whatsapp") {
            go(Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/?text=" + Uri.encode(text))))
            return ok(id, "WhatsApp khol diya — Send tum dabana")
        }
        val uri = if (to.isNotBlank()) Uri.parse("smsto:" + Uri.encode(to)) else Uri.parse("sms:")
        val i = Intent(Intent.ACTION_SENDTO, uri).putExtra("sms_body", text)
        go(i)
        return ok(id, "Message draft khol diya — Send tum dabana")
    }

    private fun panel(id: String, panel: String): JSONObject {
        val i = when (panel) {
            "wifi" -> if (Build.VERSION.SDK_INT >= 29) Intent(Settings.Panel.ACTION_WIFI) else Intent(Settings.ACTION_WIFI_SETTINGS)
            "bluetooth" -> if (Build.VERSION.SDK_INT >= 33) Intent(Settings.ACTION_BLUETOOTH_SETTINGS) else Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
            "brightness" -> Intent(Settings.ACTION_DISPLAY_SETTINGS)
            else -> Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
        }
        go(i)
        val note = if (panel == "wifi" || panel == "bluetooth") "Android app se khud band nahi kar sakta — panel khol diya" else "Settings khol diye"
        return ok(id, note)
    }

    private fun dnd(id: String, on: Boolean): JSONObject {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (!nm.isNotificationPolicyAccessGranted) {
            go(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
            return err(id, "Pehle DND access do — settings khol diye")
        }
        nm.setInterruptionFilter(if (on) NotificationManager.INTERRUPTION_FILTER_PRIORITY else NotificationManager.INTERRUPTION_FILTER_ALL)
        return ok(id, if (on) "DND on" else "DND off")
    }

    private fun torch(id: String, on: Boolean): JSONObject {
        val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cam = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
            ?: return err(id, "Is phone mein flash nahi hai")
        cm.setTorchMode(cam, on)
        return ok(id, if (on) "Torch on" else "Torch off")
    }

    fun statusText(): String {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = bm.isCharging
        val st = StatFs(Environment.getDataDirectory().path)
        val freeGb = st.availableBytes / 1e9
        return "Battery $level%" + (if (charging) " (charging)" else "") +
            ", storage " + String.format("%.1f", freeGb) + " GB free, " + Build.MANUFACTURER + " " + Build.MODEL
    }

    private fun clock(ms: Long): String {
        val c = java.util.Calendar.getInstance().apply { timeInMillis = ms }
        val h = c.get(java.util.Calendar.HOUR_OF_DAY)
        return String.format("%d:%02d %s", h % 12 or 12, c.get(java.util.Calendar.MINUTE), if (h < 12) "am" else "pm")
    }

    private fun go(i: Intent) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
    }

    private fun ok(id: String, message: String, detail: String = "") =
        JSONObject().put("id", id).put("ok", true).put("message", message).put("detail", detail)

    private fun err(id: String, message: String) =
        JSONObject().put("id", id).put("ok", false).put("message", message)

    companion object {
        const val CHANNEL = "jarvis"
        fun notify(ctx: Context, id: String, title: String, text: String) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) {
                val ch = NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH)
                ch.description = "Reminders, alarms and timers set by Adarsh"
                ch.enableVibration(true)
                nm.createNotificationChannel(ch)
            }
            val open = PendingIntent.getActivity(ctx, 2, Intent(ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val n = Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            try { nm.notify(id.hashCode(), n) } catch (_: Exception) {}
        }
    }
}
