"""Adarsh knows who sir is: the same background text reaches every mode that talks to him."""
import pathlib

import briefing
import chat_adapter
import prompts


def test_about_sir_names_sir_and_the_goal():
    t = prompts.ABOUT_SIR
    for needle in ("Utkarsh", "'sir'", "ADARSH", "creator", "MIT", "robots and rockets", "overthinking"):
        assert needle in t


def test_about_sir_reaches_standard_casual_briefing_and_council():
    assert prompts.ABOUT_SIR in chat_adapter.QUICK_SYSTEM
    assert prompts.ABOUT_SIR in chat_adapter.CASUAL_SYSTEM
    assert prompts.ABOUT_SIR in briefing.NIGHT_SYSTEM
    assert prompts.ABOUT_SIR in prompts.LEARNER_PROFILE


def test_live_voice_prompt_has_the_same_background():
    js = (pathlib.Path(__file__).resolve().parents[1] / "ui/src/js/05-voice.js").read_text()
    for needle in ("the user is Utkarsh", "same person", "MIT", "robots and rockets", "little support at home"):
        assert needle in js
