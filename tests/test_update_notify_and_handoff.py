"""Item 5: automatic update notification; item 3: live voice continues outside the app."""
from pathlib import Path
SRC = Path(__file__).resolve().parents[1] / "android/app/src/main"
K = SRC / "java/app/adarsh/ensemble"

def test_update_job_is_declared_periodic_and_notification_only():
    job = (K / "UpdateCheckJob.kt").read_text()
    manifest = (SRC / "AndroidManifest.xml").read_text()
    assert 'android:name=".UpdateCheckJob"' in manifest and "BIND_JOB_SERVICE" in manifest
    assert "setPeriodic(PERIOD_MS, FLEX_MS)" in job and "NETWORK_TYPE_ANY" in job and "setPersisted(true)" in job
    assert "check(force = true)" in job
    assert "download(" not in job and "install(" not in job   # never downloads or installs by itself
    assert "KEY_NOTIFIED_VERSION" in job                       # one notification per version
    assert "EXTRA_OPEN, OPEN_UPDATES" in job

def test_update_job_scheduled_and_switchable():
    app = (K / "AdarshApp.kt").read_text(); main = (K / "MainActivity.kt").read_text()
    bridge = (K / "AdarshBridge.kt").read_text()
    assert "UpdateCheckJob.schedule(this)" in app
    assert "fun updateNotify(value: String)" in bridge and "fun launchTarget()" in bridge
    assert "override fun onNewIntent" in main and "__adarshOpen" in main
    um = (K / "UpdateManager.kt").read_text()
    assert "readCachedMetadata()?.let { metadata = it }" in um

def test_live_voice_hands_off_on_every_way_of_leaving():
    main = (K / "MainActivity.kt").read_text(); svc = (K / "BackgroundVoiceService.kt").read_text()
    pause = main.split("override fun onPause()")[1].split("super.onPause()")[0]
    assert "handoffToBackground()" in pause                      # screen off / other app, not just Home
    assert "awaitingResult" in main.split("private fun handoffToBackground")[1].split("handoffConfig = null")[0]
    assert "BackgroundVoiceService.start(this, cfg, handoff = true)" in main
    assert "Lifecycle.State.STARTED else Lifecycle.State.RESUMED" in svc
    js = (SRC.parents[3] / "ui/src/js/05-mobile.js").read_text()
    can = js.split("const canHandoff")[1].split(";")[0]
    assert "standard" not in can                                  # every selected mode can continue outside
def test_voice_service_is_foreground_before_the_app_leaves_the_screen():
    """Android 14 refuses a microphone foreground service started from the background: prepare while visible."""
    main = (K / "MainActivity.kt").read_text(); svc = (K / "BackgroundVoiceService.kt").read_text()
    arm = main.split("fun backgroundVoiceArm")[1].split("fun ")[0]
    assert "BackgroundVoiceService.prepare(a)" in arm and "BackgroundVoiceService.unprepare()" in arm
    assert "BackgroundVoiceService.unprepare()" in main.split("override fun onDestroy()")[1]
    assert "ACTION_PREPARE" in svc and "startForegroundNow(ready = true)" in svc
    start = svc.split("fun start(activity: MainActivity")[1].split("fun prepare")[0]
    assert "ready.standby" in start and "beginSession(configJson, epoch)" in start
    assert "private fun endStandby()" in svc and "standby && !active" in svc
def test_background_voice_error_is_shown_when_the_user_comes_back():
    js = (Path(__file__).resolve().parents[1] / "ui/src/js/05-mobile.js").read_text()
    assert "Bahar voice ruk gayi: " in js and "lastError" in js
