"""Adarsh knows who sir is: the same background text reaches every mode that talks to him."""
import pathlib
import subprocess
import sys

import prompts

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_about_sir_names_sir_and_the_goal():
    t = prompts.ABOUT_SIR
    for needle in ("Utkarsh", "'sir'", "ADARSH", "creator", "MIT", "robots and rockets", "overthinking"):
        assert needle in t


def test_about_sir_reaches_standard_casual_briefing_and_council():
    # subprocess: importing chat_adapter/briefing here would load health.py before test_quota reloads it
    code = (
        "import prompts, chat_adapter as c, briefing as b;"
        "a = prompts.ABOUT_SIR;"
        "assert a in c.QUICK_SYSTEM and a in c.CASUAL_SYSTEM and a in b.NIGHT_SYSTEM and a in prompts.LEARNER_PROFILE"
    )
    r = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_live_voice_prompt_has_the_same_background():
    js = (ROOT / "ui/src/js/05-voice.js").read_text()
    for needle in ("the user is Utkarsh", "same person", "MIT", "robots and rockets", "little support at home"):
        assert needle in js
