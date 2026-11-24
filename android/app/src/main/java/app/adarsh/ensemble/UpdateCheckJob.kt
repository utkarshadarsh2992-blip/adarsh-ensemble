package app.adarsh.ensemble

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Automatic update notice. Every few hours (only with internet) Android runs this job: it performs the same
 * verified GitHub public-release check as the App updates screen and, when a newer published build exists,
 * posts ONE notification per version. It never downloads or installs anything; tapping the notification
 * opens App updates, where download and install still need the user's taps and Android's own confirmation.
 * No keys, chats or personal data are sent; the request is the public releases API only.
 */
class UpdateCheckJob : JobService() {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var updater: UpdateManager? = null

    override fun onStartJob(params: JobParameters): Boolean {
        if (!enabled(this)) return false
        val finished = AtomicBoolean(false)
        fun finish(value: JSONObject) {
            if (value.optString("state") == UpdateManager.STATE_CHECKING) return
            if (!finished.compareAndSet(false, true)) return
            try { maybeNotify(applicationContext, value) } catch (_: Exception) {}
            main.post { updater?.destroy(); updater = null; jobFinished(params, false) }
        }
        return try {
            val um = UpdateManager(this) { value -> finish(value) }
            updater = um
            finish(um.check(force = true))   // ignored while "checking"; the executor's emit finishes the job
            true
        } catch (_: Exception) { false }
    }

    override fun onStopJob(params: JobParameters): Boolean {
        updater?.destroy(); updater = null
        return true   // try again later
    }

    companion object {
        const val JOB_ID = 6601
        const val KEY_AUTO_NOTIFY = "auto_notify"
        const val KEY_NOTIFIED_VERSION = "notified_version"
        const val CHANNEL = "adarsh_updates"
        const val NOTIFICATION_ID = 6602
        const val EXTRA_OPEN = "adarsh.open"
        const val OPEN_UPDATES = "updates"
        const val PERIOD_MS = 3L * 60L * 60L * 1000L
        const val FLEX_MS = 60L * 60L * 1000L

        private fun prefs(c: Context) = c.getSharedPreferences(UpdateManager.PREFS, Context.MODE_PRIVATE)
        /** On by default; the Settings switch turns it off. */
        fun enabled(c: Context): Boolean = prefs(c).getBoolean(KEY_AUTO_NOTIFY, true)

        fun setEnabled(c: Context, on: Boolean) {
            prefs(c).edit().putBoolean(KEY_AUTO_NOTIFY, on).apply()
            if (on) schedule(c) else cancel(c)
        }

        /** Idempotent: keeps an already scheduled job (so app launches do not keep resetting its timer). */
        fun schedule(c: Context) {
            if (!enabled(c)) return cancel(c)
            try {
                val js = c.getSystemService(JobScheduler::class.java) ?: return
                if (js.getPendingJob(JOB_ID) != null) return
                val info = JobInfo.Builder(JOB_ID, ComponentName(c, UpdateCheckJob::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(PERIOD_MS, FLEX_MS)
                    .setPersisted(true)   // survives reboot (RECEIVE_BOOT_COMPLETED is declared)
                    .build()
                js.schedule(info)
            } catch (_: Exception) {}
        }

        fun cancel(c: Context) {
            try { c.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID) } catch (_: Exception) {}
        }

        /** One notice per published version; skipped while the app is on screen (the in-app banner shows it). */
        fun maybeNotify(c: Context, status: JSONObject) {
            val state = status.optString("state")
            if (state != UpdateManager.STATE_AVAILABLE && state != UpdateManager.STATE_READY) return
            val code = status.optLong("versionCode", -1L)
            if (code <= 0L || code <= prefs(c).getLong(KEY_NOTIFIED_VERSION, 0L)) return
            if (MainActivity.isOnScreen()) return
            if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            val nm = c.getSystemService(NotificationManager::class.java) ?: return
            if (!nm.areNotificationsEnabled()) return
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT))
            val open = PendingIntent.getActivity(
                c, NOTIFICATION_ID,
                Intent(c, MainActivity::class.java).putExtra(EXTRA_OPEN, OPEN_UPDATES).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            val name = status.optString("versionName").ifBlank { "new version" }
            val text = "ADARSH $name aa gaya. Tap karke update karo."
            val n = Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Naya update available")
                .setContentText(text)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            nm.notify(NOTIFICATION_ID, n)
            prefs(c).edit().putLong(KEY_NOTIFIED_VERSION, code).apply()
        }
    }
}
