import datetime as dt
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config  # noqa: E402
import health  # noqa: E402


@pytest.fixture(autouse=True)
def clean_usage(monkeypatch, tmp_path):
    monkeypatch.setattr(health, "STATE_FILE", str(tmp_path / "usage.json"))
    health.reset(clear_usage=True)
    yield
    health.reset(clear_usage=True)


def test_standard_usage_indicator_uses_configured_groq_primary(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")
    monkeypatch.setattr(config, "STANDARD_CHAIN_LABELS", ("gpt-oss-20b", "gpt-oss-120b"))
    spec = config.REGISTRY["gpt-oss-20b"]
    health._usage["req"][health.quota_key(spec)] = int(config.GROQ_RPD * 0.9)

    usage = health.report()

    assert usage["standard"] == {"state": "low", "left": 0.1}
    groq = next(p for p in usage["providers"] if p["id"] == "groq")
    model_ids = [m["model"] for m in groq["keys"][0]["models"]]
    assert spec.model in model_ids
    assert config.REGISTRY["gpt-oss-120b"].model not in model_ids


def test_controller_reports_are_unique_and_limited_to_utc_last_14_days():
    today = dt.date.fromisoformat(health._today())
    hist = []
    for offset in range(16, 0, -1):
        day = (today - dt.timedelta(days=offset)).isoformat()
        hist.append({"day": day, "req": {"groq": offset}, "tok": {}, "feat": {}, "truth": {}})
    duplicate = (today - dt.timedelta(days=2)).isoformat()
    hist.append({"day": duplicate, "req": {"groq": 999}, "tok": {}, "feat": {}, "truth": {}})
    health._usage["hist"] = hist

    reports = health.controller_reports()

    days = [r["day_utc"] for r in reports]
    expected = [(today - dt.timedelta(days=offset)).isoformat() for offset in range(14)]
    assert len(reports) == 14  # current plus at most 13 historical reports
    assert days == expected
    assert len(set(days)) == len(days)
    assert next(r for r in reports if r["day_utc"] == duplicate)["totals"]["req"] == 999
    assert all(r["standard"]["state"] == "unknown" for r in reports[1:])
