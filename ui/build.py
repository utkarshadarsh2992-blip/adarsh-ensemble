#!/usr/bin/env python3
"""Inline src/ into one self-contained page: python3 build.py  ->  dist/artifact.html (fragment) and dist/adarsh.html (standalone)."""
import re, pathlib
root = pathlib.Path(__file__).parent
src = root / "src"
html = (src / "index.html").read_text()
css = (src / "css" / "app.css").read_text()
scripts = re.findall(r'<script src="(js/[^"]+)"></script>', html)
js = "\n".join((src / s).read_text() for s in scripts)

body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
body = re.sub(r'<script src="[^"]+"></script>\s*', "", body).strip()
fonts = re.search(r'<link rel="stylesheet" href="(https://fonts\.googleapis[^"]+)">', html).group(1)

frag = f"""<title>ADARSH</title>
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
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="{fonts}">
<style>
{css}
</style>"""
full = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        + head + '</head><body>' + body + '<script>' + js + '</script></body></html>')
(root / "dist" / "adarsh.html").write_text(full)
print("built", len(frag) // 1024, "KB")
