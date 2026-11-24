package app.adarsh.ensemble

import android.app.Application

class AdarshApp : Application() {
    lateinit var keys: SecureKeys
        private set

    override fun onCreate() {
        super.onCreate()
        keys = SecureKeys(this)
        Engine.start(this, keys)   // starts Python on a background thread; the UI never waits for it
        UpdateCheckJob.schedule(this)   // automatic "new version" notice (Settings > App updates can turn it off)
    }
}
