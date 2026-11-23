"""Audit H5 (native confirmation) and M1 (bridge origin guard): source-level contract checks.
Kotlin is compiled only in CI, so these tests pin the security-relevant code paths in the sources."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "android/app/src/main/java/app/adarsh/ensemble"


def src(name: str) -> str:
    return (NATIVE / name).read_text(encoding="utf-8")


def test_sensitive_actions_need_a_native_dialog_not_only_the_js_flag():
    a = src("MainActivity.kt")
    assert 'SENSITIVE = setOf("message.draft", "call.dial")' in a
    assert "approved[i] = nativeConfirm(step)" in a
    assert "AlertDialog.Builder(a)" in a and ".setPositiveButton(" in a
    # the executed flag is the native answer, never the page's `confirmed` value
    assert "actions!!.run(step, approved[i])" in a
    assert "actions!!.run(step, confirmed)" not in a
    # what is shown must be what runs: no silent truncation of the number / text
    assert "to.length > 64 || text.length > 2000" in a
    assert ".take(64)" not in a.split("private fun nativeConfirm", 1)[1].split("fun runActions", 1)[0]


def test_background_voice_never_confirms_sensitive_actions():
    s = src("BackgroundVoiceService.kt")
    assert "ActionRunner(this).run(step, false)" in s
    assert "run(step, true)" not in s


def test_every_bridge_method_checks_the_page_origin():
    b = src("AdarshBridge.kt")
    methods = re.findall(r"@JavascriptInterface\s+fun (\w+)\(([^)]*)\)([^\n]*)", b)
    assert len(methods) >= 40
    for name, _args, rest in methods:
        body = b.split(f"fun {name}(", 1)[1].split("@JavascriptInterface", 1)[0]
        assert "ok()" in body, f"bridge method {name} does not check MainActivity.pageTrusted()"
    assert "private fun ok(): Boolean = MainActivity.pageTrusted()" in b
    assert 'keys.first("NVIDIA_API_KEY")' in b  # noise removal uses the first NVIDIA slot that is set


def test_page_trust_tracks_the_main_frame_origin_and_page_blocks_frames():
    a = src("MainActivity.kt")
    assert "if (request.isForMainFrame) pageTrusted = isAppOrigin(request.url)" in a
    assert "pageTrusted = url != null && isAppOrigin(Uri.parse(url))" in a
    assert 'u.scheme == "https" && u.host == HOST' in a
    html = (ROOT / "ui/src/index.html").read_text(encoding="utf-8")
    assert "frame-src 'none'" in html and "object-src 'none'" in html and "base-uri 'none'" in html
    dist = (ROOT / "ui/dist/adarsh.html").read_text(encoding="utf-8")
    assert "frame-src 'none'" in dist


def test_key_store_reset_is_reported_to_the_page():
    b = src("AdarshBridge.kt")
    assert 'keys.takeResetNotice()?.let { o.put("_notice", it) }' in b
