"""Offline tests for opaque per-key health usage generations."""
import asyncio
import datetime as dt
import json
import os
import re
import sys
import time

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402


KEY_ENV = {
    "groq": "GROQ_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "nvidia": "NVIDIA_API_KEY",
    "cloudflare": "CLOUDFLARE_API_TOKEN",
}
ALL_ENV = tuple(config.SECRET_ENVS)


@pytest.fixture(autouse=True)
def clean_usage(monkeypatch, tmp_path):
    monkeypatch.setattr(health, "STATE_FILE", str(tmp_path / "key-generation-usage.json"))
    for name in ALL_ENV:
        monkeypatch.delenv(name, raising=False)
    health.reset(clear_usage=True)
    health.set_stage("")
    yield
    health.reset(clear_usage=True)


def _slot(spec, slot=1):
    return config.keyed(spec, slot)


def _groq_rows(report):
    return next(p for p in report["providers"] if p["id"] == "groq")["keys"]


def _gen_rows(rows):
    return [row for row in rows if row.get("generation")]


def _gen_count():
    return sum(len(item.get("generations", {}))
               for item in health._usage["key_usage"]["slots"].values())


def test_all_fifteen_configured_slots_have_zero_usage_rows(monkeypatch):
    for provider, env in KEY_ENV.items():
        for slot in range(1, config.KEY_SLOTS + 1):
            monkeypatch.setenv(config.slot_env(env, slot), f"secret-{provider}-{slot}-do-not-report")
            if provider == "cloudflare":
                monkeypatch.setenv(config.slot_env("CLOUDFLARE_ACCOUNT_ID", slot), f"account-{slot}-private")

    report = health.report()
    providers = {p["id"]: p for p in report["providers"]}
    assert set(providers) == set(KEY_ENV)
    all_ids = []
    for provider in KEY_ENV:
        rows = providers[provider]["keys"]
        assert [row["slot"] for row in rows[:3]] == [1, 2, 3]
        assert len([row for row in rows if row.get("active")]) == 3
        for row in rows[:3]:
            assert row["set"] is True
            assert row["req"] == row["tok"] == 0
            assert re.fullmatch(r"[0-9a-f]{32}", row["generation"])
            assert row["active"] is True
            assert dt.date.fromisoformat(row["tracked_since_day"]) <= dt.date.fromisoformat(report["day_utc"])
            all_ids.append(row["generation"])
    assert len(set(all_ids)) == 15
    assert all(p["req"] == p["tok"] == 0 for p in providers.values())
    assert isinstance(report["sampled_at"], int)


def test_rotation_separates_counts_and_repeat_save_same_key_does_not_rotate(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "groq-secret-key-A-unique")
    spec = _slot(config.REGISTRY["gpt-oss-120b"])
    first = _groq_rows(health.report())[0]
    gen_a = first["generation"]
    health.note_request(spec)
    health.success(spec, 123)

    # An unchanged settings save/report is not a rotation and keeps today's active quota.
    same = _groq_rows(health.report())[0]
    assert same["generation"] == gen_a and same["req"] == 1 and same["tok"] == 123
    assert health.snapshot()["requests_today"][health.quota_key(spec)] == 1

    monkeypatch.setenv("GROQ_API_KEY", "groq-secret-key-B-unique")
    after = health.report()
    rows = _groq_rows(after)
    active = next(row for row in rows if row.get("active"))
    old = next(row for row in rows if row.get("generation") == gen_a)
    assert active["generation"] != gen_a and active["req"] == active["tok"] == 0
    assert old["active"] is False and old["req"] == 1 and old["tok"] == 123
    assert after["totals"] == {"req": 1, "tok": 123}
    assert health.quota_key(spec) not in health.snapshot()["requests_today"]

    health.note_request(spec)
    health.success(spec, 22)
    final = health.report()
    rows = _groq_rows(final)
    new = next(row for row in rows if row.get("active"))
    old = next(row for row in rows if row.get("generation") == gen_a)
    assert new["req"] == 1 and new["tok"] == 22
    assert old["req"] == 1 and old["tok"] == 123
    assert final["totals"] == {"req": 2, "tok": 145}
    assert next(p for p in final["providers"] if p["id"] == "groq")["req"] == 2


def test_delete_and_readd_different_key_preserves_retired_usage(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "delete-me-key-A")
    spec = _slot(config.REGISTRY["gpt-oss-120b"])
    gen_a = _groq_rows(health.report())[0]["generation"]
    health.note_request(spec)
    health.success(spec, 17)

    monkeypatch.delenv("GROQ_API_KEY")
    deleted = health.report()
    assert _groq_rows(deleted)[0]["set"] is False
    archived_a = next(r for r in _gen_rows(_groq_rows(deleted)) if r["generation"] == gen_a)
    assert archived_a["active"] is False and archived_a["req"] == 1 and archived_a["tok"] == 17

    monkeypatch.setenv("GROQ_API_KEY", "readded-different-key-B")
    readded = health.report()
    rows = _groq_rows(readded)
    active = next(row for row in rows if row.get("active"))
    assert active["generation"] != gen_a and active["req"] == active["tok"] == 0
    assert next(row for row in rows if row.get("generation") == gen_a)["tok"] == 17
    assert readded["totals"] == {"req": 1, "tok": 17}


def test_cloudflare_account_id_is_part_of_generation_identity(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "same-cloudflare-token")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "account-one-secret")
    before = next(p for p in health.report()["providers"] if p["id"] == "cloudflare")["keys"][0]
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "account-two-secret")
    after = next(p for p in health.report()["providers"] if p["id"] == "cloudflare")["keys"]
    assert next(r for r in after if r.get("active"))["generation"] != before["generation"]
    assert len(_gen_rows(after)) == 2


def test_rotation_and_provider_save_reset_only_the_changed_slots_quota(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "slot-one-stays")
    monkeypatch.setenv("GROQ_API_KEY_2", "slot-two-changes")
    base = config.REGISTRY["gpt-oss-120b"]
    slot1, slot2 = _slot(base, 1), _slot(base, 2)
    health.report()  # persist both identities before the simulated settings save
    health.note_request(slot1)
    health.note_request(slot2)
    health.rate_limited(slot1, 3600, daily=True)
    health.rate_limited(slot2, 3600, daily=True)
    first_qkey, second_qkey = health.quota_key(slot1), health.quota_key(slot2)

    monkeypatch.setenv("GROQ_API_KEY_2", "slot-two-new-secret")
    health.forget_provider("groq")  # the Android settings callback is provider-scoped
    assert health._usage["req"].get(first_qkey) == 1
    assert second_qkey not in health._usage["req"]
    assert first_qkey in health._usage["out"]
    assert second_qkey not in health._usage["out"]


def test_legacy_counters_stay_unknown_and_utc_roll_keeps_generation_history(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "rollover-secret-key")
    spec = _slot(config.REGISTRY["gpt-oss-120b"])
    active = _groq_rows(health.report())[0]
    generation = active["generation"]
    health.note_request(spec)
    health.success(spec, 34)

    # Simulate one pre-rollout counter pair: it belongs in an identity-free unknown row.
    health._usage["req"]["groq:openai/gpt-oss-20b"] = 3
    health._usage["tok"]["groq:openai/gpt-oss-20b"] = 90
    health._usage["day"] = "2026-11-25"
    health._roll()

    history = health._usage["hist"][-1]
    assert history["day"] == "2026-11-25"
    assert sum(history["req"].values()) == 4 and sum(history["tok"].values()) == 124
    slot_record = history["key_usage"]["slots"]["groq#1"]
    assert slot_record["unknown"]["req"]["openai/gpt-oss-20b"] == 3
    assert slot_record["unknown"]["tok"]["openai/gpt-oss-20b"] == 90
    assert generation in slot_record["generations"]

    today = health.report()
    assert today["totals"] == {"req": 0, "tok": 0}
    reports = health.controller_reports()
    yesterday = next(r for r in reports if r["day_utc"] == "2026-11-25")
    groq = next(p for p in yesterday["providers"] if p["id"] == "groq")
    assert sum(k["req"] for k in groq["keys"]) == 4
    assert sum(k["tok"] for k in groq["keys"]) == 124
    assert any(k.get("generation") == generation for k in groq["keys"])
    assert any(k.get("generation_unknown") and not k.get("generation") for k in groq["keys"])
    assert all(isinstance(r["sampled_at"], int) for r in reports)


def test_inflight_success_is_attributed_to_request_start_generation(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "inflight-key-A")
    spec = _slot(config.REGISTRY["gpt-oss-120b"])
    generation_a = _groq_rows(health.report())[0]["generation"]
    health.note_request(spec)

    # A different task reports/synchronizes the rotation while A's call is still in flight.
    monkeypatch.setenv("GROQ_API_KEY", "inflight-key-B")
    health.report()
    health.success(spec, 81)

    report = health.report()
    rows = _groq_rows(report)
    old = next(row for row in rows if row.get("generation") == generation_a)
    active = next(row for row in rows if row.get("active"))
    assert old["req"] == 1 and old["tok"] == 81 and old["active"] is False
    assert active["req"] == active["tok"] == 0
    assert report["totals"] == {"req": 1, "tok": 81}
    assert health.quota_key(spec) not in health.snapshot()["tokens_today"]


def test_reports_and_local_state_never_store_or_echo_credentials_or_prompts(monkeypatch, tmp_path):
    secret = "never-persist-this-provider-secret-123"
    account = "never-persist-this-account-secret-456"
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", secret)
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", account)
    report = health.report()
    serialized_report = json.dumps(report)
    state = open(health.STATE_FILE, encoding="utf-8").read()
    assert secret not in serialized_report and account not in serialized_report
    assert secret not in state and account not in state
    assert "caller prompt" not in serialized_report and "caller prompt" not in state
    assert "key_generation_salt" not in serialized_report
    assert re.search(r'"key_generation_salt"\s*:\s*"[A-Za-z0-9+/=]+"', state)
    stored = json.loads(state)
    loaded = health._load()
    cloudflare_state = loaded["key_generation_state"]["cloudflare#1"]
    assert cloudflare_state["id"] == next(
        row["generation"] for row in next(p for p in report["providers"] if p["id"] == "cloudflare")["keys"]
        if row.get("active")
    )
    assert loaded["key_generation_salt"] == stored["key_generation_salt"]


def test_daily_generation_archive_is_bounded_and_pruning_preserves_totals(monkeypatch):
    spec = _slot(config.REGISTRY["gpt-oss-120b"])
    total_generations = 56
    for number in range(total_generations):
        monkeypatch.setenv("GROQ_API_KEY", f"rotating-key-{number:02d}")
        health.note_request(spec)
        health.success(spec, 5)
        # Synchronize/retire this identity before the next request.
        health.report()
    report = health.report()
    assert _gen_count() <= health.MAX_DAILY_GENERATIONS
    assert report["totals"] == {"req": total_generations, "tok": total_generations * 5}
    rows = _groq_rows(report)
    assert len(rows) <= 60
    assert any(row.get("generation_unknown") for row in rows)


def test_openrouter_shared_quota_has_model_detail_without_double_counting(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "openrouter-generation-A")
    specs = [_slot(s) for s in config.REGISTRY.values() if s.provider == "openrouter"][:2]
    assert len(specs) == 2
    for spec, tokens in zip(specs, (11, 22)):
        health.note_request(spec)
        health.success(spec, tokens)
    for _ in range(3):
        report = health.report()
        provider = next(p for p in report["providers"] if p["id"] == "openrouter")
        current = next(row for row in provider["keys"] if row.get("active"))
        assert report["totals"] == {"req": 2, "tok": 33}
        assert provider["req"] == current["req"] == 2
        assert provider["tok"] == current["tok"] == 33
        assert {m["model"] for m in current["models"]} == {s.model for s in specs}
        assert not any(row.get("generation_unknown") for row in provider["keys"])
    generation_a = current["generation"]
    monkeypatch.setenv("OPENROUTER_API_KEY", "openrouter-generation-B")
    health.report()
    health.note_request(specs[0])
    health.success(specs[0], 5)
    monkeypatch.setenv("OPENROUTER_API_KEY", "openrouter-generation-A")
    final = health.report()
    current = next(row for row in next(p for p in final["providers"] if p["id"] == "openrouter")["keys"] if row.get("active"))
    assert current["generation"] == generation_a
    assert current["req"] == 2 and current["tok"] == 33
    assert health._usage["req"]["openrouter"] == 2
    assert health._usage["tok"]["openrouter"] == 33
    assert final["totals"] == {"req": 3, "tok": 38}
    assert not any(key.startswith("openrouter:") for key in health._usage["req"])


def test_rotation_clears_only_changed_slots_minute_reservations(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "window-key-one-A")
    monkeypatch.setenv("GROQ_API_KEY_2", "window-key-two-A")
    base = config.REGISTRY["gpt-oss-120b"]
    health.report()
    one, two = health.quota_key(_slot(base, 1)), health.quota_key(_slot(base, 2))
    health.reserve_slot(one, 1, 100, 20, 0)
    health.reserve_slot(two, 1, 100, 20, 0)
    monkeypatch.setenv("GROQ_API_KEY_2", "window-key-two-B")
    health.forget_provider("groq")
    assert one in health._slots and two not in health._slots
    assert health.reserve_slot(two, 1, 100, 20, 0)[0] is True


def _provider_rows(report, provider):
    return next(item for item in report["providers"] if item["id"] == provider)["keys"]


@pytest.mark.parametrize("provider", ["groq", "cloudflare"])
def test_delayed_http_attempt_uses_and_charges_credential_snapshot(monkeypatch, provider):
    if provider == "groq":
        spec = _slot(config.REGISTRY["gpt-oss-120b"])
        key_a, key_b = "groq-snapshot-A", "groq-snapshot-B"
        monkeypatch.setenv("GROQ_API_KEY", key_a)
        gen_a = next(row["generation"] for row in _groq_rows(health.report()) if row.get("active"))
        rotate = lambda: monkeypatch.setenv("GROQ_API_KEY", key_b)
        expected_url_fragment = "api.groq.com"
    else:
        spec = _slot(config.REGISTRY["cf-gpt-oss-120b"])
        key_a = key_b = "cloudflare-snapshot-token"
        monkeypatch.setenv("CLOUDFLARE_API_TOKEN", key_a)
        monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "account-snapshot-A")
        gen_a = next(row["generation"] for row in _provider_rows(health.report(), "cloudflare")
                     if row.get("active"))
        rotate = lambda: monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "account-snapshot-B")
        expected_url_fragment = "/accounts/account-snapshot-A/"

    # Create a near-expiry reservation so _try_model really enters its asynchronous wait.
    quota = health.quota_key(spec)
    now = time.time()
    assert health.reserve_slot(quota, 1, 0, 1, 0, now=now - 59.8) == (True, 0.0)
    monkeypatch.setattr(config, "rpm_limit", lambda _spec: 1)

    class Client:
        def __init__(self):
            self.sent_headers = None
            self.sent_url = None

        async def post(self, url, *, json, headers, timeout):
            self.sent_headers, self.sent_url = dict(headers), url
            return httpx.Response(200, json={
                "choices": [{"message": {"content": "snapshot answer"}, "finish_reason": "stop"}],
                "usage": {"total_tokens": 41},
            })

    client = Client()
    real_sleep = asyncio.sleep

    async def rotate_during_wait(seconds):
        assert seconds > 0
        await real_sleep(0)
        rotate()
        health.report()  # synchronize replacement identity before the old request is accounted

    monkeypatch.setattr(llm.asyncio, "sleep", rotate_during_wait)

    async def run_request():
        return await llm._try_model(client, spec, [{"role": "user", "content": "x"}], None, 32, 5, 0)

    assert asyncio.run(run_request()) == "snapshot answer"
    assert client.sent_headers["Authorization"] == f"Bearer {key_a}"
    assert expected_url_fragment in client.sent_url

    report = health.report()
    rows = _provider_rows(report, provider)
    old = next(row for row in rows if row.get("generation") == gen_a)
    active = next(row for row in rows if row.get("active"))
    assert old["req"] == 1 and old["tok"] == 41 and old["active"] is False
    assert active["req"] == active["tok"] == 0
    assert report["totals"] == {"req": 1, "tok": 41}
    assert health.quota_key(spec) not in health.snapshot()["requests_today"]


def test_report_keys_completeness_and_sampled_at_are_authoritative(monkeypatch):
    # Pin wall clock so snapshots share a millisecond; the persisted clock must still advance.
    monkeypatch.setattr(health.time, "time", lambda: 1_800_000_000.0)
    first = health.report()
    second = health.report()
    assert second["sampled_at"] == first["sampled_at"] + 1
    assert all(provider["keys_complete"] is True for provider in second["providers"])
    assert health._load()["_sampled_at_ms"] == second["sampled_at"]

    today = dt.date.fromisoformat(health._today())
    health._usage["hist"] = [
        {"day": (today - dt.timedelta(days=1)).isoformat(), "req": {}, "tok": {}, "feat": {}, "truth": {}},
        {"day": (today - dt.timedelta(days=2)).isoformat(), "req": {}, "tok": {}, "feat": {}, "truth": {},
         "key_usage": {"slots": {}}},
    ]
    reports = health.controller_reports()
    assert reports[1]["sampled_at"] > reports[0]["sampled_at"]
    aggregate = next(p for p in reports[1]["providers"] if p["id"] == "groq")
    ledger = next(p for p in reports[2]["providers"] if p["id"] == "groq")
    assert aggregate["keys_complete"] is False
    assert ledger["keys_complete"] is True
