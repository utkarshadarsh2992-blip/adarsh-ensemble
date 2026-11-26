package app.adarsh.ensemble

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Builds all news notifications locally so data-only FCM works while the app is closed. */
class NewsMessagingService : FirebaseMessagingService() {
    private val notificationIds = ConcurrentHashMap<String, Int>()
    private val nextNotificationId = AtomicInteger(1000)

    override fun onNewToken(token: String) {
        try { NewsFcm.onToken(applicationContext, token) } catch (_: Throwable) {}
    }

    override fun onMessageReceived(message: RemoteMessage) {
        try {
            // A notification payload is not part of the shared contract; ignore it rather than double-posting.
            if (message.notification != null) return
            val data = message.data
            val type = data["type"] ?: return
            if (type !in setOf("news_alert", "digest", "budget", "test")) return
            val title = clean(data["title"] ?: return, 160)
            val body = clean(data["body"] ?: return, 1200)
            if (title.isBlank() || body.isBlank()) return
            val target = when (type) {
                "budget" -> "news:budget"
                "news_alert" -> {
                    val id = NewsFcm.sanitizeOpenTarget("news:${data["news_id"].orEmpty()}") ?: return
                    id
                }
                else -> "news"
            }
            val channel = if (type == "news_alert") NewsFcm.ALERT_CHANNEL else NewsFcm.INFO_CHANNEL
            post(channel, title, body, target, if (type == "news_alert") data["news_id"].orEmpty() else type)
        } catch (_: Throwable) {
            // Malformed pushes must never take down the service process.
        }
    }

    private fun post(channelId: String, title: String, body: String, target: String, uniqueKey: String) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= 26) {
            val importance = if (channelId == NewsFcm.ALERT_CHANNEL) NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT
            val name = if (channelId == NewsFcm.ALERT_CHANNEL) "Breaking news" else "News digest aur budget"
            nm.createNotificationChannel(NotificationChannel(channelId, name, importance))
        }
        val requestCode = uniqueId(uniqueKey)
        val open = PendingIntent.getActivity(
            this, requestCode,
            Intent(this, MainActivity::class.java).setAction(NewsFcm.ACTION_OPEN)
                .putExtra(NewsFcm.EXTRA_OPEN_TARGET, target)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = Notification.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(Notification.Builder(this, channelId)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("ADARSH")
                .setContentText("ADARSH: nayi khabar")
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .build())
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(requestCode, notification)
    }

    private fun clean(raw: String, max: Int): String = raw
        .filterNot { it.isISOControl() }
        .replace(Regex("\\s+"), " ")
        .trim()
        .take(max)

    private fun uniqueId(key: String): Int {
        return notificationIds.getOrPut(key) {
            var value = nextNotificationId.getAndIncrement() and 0x7fffffff
            if (value == 0) value = 1
            value
        }
    }
}
