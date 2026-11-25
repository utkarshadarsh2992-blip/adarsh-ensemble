"""Research sources and the PDF system: real data in every mode, keyless, fail-soft.

The sandbox has no network in tests, so these check routing, the prompt contract, the PDF writer/reader round trip and
the wiring (chat_adapter, the page, the Kotlin bridge) rather than live HTTP.
"""
import base64
import inspect
import re
from pathlib import Path

import chat_adapter
import pdf_make
import pdf_read
import sources

ROOT = Path(__file__).resolve().parent.parent
ADAPTER = (ROOT / "chat_adapter.py").read_text()
CHAT_JS = (ROOT / "ui/src/js/03-chat.js").read_text()
VIEWS_JS = (ROOT / "ui/src/js/04-views.js").read_text()
CORE_JS = (ROOT / "ui/src/js/01-core.js").read_text()
BRIDGE = (ROOT / "android/app/src/main/java/app/adarsh/ensemble/AdarshBridge.kt").read_text()
ACTIVITY = (ROOT / "android/app/src/main/java/app/adarsh/ensemble/MainActivity.kt").read_text()


def test_every_requested_provider_is_registered():
    for pid in ("arxiv", "semanticscholar", "openalex", "huggingface", "mitocw", "nasa", "nist",
                "openstax", "yc", "worldbank", "spacex", "launchlibrary", "opennotify", "ros"):
        assert pid in sources.PROVIDERS, pid
    # nothing here needs a key: the app must work with only the Gemini/Groq keys the user already has
    text = (ROOT / "sources.py").read_text()
    assert "api_key" not in text and "API_KEY" not in text and "getenv" not in text


def test_routing_follows_the_question():
    space = sources.route("Starship launch kab hai aur orbit kaise achieve hota hai")
    assert space[0] in {"spacex", "launchlibrary", "nasa"} and "openalex" in space
    assert sources.route("ISS abhi kahan hai")[0] == "spacex" and "opennotify" in sources.route("ISS abhi kahan hai")
    robot = sources.route("humanoid robot ka SLAM kaise kaam karta hai")
    assert "arxiv" in robot and "ros" in robot
    assert "worldbank" in sources.route("India ka GDP growth aur inflation")
    assert "yc" in sources.route("YC startup funding round kaise hota hai")
    assert "nist" in sources.route("speed of light constant ki value kya hai")
    assert "openstax" in sources.route("physics textbook ka problem set")
    # a plain question still gets the two general paper APIs
    plain = sources.route("quantum entanglement simple words me")
    assert plain[:2] == ["arxiv", "openalex"] or set(plain) == {"arxiv", "openalex"}


def test_prompt_block_is_numbered_and_fenced():
    rows = [{"provider": "arxiv", "label": "arXiv", "title": "Entropy", "url": "https://arxiv.org/abs/1", "note": "2024"},
            {"provider": "nasa", "label": "NASA", "title": "Artemis", "url": "https://images.nasa.gov/details/x"}]
    block = sources.block(rows)
    assert block.startswith("\n\n[SOURCES") and "[S1] arXiv · Entropy" in block and "[S2] NASA · Artemis" in block
    assert "untrusted" in block and "never invent a source" in block
    assert len(sources.block([{"title": "x" * 4000, "url": "https://a", "label": "L"}])) <= 1800
    assert sources.block([]) == ""
    footer = sources.footer(rows)
    assert footer.startswith("\n\nSources:") and "https://arxiv.org/abs/1" in footer


def test_query_forms_shrink_until_an_api_can_match():
    # public APIs AND their terms: the full sentence is 0 hits, the short forms work
    f = sources.forms("Starship ka latest launch aur humanoid robot SLAM")
    assert f[0] == "Starship launch humanoid robot SLAM"
    assert "Starship launch" in f and f[-1] == "SLAM"
    assert len(f) == len({x.lower() for x in f})          # no duplicates
    assert sources.forms("hi") == ["hi"]
    assert sources.forms("") == []


def test_sources_are_skipped_for_app_records_and_tiny_messages_not_for_history():
    src = inspect.getsource(chat_adapter.handle)
    assert 'not has_records and len(str(text or "").split()) >= 3' in src


def test_a_failed_source_says_nothing():
    import asyncio
    rows = asyncio.run(sources.collect(""))          # too short: no lookups at all
    assert rows == []


def test_pdf_round_trip():
    body = "# Findings\n\nEntropy badhti hai [S1].\n\n## 1. Points\n- first\n- second\n\n```py\nx = 1\n```\n"
    data = pdf_make.build("Entropy report", body, subtitle="Physics", sources=[{"label": "arXiv", "title": "T", "url": "https://a"}])
    assert data.startswith(b"%PDF-1.4") and data.rstrip().endswith(b"%%EOF")
    assert b"/Type /Page" in data and b"/Title (Entropy report)" in data
    text = pdf_read.extract(data)
    assert "Findings" in text and "Entropy badhti hai" in text and "Sources" in text
    # a second page carries the running header and the page number
    assert "Page 2 of" in text
    assert pdf_read.extract(b"not a pdf") == ""


def test_pdf_attachment_reading():
    data = pdf_make.build("Attached", "# Section\n\nYe document ka text hai.")
    url = "data:application/pdf;base64," + base64.b64encode(data).decode()
    block, names = pdf_read.attachments_text([{"name": "doc.pdf", "type": "application/pdf", "dataUrl": url}])
    assert names == ["doc.pdf"] and "Ye document ka text hai" in block and "[PDF: doc.pdf]" in block
    assert pdf_read.attachments_text([{"name": "a.txt", "dataUrl": "data:text/plain;base64,aGk="}]) == ("", [])


def test_sources_and_pdf_are_wired_into_every_mode():
    # one injection point covers Standard (quick reply) and every council mode
    assert "await sources.gather(text)" in ADAPTER
    assert 'app_context.philosophy(body) + pdf_block + src_block + extra' in ADAPTER
    assert 'if rp.get("research") != "off"' in ADAPTER
    assert "sources.footer(src_rows)" in ADAPTER and 'quick["sources"] = src_rows' in ADAPTER
    assert "replies[0][\"sources\"] = src_rows" in ADAPTER
    # PDF: read on the way in, built on request on the way out
    assert "pdf_read.attachments_text(body.get(\"attachments\"))" in ADAPTER
    assert "_wants_pdf(text)" in ADAPTER and "pdf_make.report(" in ADAPTER
    # the page sends the switch and saves the report
    assert "research: S.settings.research === false ? 'off' : 'on'" in CHAT_JS
    assert "research: true" in CORE_JS and "'Research sources'" in VIEWS_JS
    assert "AdarshNative.savePdf" in CHAT_JS
    # the report is offered as a card with a Download button; nothing is written to Downloads on its own
    assert "function holdPdf(" in CHAT_JS and "const PDFS = new Map();" in CHAT_JS
    assert "function pdfEl(m)" in CHAT_JS and "'Download'" in CHAT_JS
    assert "holdPdf(r)" in CHAT_JS and "r.pdfFile = {" in CHAT_JS
    assert "fun savePdf(" in BRIDGE and "fun savePdf(" in ACTIVITY
    assert "MediaStore.Downloads" in ACTIVITY


def test_pdf_is_only_built_when_asked():
    import chat_adapter
    assert chat_adapter._wants_pdf("is par ek pdf bana do")
    assert chat_adapter._wants_pdf("generate a report please")
    assert not chat_adapter._wants_pdf("entropy kya hai")
    assert not chat_adapter._wants_pdf("")


def test_pdf_is_a_structured_report_with_tables_and_a_real_title():
    title, body = chat_adapter._pdf_title("### Entropy kya hai\nText here\n\n| A | B |\n|---|---|\n| 1 | 2 |", "pdf bana do")
    assert title == "Entropy kya hai" and "### Entropy" not in body
    data = pdf_make.report(title, "# Part\n" + body + "\n> note\n", sources=[{"label": "arXiv", "title": "T", "url": "https://a"}], mode="Physics")
    text = pdf_read.extract(data)
    for word in ("DOCUMENT DETAILS", "Physics", "Entropy kya hai", "Sources", "Page 2 of 3"):
        assert word.replace(" ", "") in text.replace(" ", ""), word
    # the page must not truncate the base64 of a report
    assert "const pdfKeep" in CHAT_JS and "out.pdf = pdfKeep" in CHAT_JS
