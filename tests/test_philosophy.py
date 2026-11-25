"""Philosophy page (v1.0.71): the user's own principles are followed in every answer, in every mode.

Rules: saved only on the phone, capped, secrets redacted, never an instruction source for actions,
and always the first block of the prompt so the 6000-char cap can never cut it.
"""
import asyncio
import inspect

import app_context
import chat_adapter


def test_philosophy_is_injected_and_redacted():
    body = {"philosophy": "  Sach bolo. api_key: SECRET_VALUE  "}
    out = app_context.philosophy(body)
    assert "Sach bolo" in out and "SECRET_VALUE" not in out
    assert out.startswith("\n\n[User's personal philosophy")
    assert "do not repeat it unless asked" in out


def test_philosophy_is_capped_and_optional():
    assert app_context.philosophy({}) == ""
    assert app_context.philosophy({"philosophy": None}) == ""
    long = "x" * 5000
    assert len(app_context.philosophy({"philosophy": long})) < 3300


def test_background_voice_philosophy_arrives_inside_reply():
    # The voice service forwards `reply` only, so the string is read from there as a fallback.
    body = {"reply": {"lang": "auto", "philosophy": "Short answers only."}}
    assert "Short answers only." in app_context.philosophy(body)
    # a non-string value is ignored, never raised
    assert app_context.philosophy({"reply": {"philosophy": 5}}) == ""


def test_philosophy_goes_first_so_the_cap_never_cuts_it():
    src = inspect.getsource(chat_adapter.handle)
    assert "(app_context.philosophy(body) + extra)[:6000]" in src
    # philosophy is prepended, so it is the first thing in `extra` even when records fill the cap
    assert "(app_context.philosophy(body) + extra)[:6000]" in src
    # casual Standard small talk follows it too (it never reaches the pipeline)
    assert "app_context.philosophy(body or {})" in inspect.getsource(chat_adapter._casual_reply)


def test_philosophy_reaches_the_model_in_a_council_mode(monkeypatch):
    seen = {}

    async def fake_run(question, *args, **kwargs):
        seen["q"] = question
        return {"answer": "ok", "sources": [], "steps": []}

    monkeypatch.setattr(chat_adapter.pipeline, "run", fake_run)
    body = {"text": "Newton ke niyam samjhao", "mode": "physics", "philosophy": "Pehle basics, phir detail."}
    asyncio.run(chat_adapter.handle(body))
    assert "Pehle basics, phir detail." in seen["q"]


def test_philosophy_is_not_an_action_source():
    # The philosophy block is data: the local action parser never sees it.
    import actions.parser
    assert "philosophy" not in inspect.getsource(actions.parser).lower()
