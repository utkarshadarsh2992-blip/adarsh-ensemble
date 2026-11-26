#!/usr/bin/env python3
"""Inline src/ into one self-contained page: python3 build.py  ->  dist/artifact.html (fragment) and dist/adarsh.html (standalone)."""
import re, pathlib, hashlib, base64
root = pathlib.Path(__file__).parent
src = root / "src"
html = (src / "index.html").read_text()
styles = re.findall(r'<link rel="stylesheet" href="(css/[^"]+)">', html)
css = "\n".join((src / s).read_text() for s in styles)
scripts = re.findall(r'<script src="(js/[^"]+)"></script>', html)
js = "\n".join((src / s).read_text() for s in scripts)
js_hash = base64.b64encode(hashlib.sha256(js.encode()).digest()).decode()

body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
body = re.sub(r'<script src="[^"]+"></script>\s*', "", body).strip()
fonts = re.search(r'<link rel="stylesheet" href="(https://fonts\.googleapis[^"]+)">', html).group(1)

frag = f"""<title>ADARSH</title>
<link rel="icon" href="data:,">
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="{fonts}">
<style>
{css}
</style>
{body}
<script>
{js}
</script>
"""
(root / "dist").mkdir(exist_ok=True)
(root / "dist" / "artifact.html").write_text(frag)
head = f"""<title>ADARSH</title>
<link rel="icon" href="data:,">
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="{fonts}">
<style>
{css}
</style>"""
full = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        # audit M1/L7: no frames, plugins or <base> rewrites (the native bridge is visible to every frame)
        f'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'sha256-{js_hash}\'; style-src \'self\' https://fonts.googleapis.com \'unsafe-inline\'; img-src \'self\' data: blob:; media-src \'self\' data: blob:; connect-src \'self\' https:; font-src \'self\' https://fonts.gstatic.com data:; base-uri \'none\'; form-action \'none\'; frame-src \'none\'; object-src \'none\'">'
        + head + '</head><body>' + body + '<script>' + js + '</script></body></html>')
(root / "dist" / "adarsh.html").write_text(full)
print("built", len(frag) // 1024, "KB")
