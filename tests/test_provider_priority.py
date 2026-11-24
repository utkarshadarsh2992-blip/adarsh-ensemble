"""Offline regression tests for provider-first failover and per-key network health.

Every request uses a fake client or httpx.MockTransport; no test in this module can reach
an external endpoint.  These tests deliberately exercise the configured key-slot APIs rather
than hard-coding a provider's internal environment lookup.
"""
import asyncio
import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import config  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402
import standard_agent  # noqa: E402


class Resp:
    def __init__(self, status=200, body=None, headers=None):
        self.status_code = status
        self._body = body if body is not None else {}
        self.headers = headers or {}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


def ok(text="ok"):
    return Resp(
        200,
        {
            "choices": [{"message": {"content": text}, "finish_reason": "stop"}],
            "usage": {"total_tokens": 10},
        },
    )


def status(code):
    return Resp(code, {"error": {"message": f"HTTP {code}"}})


class FakeClient:
    """Async OpenAI-compatible fake keyed by (model id, bearer token)."""

    def __init__(self, script=None, delay=0.0):
        self.script = dict(script or {})
        self.calls = []
        self.delay = delay

    async def post(self, url, json=None, headers=None, timeout=None):
        token = (headers or {}).get("Authorization", "").removeprefix("Bearer ")
        call = {"url": url, "model": json["model"], "token": token}
        self.calls.append(call)
        if self.delay:
            await asyncio.sleep(self.delay)
        behavior = self.script.get((json["model"], token), ok())
        if isinstance(behavior, list):
            behavior = behavior.pop(0) if behavior else ok()
        if callable(behavior):
            behavior = behavior(call)
        if isinstance(behavior, BaseException):
            raise behavior
        return behavior


Q = [{"role": "user", "content": "offline provider priority?"}]
STANDARD_Q = [
    {"role": "system", "content": "sys"},
    {"role": "user", "content": "Chandrayaan-3 kab land hua?"},
]


def token(provider, slot):
    return f"{provider}-key-{slot}"


def set_provider_keys(monkeypatch, provider, slots=(1, 2, 3)):
    env = config.PROVIDERS[provider].api_key_env
    for slot in slots:
        monkeypatch.setenv(config.slot_env(env, slot), token(provider, slot))


def clear_secret_envs(monkeypatch):
    for name in config.SECRET_ENVS:
        monkeypatch.delenv(name, raising=False)


def use(primary, fallbacks=()):
    return config.use(primary, "provider-priority-test", fallbacks)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def clean_health_and_secrets(monkeypatch, tmp_path):
    clear_secret_envs(monkeypatch)
    monkeypatch.setattr(health, "STATE_FILE", str(tmp_path / "provider-priority-usage.json"))
    health.reset(clear_usage=True)
    health.set_stage("")
    yield
    health.reset(clear_usage=True)
    health.set_stage("")


def test_key1_and_key2_503_roll_to_key3_before_foreign_provider(monkeypatch):
    set_provider_keys(monkeypatch, "groq")
    set_provider_keys(monkeypatch, "gemini", (1,))
    primary = use("gpt-oss-120b", ("gemini-3.8-flash",))
    model = primary.model
    client = FakeClient(
        {
            (model, token("groq", 1)): status(503),
            (model, token("groq", 2)): status(503),
            (model, token("groq", 3)): ok("groq key three"),
        }
    )

    assert run(llm.chat(client, primary, Q, retries=0)) == "groq key three"
    assert [(c["model"], c["token"]) for c in client.calls] == [
        (model, token("groq", 1)),
        (model, token("groq", 2)),
        (model, token("groq", 3)),
    ]


def test_key1_and_key2_connect_errors_roll_to_key3_before_foreign_provider(monkeypatch):
    set_provider_keys(monkeypatch, "groq")
    set_provider_keys(monkeypatch, "gemini", (1,))
    primary = use("gpt-oss-120b", ("gemini-3.8-flash",))
    model = primary.model
    client = FakeClient(
        {
            (model, token("groq", 1)): httpx.ConnectError("key one disconnected"),
            (model, token("groq", 2)): httpx.ConnectError("key two disconnected"),
            (model, token("groq", 3)): ok("network rollover"),
        }
    )

    assert run(llm.chat(client, primary, Q, retries=0)) == "network rollover"
    assert [c["token"] for c in client.calls] == [
        token("groq", 1), token("groq", 2), token("groq", 3)
    ]


def test_all_three_network_failures_open_breaker_then_foreign_provider(monkeypatch):
    set_provider_keys(monkeypatch, "groq")
    set_provider_keys(monkeypatch, "gemini", (1,))
    primary = use("gpt-oss-120b", ("gemini-3.8-flash",))
    gmodel = primary.model
    gemodel = config.REGISTRY["gemini-3.8-flash"].model
    client = FakeClient(
        {
            (gmodel, token("groq", 1)): httpx.ConnectError("one"),
            (gmodel, token("groq", 2)): httpx.ConnectError("two"),
            (gmodel, token("groq", 3)): httpx.ConnectError("three"),
            (gemodel, token("gemini", 1)): ok("foreign provider"),
        }
    )

    assert run(llm.chat(client, primary, Q, retries=0)) == "foreign provider"
    assert [c["model"] for c in client.calls] == [gmodel, gmodel, gmodel, gemodel]
    assert [c["token"] for c in client.calls[:3]] == [
        token("groq", 1), token("groq", 2), token("groq", 3)
    ]


def test_first_two_cooling_keys_are_skipped_without_live_calls(monkeypatch):
    set_provider_keys(monkeypatch, "groq")
    set_provider_keys(monkeypatch, "gemini", (1,))
    base = config.REGISTRY["gpt-oss-120b"]
    health.cooldown_key(config.keyed(base, 1), 3600)
    health.cooldown_key(config.keyed(base, 2), 3600)
    primary = use("gpt-oss-120b", ("gemini-3.8-flash",))
    client = FakeClient({(base.model, token("groq", 3)): ok("third is live")})

    assert run(llm.chat(client, primary, Q, retries=0)) == "third is live"
    assert [c["token"] for c in client.calls] == [token("groq", 3)]


def test_missing_slot1_and_server_error_slot2_roll_to_slot3(monkeypatch):
    set_provider_keys(monkeypatch, "groq", (2, 3))
    set_provider_keys(monkeypatch, "gemini", (1,))
    primary = use("gpt-oss-120b", ("gemini-3.8-flash",))
    model = primary.model
    client = FakeClient({
        (model, token("groq", 2)): status(503),
        (model, token("groq", 3)): ok("slot three"),
    })

    assert run(llm.chat(client, primary, Q, retries=0)) == "slot three"
    assert [c["token"] for c in client.calls] == [token("groq", 2), token("groq", 3)]


def test_missing_cooling_and_locally_exhausted_slots_make_no_live_calls(monkeypatch):
    set_provider_keys(monkeypatch, "groq")
    set_provider_keys(monkeypatch, "gemini", (1,))
    base = config.REGISTRY["gpt-oss-120b"]
    slot2 = config.keyed(base, 2)
    health._usage["req"][health.quota_key(slot2)] = config.GROQ_RPD
    health.cooldown_key(config.keyed(base, 1), 3600)
    primary = use("gpt-oss-120b", ("gemini-3.8-flash",))
    client = FakeClient({(base.model, token("groq", 3)): ok("only known-live slot")})

    assert run(llm.chat(client, primary, Q, retries=0)) == "only known-live slot"
    assert [c["token"] for c in client.calls] == [token("groq", 3)]


def test_original_chain_is_stably_grouped_by_provider_not_quota_balance(monkeypatch):
    set_provider_keys(monkeypatch, "groq")
    set_provider_keys(monkeypatch, "gemini", (1,))
    primary = use("gpt-oss-120b", ("gemini-3.8-flash", "gpt-oss-20b"))
    g120 = config.REGISTRY["gpt-oss-120b"].model
    g20 = config.REGISTRY["gpt-oss-20b"].model
    gem = config.REGISTRY["gemini-3.8-flash"].model
    client = FakeClient({
        (g120, token("groq", 1)): status(429),
        (g120, token("groq", 2)): status(429),
        (g120, token("groq", 3)): status(429),
        (g20, token("groq", 1)): ok("later Groq model"),
        (gem, token("gemini", 1)): ok("must not be reached"),
    })

    assert run(llm.chat(client, primary, Q, retries=0)) == "later Groq model"
    assert [c["model"] for c in client.calls] == [g120, g120, g120, g20]
    assert all(c["token"].startswith("groq-") for c in client.calls)


@pytest.mark.parametrize(
    "provider,primary,fallback",
    [
        ("groq", "gpt-oss-120b", "gemini-3.8-flash"),
        ("openrouter", "nemotron-ultra", "gemini-3.8-flash"),
        ("gemini", "gemini-3.8-flash", "gpt-oss-120b"),
        ("cloudflare", "cf-gpt-oss-120b", "gemini-3.8-flash"),
        ("nvidia", "mistral-large-4", "gemini-3.8-flash"),
    ],
)
def test_every_provider_exhausts_two_server_slots_before_successful_third(
    monkeypatch, provider, primary, fallback
):
    clear_secret_envs(monkeypatch)
    health.reset(clear_usage=True)
    set_provider_keys(monkeypatch, provider)
    set_provider_keys(monkeypatch, "gemini" if fallback.startswith("gemini") else "groq", (1,))
    if provider == "cloudflare":
        monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "account-for-offline-test")

    spec = use(primary, (fallback,))
    model = spec.model
    client = FakeClient({
        (model, token(provider, 1)): status(503),
        (model, token(provider, 2)): status(503),
        (model, token(provider, 3)): ok(f"{provider} key three"),
    })

    assert run(llm.chat(client, spec, Q, retries=0)) == f"{provider} key three"
    assert [c["token"] for c in client.calls] == [
        token(provider, 1), token(provider, 2), token(provider, 3)
    ]
    assert all(c["model"] == model for c in client.calls)
    if provider == "cloudflare":
        assert all("account-for-offline-test" in c["url"] for c in client.calls)


def test_helper_with_seventy_percent_quota_still_keeps_healthy_primary(monkeypatch):
    set_provider_keys(monkeypatch, "groq", (1,))
    set_provider_keys(monkeypatch, "gemini", (1,))
    primary = use("gpt-oss-120b", ("gemini-3.8-flash",))
    health._usage["tok"][health.quota_key(primary)] = int(config.GROQ_TPD * 0.70)
    health.set_stage("panel:helper")
    monkeypatch.setattr(config, "QUOTA_BALANCE_AT", 0.60)
    client = FakeClient({(primary.model, token("groq", 1)): ok("primary retained")})

    assert run(llm.chat(client, primary, Q, retries=0)) == "primary retained"
    assert client.calls[0]["model"] == primary.model
    assert client.calls[0]["token"] == token("groq", 1)


def test_time_budget_stops_after_slow_primary_without_abandoning_provider(monkeypatch):
    set_provider_keys(monkeypatch, "groq")
    set_provider_keys(monkeypatch, "gemini", (1,))
    primary = use("gpt-oss-120b", ("gemini-3.8-flash",))
    client = FakeClient({(primary.model, token("groq", 1)): status(503)}, delay=0.05)

    with pytest.raises(llm.LLMError):
        run(llm.chat(client, primary, Q, retries=0, budget=0.02))
    assert len(client.calls) == 1
    assert client.calls[0]["token"] == token("groq", 1)


def test_single_configured_key_keeps_two_failures_available_for_retry(monkeypatch):
    set_provider_keys(monkeypatch, "groq", (1,))
    set_provider_keys(monkeypatch, "gemini", (1,))
    primary = use("gpt-oss-120b", ("gemini-3.8-flash",))
    model = primary.model
    client = FakeClient({
        (model, token("groq", 1)): [status(503), ok("retry on same key")],
    })

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(llm.asyncio, "sleep", no_sleep)
    assert run(llm.chat(client, primary, Q, retries=1)) == "retry on same key"
    assert [c["token"] for c in client.calls] == [token("groq", 1), token("groq", 1)]


def test_provider_breaker_counts_distinct_slots_not_repeated_slot_one(monkeypatch):
    set_provider_keys(monkeypatch, "groq")
    base = config.REGISTRY["gpt-oss-120b"]
    slot3 = config.keyed(base, 3)

    health.provider_error("groq", 1)
    health.provider_error("groq", 1)
    assert health.available(slot3)[0], "repeating slot 1 must not hide untouched slot 3"

    health.provider_error("groq", 2)
    assert health.available(slot3)[0], "slot 3 is still untouched"
    health.provider_error("groq", 3)
    assert not health.available(slot3)[0]
    assert "provider cooling down" in health.available(slot3)[1]


def _standard_transport(monkeypatch, replies):
    log = []
    pending = list(replies)

    def handler(request):
        assert request.url.host == "api.groq.com", "standard mode must never call a foreign provider"
        log.append({
            "host": request.url.host,
            "auth": request.headers.get("authorization", ""),
            "body": json.loads(request.content),
        })
        status_code, body = pending.pop(0)
        return httpx.Response(status_code, json=body)

    monkeypatch.setattr(
        standard_agent,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    return log


def standard_final(text="standard success"):
    return 200, {
        "choices": [{"message": {"content": text}, "finish_reason": "stop"}],
        "usage": {"total_tokens": 10},
    }


def test_standard_server_errors_roll_through_three_groq_keys_only(monkeypatch):
    set_provider_keys(monkeypatch, "groq")
    log = _standard_transport(monkeypatch, [
        (503, {"error": "one"}),
        (503, {"error": "two"}),
        standard_final("third Groq key"),
    ])

    out = run(standard_agent.answer(STANDARD_Q, tools=False, web=False, budget=5))
    assert out["text"] == "third Groq key"
    assert [row["auth"] for row in log] == [
        f"Bearer {token('groq', 1)}",
        f"Bearer {token('groq', 2)}",
        f"Bearer {token('groq', 3)}",
    ]
    assert all(row["body"]["model"] == "openai/gpt-oss-120b" for row in log)


def test_standard_all_three_server_errors_raise_without_foreign_provider(monkeypatch):
    set_provider_keys(monkeypatch, "groq")
    set_provider_keys(monkeypatch, "gemini", (1,))
    log = _standard_transport(monkeypatch, [
        (503, {"error": "one"}),
        (503, {"error": "two"}),
        (503, {"error": "three"}),
    ])

    with pytest.raises(standard_agent.StandardError) as exc:
        run(standard_agent.answer(STANDARD_Q, tools=False, web=False, budget=5))
    assert "Groq" in str(exc.value)
    assert [row["auth"] for row in log] == [
        f"Bearer {token('groq', 1)}",
        f"Bearer {token('groq', 2)}",
        f"Bearer {token('groq', 3)}",
    ]
    assert all(row["host"] == "api.groq.com" for row in log)
