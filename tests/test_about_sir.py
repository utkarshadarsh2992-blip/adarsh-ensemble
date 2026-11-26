"""Adarsh knows who sir is: the same background text reaches every mode that talks to him."""
import pathlib
import subprocess
import sys

import prompts

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_about_sir_is_compact_identity_not_personal_history():
    t = prompts.ABOUT_SIR
    assert "ADARSH" in t and "Sir" in t
    assert len(t) < 120
    for private_detail in ("Example User", "creator", "Example University", "example robotics and space projects", "fictional overthinking detail", "fictional home-support detail"):
        assert private_detail not in t


def test_compact_identity_and_learning_style_reach_the_intended_prompts():
    # subprocess: importing chat_adapter/briefing here would load health.py before test_quota reloads it
    code = (
        "import prompts, chat_adapter as c, briefing as b;"
        "a = prompts.ABOUT_SIR;"
        "assert a in c.QUICK_SYSTEM and a in c.CASUAL_SYSTEM;"
        "assert 'Sir' in b.NIGHT_SYSTEM;"
        "assert prompts.LEARNER_PROFILE == prompts.LEARNING_STYLE;"
    )
    r = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_live_voice_prompt_keeps_style_without_repeated_personal_history():
    js = (ROOT / "ui/src/js/05-voice.js").read_text()
    assert "LEARNING_STYLE" in js and "requested depth and format" in js
    assert "You are ADARSH" in js and "Always address the user as" in js and '"Sir"' in js
    for private_detail in ("the user is Example User", "about 2 months", "Example University", "example robotics and space projects", "fictional home-support detail"):
        assert private_detail not in js
