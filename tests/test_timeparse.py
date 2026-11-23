import time

import pytest

from actions import timeparse


NOW = int(time.mktime((2026, 11, 23, 16, 0, 0, 0, 0, -1)) * 1000)


@pytest.mark.parametrize(
    "text, expected",
    [
        ("raat 2 baje", (2026, 11, 24, 2, 0)),
        ("aaj 12 baje raat", (2026, 11, 24, 0, 0)),
        ("raat 8-11 baje", (2026, 11, 23, 20, 0)),
        ("kal 12 am", (2026, 11, 24, 0, 0)),
        ("12 pm", (2026, 11, 23, 12, 0)),
        ("10 मिनट बाद", (2026, 11, 23, 16, 10)),
        ("10 minute baad", (2026, 11, 23, 16, 10)),
        ("shaam 6 baje", (2026, 11, 23, 18, 0)),
        ("subah 7 baje", (2026, 11, 24, 7, 0)),
        ("dopahar 2 baje", (2026, 11, 24, 14, 0)),
        ("रात 3 बजे", (2026, 11, 24, 3, 0)),
        ("शाम 6 बजे", (2026, 11, 23, 18, 0)),
    ],
)
def test_when_table(text, expected):
    result = timeparse.when(text, NOW)
    assert result is not None
    got = time.localtime(result[0] / 1000)
    assert (got.tm_year, got.tm_mon, got.tm_mday, got.tm_hour, got.tm_min) == expected


def test_duration_supports_devanagari_units_without_word_boundary():
    assert timeparse.duration("10 मिनट बाद") == 600
    assert timeparse.duration("10 minute baad") == 600


def test_strip_time_keeps_subject():
    assert timeparse.strip_time("meeting raat 2 baje") == "meeting"
