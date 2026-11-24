"""Startup animation: the native side continues it without a flash (source-level contract checks)."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android/app/src/main/res"
KT = ROOT / "android/app/src/main/java/app/adarsh/ensemble"


def read(p):
    return Path(p).read_text(encoding="utf-8")


def test_window_ground_matches_the_web_boot_layer():
    themes = read(RES / "values/themes.xml")
    assert '<color name="adarsh_boot">#05070B</color>' in themes
    assert '<item name="android:windowBackground">@color/adarsh_boot</item>' in themes
    css = read(ROOT / "ui/src/css/boot.css")
    assert re.search(r"\.boot\{[^}]*background:#05070B", css)


def test_android_12_splash_is_only_the_dark_ground():
    v31 = read(RES / "values-v31/themes.xml")
    assert 'name="Theme.Adarsh" parent="Theme.AppCompat.DayNight.NoActionBar"' in v31
    for item in ("android:windowBackground\">@color/adarsh_boot",
                 "android:statusBarColor\">@color/adarsh_bg",
                 "android:navigationBarColor\">@color/adarsh_bg",
                 "android:windowSplashScreenBackground\">@color/adarsh_boot",
                 "android:windowSplashScreenAnimatedIcon\">@drawable/splash_blank"):
        assert item in v31, item


def test_loading_view_is_the_dark_ground_without_static_logo():
    layout = read(RES / "layout/activity_main.xml")
    block = layout.split('android:id="@+id/loading"', 1)[1].split("/>", 1)[0]
    assert 'android:background="@color/adarsh_boot"' in block
    assert "ImageView" not in block and "ic_launcher_foreground" not in block
    assert 'android:color/transparent' in read(RES / "drawable/splash_blank.xml")
    css = read(ROOT / "ui/src/css/boot.css")
    assert "margin:-144px 0 0 -144px;overflow:visible;transform-origin:50% 50%;opacity:0}" in css
    assert ".boot.go .boot-logo,.boot.calm .boot-logo{opacity:1}" in css
    assert "ProgressBar" not in block
    assert 'android:id="@+id/error"' in layout and 'android:id="@+id/web"' in layout


def test_web_logo_uses_the_launcher_glyph_at_splash_size():
    fg = read(RES / "drawable/ic_launcher_foreground.xml")
    path = re.search(r'android:pathData="([^"]+)"', fg).group(1)
    html = read(ROOT / "ui/src/index.html")
    assert html.count(f'd="{path}"') == 2, "the boot logo must be the launcher 'A'"
    css = read(ROOT / "ui/src/css/boot.css")
    assert "width:288px;height:288px" in css


def test_boot_bars_bridge_is_origin_checked_and_restored_natively():
    bridge = read(KT / "AdarshBridge.kt")
    assert "fun bootBars(dark: Boolean) { if (ok()) MainActivity.bootBars(dark) }" in bridge
    act = read(KT / "MainActivity.kt")
    assert "fun bootBars(dark: Boolean) = ui { a -> a.setBootBars(dark) }" in act
    assert "R.color.adarsh_boot else R.color.adarsh_bg" in act
    # a cold start begins dark and never stays dark: a fallback timer and the load-error path turn the bars back
    assert "setBootBars(true)" in act and "postDelayed({ setBootBars(false) }, 9000)" in act
    err = act.split("override fun onReceivedError", 1)[1].split("override fun", 1)[0]
    assert "setBootBars(false)" in err
    js = read(ROOT / "ui/src/js/07-splash.js")
    assert "AdarshNative.bootBars(!!dark)" in js
