import asyncio
import importlib
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import lessons
import roles
import sandbox
import verified


def test_proofs_are_disabled_by_default_and_numpy_file_access_is_rejected(monkeypatch):
    monkeypatch.delenv("CODE_PROOFS", raising=False)
    disabled = sandbox.run_python("print('PASS')")
    assert disabled["status"] == "UNSUPPORTED" and "proofs disabled" in disabled["output"]

    monkeypatch.setenv("CODE_PROOFS", "1")
    blocked = sandbox.run_python("import numpy\nprint(numpy.fromfile('/etc/hostname'))")
    assert blocked["status"] == "REJECTED" and "import not allowed" in blocked["output"]


def test_citations_require_closed_strict_source_tokens():
    sources = [{"n": 1, "title": "one", "url": "https://example.com"}]
    assert roles.cited_sources("valid [S1] but not [S1evil]", sources) == sources
    assert roles.strip_bad_cites("valid [S1] bad [S2] malformed [S1evil]", sources) == (
        "valid [S1] bad  malformed [S1evil]"
    )
    assert "[S1evil]" not in verified.SOURCE_CITATION_RE.findall("[S1evil]")


def test_lessons_bad_numeric_fields_are_safe_and_prompt_is_fail_soft(tmp_path, monkeypatch):
    path = tmp_path / "lessons.json"
    path.write_text(json.dumps([
        {"id": 7, "text": "safe rule", "weight": "x", "held": {}, "ts": "nan", "last": "bad"},
        {"id": "ok", "text": "second", "weight": "3", "held": "2", "ts": "1.5", "last": "2"},
        "not a record",
    ]))
    monkeypatch.setenv("LESSONS_FILE", str(path))
    rows = lessons.list_all()
    assert len(rows) == 2
    assert rows[0]["weight"] >= 1 and rows[0]["held"] >= 0
    block, used = lessons.prompt_block()
    assert used and block.startswith("LESSONS FROM PAST MISTAKES") and "<lessons>" in block

    monkeypatch.setattr(lessons, "list_all", lambda: (_ for _ in ()).throw(RuntimeError("bad store")))
    assert lessons.prompt_block() == ("", [])


def test_auth_fails_closed_and_docs_are_disabled(monkeypatch):
    monkeypatch.setenv("APP_API_KEY", "test-secret")
    monkeypatch.setenv("ALLOW_ANONYMOUS", "0")
    monkeypatch.setenv("ENABLE_DOCS", "0")
    pytest.importorskip("fastapi")
    main = importlib.import_module("main")
    main = importlib.reload(main)
    assert not main._authorized(None, None)
    assert main._authorized("test-secret", None)
    assert not main._authorized("test-secret-extra", None)
    assert main.app.docs_url is None and main.app.redoc_url is None and main.app.openapi_url is None


def test_chat_body_limit_is_checked_before_json_parsing(monkeypatch):
    monkeypatch.setenv("APP_API_KEY", "test-secret")
    monkeypatch.setenv("ALLOW_ANONYMOUS", "0")
    pytest.importorskip("fastapi")
    main = importlib.import_module("main")
    main = importlib.reload(main)
    old = main.MAX_CHAT_BODY_BYTES
    monkeypatch.setattr(main, "MAX_CHAT_BODY_BYTES", 4)

    class Req:
        headers = {"content-length": "5"}

        async def stream(self):
            yield b"{}"

    with pytest.raises(Exception) as exc:
        asyncio.run(main._read_limited_body(Req()))
    assert getattr(exc.value, "status_code", None) == 413
    monkeypatch.setattr(main, "MAX_CHAT_BODY_BYTES", old)
