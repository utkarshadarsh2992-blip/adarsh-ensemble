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
