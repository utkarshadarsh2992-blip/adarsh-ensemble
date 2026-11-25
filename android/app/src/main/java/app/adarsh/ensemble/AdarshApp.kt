package app.adarsh.ensemble

import android.app.Application

class AdarshApp : Application() {
    lateinit var keys: SecureKeys
        private set
    lateinit var controller: ControllerLink
        private set

    override fun onCreate() {
        super.onCreate()
        keys = SecureKeys(this)
        controller = ControllerLink(this)
        try { NewsFcm.start(this) } catch (_: Throwable) {}
        Engine.start(this, keys, controller)   // controller fetch + Python startup stay off the UI thread
        UpdateCheckJob.schedule(this)   // automatic "new version" notice (Settings > App updates can turn it off)
    }
}
