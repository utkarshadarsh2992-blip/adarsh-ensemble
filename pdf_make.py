"""Professional, structured PDF reports with no third-party dependency.

Chaquopy keeps the app small and predictable, so this writes PDF 1.4 by hand: base-14 fonts, a coloured cover, running
headers, numbered sections, tables, code boxes, callouts, a sources page and "Page n of N" footers. Text is WinAnsi
(Hinglish/English); anything outside it is replaced instead of breaking the file.
"""
from __future__ import annotations

import datetime as _dt
import re

PAGE_W, PAGE_H = 595.0, 842.0          # A4 in points
MARGIN = 54.0
BODY = 10.0
LEAD = 14.6
TITLE = 26.0
H1 = 15.0
H2 = 11.8
SMALL = 8.2
TINY = 7.4

INK = (0.06, 0.09, 0.16)               # #0F172A
ACCENT = (0.02, 0.45, 0.53)            # teal, reads well in print
MUTED = (0.39, 0.45, 0.55)
RULE = (0.80, 0.84, 0.88)
WASH = (0.945, 0.965, 0.975)
WHITE = (1, 1, 1)

# Helvetica / Helvetica-Bold advance widths (per 1000 units), ASCII 32..126. Courier is fixed 600.
_HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
         556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
         1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
         667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
         333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
         556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]
_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
         556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
         975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
         667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
         333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
         611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]


def _width(text: str, size: float, font: str = "F2") -> float:
    """Real Helvetica advance widths, so wrapping never runs past the margin."""
    table = _HELV if font != "F1" else _BOLD
    total = 0.0
    for ch in str(text):
        o = ord(ch)
        if font == "F4":
            total += 600
        elif 32 <= o <= 126:
            total += table[o - 32]
        else:
            total += 556
    return total / 1000.0 * size


def _esc(text: str) -> str:
    """WinAnsi-safe literal string for a PDF content stream."""
    out = []
    for ch in str(text):
        if ch in "()\\":
            out.append("\\" + ch)
        elif ch in "\n\r":
            out.append(" ")
        else:
            try:
                ch.encode("cp1252")      # bullets, dashes, quotes: all present in WinAnsi
                out.append(ch)
            except UnicodeEncodeError:
                out.append("?")          # Devanagari etc. is not in the base-14 fonts
    return "".join(out)


def _wrap(text: str, size: float, width: float, font: str = "F2") -> list[str]:
    words, lines, cur = str(text).split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if _width(trial, size, font) <= width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or [""]


def _plain(text: str) -> str:
    """Strip the inline markdown the answers use, keep the words."""
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", str(text or ""))
    text = re.sub(r"(?<!\w)[*_](.+?)[*_](?!\w)", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1 (\2)", text)
    return text.replace("\t", "    ").strip()


def _fit(text: str, size: float, width: float, font: str = "F2") -> str:
    """Hard-truncate one line so nothing can spill outside the page."""
    if _width(text, size, font) <= width:
        return text
    while text and _width(text + "…", size, font) > width:
        text = text[:-1]
    return text + "…"


class _Page:
    def __init__(self) -> None:
        self.ops: list[str] = []

    def text(self, x: float, y: float, size: float, font: str, s: str, color=INK) -> None:
        r, g, b = color
        self.ops.append(f"BT {r:.3f} {g:.3f} {b:.3f} rg /{font} {size:.2f} Tf "
                        f"1 0 0 1 {x:.2f} {y:.2f} Tm ({_esc(s)}) Tj ET")

    def spaced(self, x: float, y: float, size: float, font: str, s: str, color=INK, gap: float = 1.2) -> None:
        """Letter-spaced label (the small-caps look) for the cover and section numbers."""
        r, g, b = color
        k = -abs(gap) * 1000.0 / max(size, 1.0)          # TJ kerning is in thousandths of an em
        parts = []
        for ch in str(s):
            parts.append(f"({_esc(ch)})")
            parts.append(f"{k:.1f}")
        self.ops.append(f"BT {r:.3f} {g:.3f} {b:.3f} rg /{font} {size:.2f} Tf "
                        f"1 0 0 1 {x:.2f} {y:.2f} Tm [" + " ".join(parts[:-1]) + "] TJ ET")

    def rect(self, x: float, y: float, w: float, h: float, color, stroke=None, lw: float = 0.5) -> None:
        r, g, b = color
        op = f"{r:.3f} {g:.3f} {b:.3f} rg {x:.2f} {y:.2f} {w:.2f} {h:.2f} re f"
        if stroke:
            sr, sg, sb = stroke
            op += f" {sr:.3f} {sg:.3f} {sb:.3f} RG {lw:.2f} w {x:.2f} {y:.2f} {w:.2f} {h:.2f} re S"
        self.ops.append(op)

    def rule(self, x1: float, y: float, x2: float, color=RULE, w: float = 0.7) -> None:
        r, g, b = color
        self.ops.append(f"{r:.3f} {g:.3f} {b:.3f} RG {w:.2f} w {x1:.2f} {y:.2f} m {x2:.2f} {y:.2f} l S")


def _cover(title: str, subtitle: str, meta: list[tuple[str, str]]) -> _Page:
    p = _Page()
    band = 330.0
    p.rect(0, PAGE_H - band, PAGE_W, band, INK)
    p.rect(0, PAGE_H - band, PAGE_W, 5, ACCENT)
    # brand block
    p.text(MARGIN, PAGE_H - 78, 9.5, "F1", "ADARSH ENSEMBLE", WHITE)
    p.spaced(MARGIN, PAGE_H - 94, 6.6, "F2", "PERSONAL RESEARCH SYSTEM", (0.62, 0.72, 0.80), 1.6)
    p.rect(MARGIN, PAGE_H - 106, 34, 2, ACCENT)
    y = PAGE_H - 160
    for line in _wrap(_plain(title) or "Report", TITLE, PAGE_W - 2 * MARGIN, "F1")[:3]:
        p.text(MARGIN, y, TITLE, "F1", _fit(line, TITLE, PAGE_W - 2 * MARGIN, "F1"), WHITE)
        y -= TITLE + 8
    if subtitle:
        y -= 4
        for line in _wrap(_plain(subtitle), 11, PAGE_W - 2 * MARGIN - 6)[:3]:
            p.text(MARGIN, y, 11, "F3", _fit(line, 11, PAGE_W - 2 * MARGIN - 6), (0.70, 0.78, 0.85))
            y -= 15
    # meta table
    y = PAGE_H - band - 56
    p.spaced(MARGIN, y, 7.2, "F1", "DOCUMENT DETAILS", ACCENT, 1.4)
    y -= 8
    p.rule(MARGIN, y, PAGE_W - MARGIN)
    y -= 20
    for label, value in meta:
        p.text(MARGIN, y, 8.2, "F2", label.upper(), MUTED)
        p.text(MARGIN + 132, y, 9.6, "F2", _fit(_plain(value), 9.6, PAGE_W - MARGIN - 132 - MARGIN))
        y -= 19
    p.rect(MARGIN, 108, PAGE_W - 2 * MARGIN, 0.8, RULE)
    p.text(MARGIN, 92, TINY, "F2", "Generated by Adarsh Ensemble - personal research report. Verify important figures.",
           MUTED)
    p.text(PAGE_W - MARGIN - _width("ADARSH // CORE", TINY, "F4"), 92, TINY, "F4", "ADARSH // CORE", ACCENT)
    return p


def _table_rows(lines: list[str], i: int) -> tuple[list[list[str]], int]:
    """Read a markdown pipe table starting at lines[i]; returns (rows, next index)."""
    rows: list[list[str]] = []
    while i < len(lines) and lines[i].strip().startswith("|"):
        cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
        if not all(re.fullmatch(r":?-{2,}:?", c or "") for c in cells):
            rows.append(cells)
        i += 1
    return rows, i


def _render(markdown: str, *, page_no_start: int = 2) -> list[_Page]:
    """Turn the report text into pages."""
    pages: list[_Page] = []
    p = _Page()
    pages.append(p)
    width = PAGE_W - 2 * MARGIN
    y = PAGE_H - MARGIN - 18
    in_code = False
    section = 0

    def new_page() -> None:
        nonlocal p, y
        p = _Page()
        pages.append(p)
        y = PAGE_H - MARGIN - 18

    def need(h: float) -> None:
        nonlocal y
        if y - h < MARGIN + 26:
            new_page()

    lines = str(markdown or "").splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip()
        i += 1
        if line.strip().startswith("```"):
            in_code = not in_code
            y -= 4 if in_code else 6
            continue
        if in_code:
            segs = _wrap(_plain(line) or " ", 8.2, width - 18, "F4")
            block_h = len(segs) * 11.6 + 8
            need(block_h)
            p.rect(MARGIN, y - block_h + 8, width, block_h, WASH, RULE, 0.4)
            p.rect(MARGIN, y - block_h + 8, 2.4, block_h, ACCENT)
            yy = y - 2
            for seg in segs:
                p.text(MARGIN + 12, yy, 8.2, "F4", _fit(seg, 8.2, width - 20, "F4"), INK)
                yy -= 11.6
            y -= block_h + 6
            continue
        if not line.strip():
            y -= 5.5
            continue
        # ---- headings
        if line.startswith("# "):
            text = _plain(line[2:])
            need(H1 + 26)
            section += 1
            p.text(MARGIN, y, 7.2, "F1", "%02d" % section, ACCENT)
            p.text(MARGIN + 24, y, H1, "F1", _fit(text, H1, width - 24, "F1"), INK)
            y -= 6
            p.rect(MARGIN, y, width, 1.6, ACCENT)
            y -= H1 + 2
            continue
        if line.startswith("## "):
            text = _plain(line[3:])
            need(H2 + 20)
            y -= 3
            p.rect(MARGIN, y - 2, 3, H2 + 1, ACCENT)
            p.text(MARGIN + 11, y, H2, "F1", _fit(text, H2, width - 11, "F1"), INK)
            y -= H2 + 8
            continue
        if line.startswith("### "):
            text = _plain(line[4:])
            need(BODY + 14)
            p.text(MARGIN, y, BODY + 0.4, "F1", _fit(text, BODY + 0.4, width, "F1"), ACCENT)
            y -= BODY + 7
            continue
        # ---- tables
        if line.strip().startswith("|") and i < len(lines) and re.match(r"^\s*\|?[\s:-]*-{2,}", lines[i] or ""):
            rows, i = _table_rows(lines, i - 1)
            if rows:
                cols = max(len(r) for r in rows)
                rows = [r + [""] * (cols - len(r)) for r in rows]
                avail = width
                content = []
                for c in range(cols):
                    longest = max(_width(_plain(r[c]), 8.4) for r in rows) or 20
                    content.append(min(longest + 14, avail * 0.62))
                total_w = sum(content)
                if total_w > avail:                      # squeeze, never past the margin
                    colw = [w * avail / total_w for w in content]
                else:                                    # stretch to fill the text column
                    spare = avail - total_w
                    colw = [w + spare * (w / total_w) for w in content]
                need(24 + 14 * len(rows))
                # header
                p.rect(MARGIN, y - 4, avail, 16, INK)
                x = MARGIN + 6
                for c in range(cols):
                    p.text(x, y + 1, 8.4, "F1", _fit(_plain(rows[0][c]), 8.4, colw[c] - 8, "F1"), WHITE)
                    x += colw[c]
                y -= 16
                for n, row in enumerate(rows[1:]):
                    cells = [_fit(_plain(v), 8.4, colw[c] - 8) for c, v in enumerate(row)]
                    h = 14.0
                    if n % 2 == 0:
                        p.rect(MARGIN, y - 3, avail, h, WASH)
                    x = MARGIN + 6
                    for c, v in enumerate(cells):
                        p.text(x, y + 1, 8.4, "F2", v, INK)
                        x += colw[c]
                    p.rule(MARGIN, y - 3, MARGIN + avail, RULE, 0.35)
                    y -= h
                y -= 8
            continue
        # ---- callout
        if line.startswith("> "):
            text = _plain(line[2:])
            segs = _wrap(text, BODY - 0.2, width - 22)
            h = len(segs) * LEAD + 10
            need(h)
            p.rect(MARGIN, y - h + LEAD - 2, width, h, WASH)
            p.rect(MARGIN, y - h + LEAD - 2, 2.6, h, ACCENT)
            yy = y
            for seg in segs:
                p.text(MARGIN + 12, yy, BODY - 0.2, "F2", _fit(seg, BODY - 0.2, width - 26), INK)
                yy -= LEAD
            y -= h + 4
            continue
        # ---- lists
        bullet = re.match(r"^\s*[-*\u2022]\s+(.*)$", line)
        num = re.match(r"^\s*(\d+)[.)]\s+(.*)$", line)
        if bullet or num:
            body = bullet.group(1) if bullet else num.group(2)
            first = True
            for seg in _wrap(_plain(body), BODY, width - 24):
                need(LEAD)
                if first:
                    if bullet:
                        p.rect(MARGIN + 3, y + 2.6, 3.2, 3.2, ACCENT)
                    else:
                        p.text(MARGIN, y, BODY, "F1", num.group(1) + ".", ACCENT)
                p.text(MARGIN + 20, y, BODY, "F2", _fit(seg, BODY, width - 26), INK)
                y -= LEAD
                first = False
            continue
        if re.match(r"^\s*[-—]{3,}\s*$", line):
            need(12)
            p.rule(MARGIN, y + 4, PAGE_W - MARGIN, RULE, 0.5)
            y -= 8
            continue
        # ---- paragraph
        for seg in _wrap(_plain(line), BODY, width):
            need(LEAD)
            p.text(MARGIN, y, BODY, "F2", _fit(seg, BODY, width), INK)
            y -= LEAD
        y -= 2
    return pages


def build(title: str, body_markdown: str, *, subtitle: str = "", sources: list[dict] | None = None,
          author: str = "Adarsh Ensemble", mode: str = "") -> bytes:
    """The whole document: cover, content, sources, running header and footers."""
    today = _dt.date.today().strftime("%d %B %Y")
    rows = [r for r in (sources or []) if isinstance(r, dict) and r.get("url")][:10]
    meta = [("Date", today), ("Prepared by", author)]
    if mode:
        meta.append(("Mode", mode))
    meta.append(("Sources", "%d cited from public APIs" % len(rows) if rows else "model knowledge"))
    pages: list[_Page] = [_cover(title or "Report", subtitle, meta)]
    pages += _render(body_markdown)
    if rows:
        p = _Page()
        pages.append(p)
        y = PAGE_H - MARGIN - 18
        p.text(MARGIN, y, 7.2, "F1", "REFERENCES", ACCENT)
        p.text(MARGIN + 62, y, H1, "F1", "Sources", INK)
        y -= 7
        p.rect(MARGIN, y, PAGE_W - 2 * MARGIN, 1.6, ACCENT)
        y -= H1 + 6
        for n, r in enumerate(rows, 1):
            label = str(r.get("label") or r.get("provider") or "")
            head = _plain(str(r.get("title") or "")) or "source"
            segs = _wrap(head, BODY, PAGE_W - 2 * MARGIN - 20)
            if y - (len(segs) * LEAD + 24) < MARGIN + 30:
                p = _Page()
                pages.append(p)
                y = PAGE_H - MARGIN - 18
            p.text(MARGIN, y, BODY, "F1", "[S%d]" % n, ACCENT)
            for seg in segs:
                p.text(MARGIN + 20, y, BODY, "F2", _fit(seg, BODY, PAGE_W - 2 * MARGIN - 22), INK)
                y -= LEAD
            note = str(r.get("note") or "")[:150]
            if note:
                p.text(MARGIN + 20, y, TINY + 0.4, "F3", _fit(_plain(note), TINY + 0.4, PAGE_W - 2 * MARGIN - 22,
                                                               "F3"), MUTED)
                y -= 11
            url = str(r.get("url") or "")
            for seg in _wrap(url, TINY + 0.6, PAGE_W - 2 * MARGIN - 22, "F4")[:2]:
                p.text(MARGIN + 20, y, TINY + 0.6, "F4", _fit(seg, TINY + 0.6, PAGE_W - 2 * MARGIN - 22, "F4"), ACCENT)
                y -= 10
            p.text(MARGIN + 20, y, TINY, "F2", label, MUTED)
            y -= 16
    total = len(pages)
    head_title = _fit(_plain(title or "Report"), SMALL, PAGE_W - 2 * MARGIN - 90, "F1")
    for n, page in enumerate(pages, 1):
        if n == 1:
            continue
        page.text(MARGIN, PAGE_H - MARGIN + 8, SMALL, "F1", head_title, INK)
        page.text(PAGE_W - MARGIN - _width("ADARSH", SMALL, "F4"), PAGE_H - MARGIN + 8, SMALL, "F4", "ADARSH", ACCENT)
        page.rule(MARGIN, PAGE_H - MARGIN, PAGE_W - MARGIN, RULE, 0.5)
        page.rule(MARGIN, MARGIN - 12, PAGE_W - MARGIN, RULE, 0.5)
        page.text(MARGIN, MARGIN - 24, TINY, "F2", "Adarsh Ensemble - " + today, MUTED)
        foot = "Page %d of %d" % (n, total)
        page.text(PAGE_W - MARGIN - _width(foot, TINY), MARGIN - 24, TINY, "F2", foot, MUTED)
    return _assemble(pages, title, author)


def _assemble(pages: list[_Page], title: str, author: str) -> bytes:
    objs: list[bytes] = []

    def add(b: bytes) -> int:
        objs.append(b)
        return len(objs)          # 1-based object number

    font_ids = {}
    for name, base in (("F1", "Helvetica-Bold"), ("F2", "Helvetica"), ("F3", "Helvetica-Oblique"),
                       ("F4", "Courier")):
        font_ids[name] = add(f"<< /Type /Font /Subtype /Type1 /BaseFont /{base} /Encoding /WinAnsiEncoding >>".encode())
    pages_id = len(objs) + 1 + 2 * len(pages)     # reserved below
    kids, page_ids = [], []
    for page in pages:
        stream = "\n".join(page.ops).encode("cp1252", "replace")
        cid = add(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
        resources = ("<< /Font << " + " ".join(f"/{k} {v} 0 R" for k, v in font_ids.items()) + " >> >>")
        pid = add(f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {PAGE_W:.0f} {PAGE_H:.0f}] "
                  f"/Resources {resources} /Contents {cid} 0 R >>".encode())
        page_ids.append(pid)
        kids.append(f"{pid} 0 R")
    pages_obj = add(f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(pages)} >>".encode())
    assert pages_obj == pages_id, "page tree id must match the /Parent references"
    info = add(f"<< /Title ({_esc(title)[:120]}) /Author ({_esc(author)[:60]}) "
               f"/Producer (Adarsh Ensemble) /Creator (pdf_make) >>".encode())
    catalog = add(f"<< /Type /Catalog /Pages {pages_obj} 0 R >>".encode())

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objs) + 1} /Root {catalog} 0 R /Info {info} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n").encode()
    return bytes(out)


def report(title: str, text: str, *, subtitle: str = "", sources: list[dict] | None = None,
           mode: str = "") -> bytes:
    """Report from a finished answer: the answer becomes the body, its sources become the references page."""
    return build(title, text, subtitle=subtitle, sources=sources, mode=mode)
