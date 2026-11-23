"""Three API keys per provider (Settings > API keys): key 1 first, then key 2, then key 3, then the next model.
No network: fake HTTP clients record which key (Authorization header) every call used.
"""
import asyncio
import base64
import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")

import android_entry  # noqa: E402
import config  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402
import nvidia_media  # noqa: E402
import voice  # noqa: E402

ALL = [config.slot_env(n, s) for s in (1, 2, 3)
       for n in ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN",
                 "CLOUDFLARE_ACCOUNT_ID", "NVIDIA_API_KEY")]
SMALL = [{"role": "user", "content": "q?"}]


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for env in ALL:
        monkeypatch.delenv(env, raising=False)
    health.reset(clear_usage=True)
    yield
    health.reset(clear_usage=True)


class Resp:
    def __init__(self, status=200, body=None, headers=None, text=""):
        self.status_code, self._body, self.headers, self.text = status, body, headers or {}, text

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


def ok(text="ok"):
    return Resp(200, {"choices": [{"message": {"content": text}, "finish_reason": "stop"}], "usage": {"total_tokens": 10}})


class Client:
    """script: (model, key) -> Resp | Exception. Unlisted pairs answer "ok"."""

    def __init__(self, script=None):
        self.script, self.calls = script or {}, []

    async def post(self, url, json=None, headers=None, timeout=None):
        key = headers["Authorization"].removeprefix("Bearer ")
        self.calls.append((json["model"], key, url))
        beh = self.script.get((json["model"], key), ok())
        if isinstance(beh, Exception):
            raise beh
        return beh


def run(coro):
    return asyncio.run(coro)


def groq_keys(monkeypatch, *keys):
    for slot, key in enumerate(keys, start=1):
        if key:
            monkeypatch.setenv(config.slot_env("GROQ_API_KEY", slot), key)


# ---------------------------------------------------------------- config
def test_fifteen_key_slots_plus_cloudflare_ids_are_known_everywhere():
    for base in ("GROQ_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "NVIDIA_API_KEY", "CLOUDFLARE_API_TOKEN",
                 "CLOUDFLARE_ACCOUNT_ID"):
        for slot in (1, 2, 3):
            name = config.slot_env(base, slot)
            assert name in config.SECRET_ENVS and name in android_entry.KEY_NAMES
    assert set(config.SECRET_ENVS) == set(android_entry.KEY_NAMES)
    assert len(config.SECRET_ENVS) == 19  # 15 keys + 3 Cloudflare account ids + Tavily


def test_empty_slot_is_skipped_and_first_configured_key_is_the_default(monkeypatch):
    p = config.PROVIDERS["groq"]
    assert p.slots() == [] and p.api_key == ""
    groq_keys(monkeypatch, "", "gsk_two", "gsk_three")
    assert p.slots() == [2, 3] and p.api_key == "gsk_two"


def test_cloudflare_slot_needs_its_token_and_an_account_id(monkeypatch):
    p = config.PROVIDERS["cloudflare"]
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN_2", "cf_tok_2")
    assert p.slots() == []  # no account id anywhere yet
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID_2", "acc2")
    assert p.slots() == [2]
    assert p.url_for(2) == "https://api.cloudflare.com/client/v4/accounts/acc2/ai/v1"
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN_3", "cf_tok_3")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acc1")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "cf_tok_1")
    assert p.slots() == [1, 2, 3]
    assert p.url_for(3).endswith("/accounts/acc1/ai/v1")  # slot 3 has no own id: slot 1's is used


def test_slot_labels_keep_key_one_state_unchanged():
    spec = config.REGISTRY["gpt-oss-120b"]
    assert config.keyed(spec, 1).label == "gpt-oss-120b"
    assert config.keyed(spec, 2).label == "gpt-oss-120b#2"
    assert health.quota_key(config.keyed(spec, 1)) == "groq:openai/gpt-oss-120b"
    assert health.quota_key(config.keyed(spec, 3)) == "groq:openai/gpt-oss-120b#3"
    assert config.base_label("gpt-oss-120b#3") == "gpt-oss-120b"


# ---------------------------------------------------------------- llm.chat rotation
@pytest.mark.parametrize("failure", [
    Resp(429, {"error": {"message": "slow down"}}, headers={"retry-after": "30"}),
    Resp(402, {"error": {"message": "credits"}}),
    Resp(401, {"error": {"message": "bad key"}}),
    Resp(403, {"error": {"message": "forbidden"}}),
    Resp(503, {"error": {"message": "down"}}),
    httpx.ConnectError("server down"),
])
def test_same_model_moves_to_the_next_key(monkeypatch, failure):
    groq_keys(monkeypatch, "gsk_one", "gsk_two", "gsk_three")
    spec = config.use("gpt-oss-120b", "synthesizer", ["gemini-3.1-flash-lite"])
    c = Client({("openai/gpt-oss-120b", "gsk_one"): failure})
    assert run(llm.chat(c, spec, SMALL, retries=1)) == "ok"
    assert [(m, k) for m, k, _ in c.calls] == [("openai/gpt-oss-120b", "gsk_one"), ("openai/gpt-oss-120b", "gsk_two")]


def test_all_three_keys_fail_then_the_chain_moves_on(monkeypatch):
    groq_keys(monkeypatch, "gsk_one", "gsk_two", "gsk_three")
    monkeypatch.setenv("GEMINI_API_KEY", "gem_one")
    spec = config.use("gpt-oss-120b", "synthesizer", ["gemini-3.1-flash-lite"])
    limited = Resp(429, {"error": {"message": "limit"}}, headers={"retry-after": "120"})
    c = Client({("openai/gpt-oss-120b", k): limited for k in ("gsk_one", "gsk_two", "gsk_three")})
    assert run(llm.chat(c, spec, SMALL, retries=0)) == "ok"
    assert [k for _, k, _ in c.calls] == ["gsk_one", "gsk_two", "gsk_three", "gem_one"]


def test_bad_key_is_cooled_alone_and_later_calls_start_at_the_next_key(monkeypatch):
    groq_keys(monkeypatch, "gsk_one", "gsk_two")
    spec = config.use("gpt-oss-120b", "synthesizer", ["gemini-3.1-flash-lite"])
    c = Client({("openai/gpt-oss-120b", "gsk_one"): Resp(401, {"error": {"message": "bad"}})})
    run(llm.chat(c, spec, SMALL, retries=0))
    snap = health.snapshot()["cooling_down"]
    assert snap["key:groq"] >= 3500 and "key:groq#2" not in snap and "provider:groq" not in snap
    c2 = Client()
    run(llm.chat(c2, spec, SMALL, retries=0))
    assert [k for _, k, _ in c2.calls] == ["gsk_two"]


def test_single_key_behaviour_is_unchanged(monkeypatch):
    groq_keys(monkeypatch, "gsk_only")
    monkeypatch.setenv("GEMINI_API_KEY", "gem_one")
    spec = config.use("gpt-oss-120b", "synthesizer", ["gemini-3.1-flash-lite"])
    c = Client({("openai/gpt-oss-120b", "gsk_only"): Resp(500, {})})
    assert run(llm.chat(c, spec, SMALL, retries=1)) == "ok"
    # one key: a 5xx is still retried once on it, then the next model
    assert [k for _, k, _ in c.calls] == ["gsk_only", "gsk_only", "gem_one"]


def test_each_key_has_its_own_daily_counter(monkeypatch):
    groq_keys(monkeypatch, "gsk_one", "gsk_two")
    spec = config.use("gpt-oss-120b", "synthesizer", ["gemini-3.1-flash-lite"])
    daily = Resp(429, {"error": {"message": "Rate limit reached for tokens per day (TPD)"}})
    c = Client({("openai/gpt-oss-120b", "gsk_one"): daily})
    assert run(llm.chat(c, spec, SMALL, retries=0)) == "ok"
    out = health.snapshot()["out_today"]
    assert "groq:openai/gpt-oss-120b" in out and "groq:openai/gpt-oss-120b#2" not in out
    assert health.snapshot()["requests_today"]["groq:openai/gpt-oss-120b#2"] == 1


def test_usage_file_is_written_atomically(monkeypatch, tmp_path):
    target = tmp_path / "usage.json"
    monkeypatch.setattr(health, "STATE_FILE", str(target))
    groq_keys(monkeypatch, "gsk_one")
    health.note_request(config.REGISTRY["gpt-oss-120b"])
    data = json.loads(target.read_text())
    assert data["req"]["groq:openai/gpt-oss-120b"] == 1
    assert not [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]


def test_parallel_counting_loses_nothing(monkeypatch, tmp_path):
    import threading
    monkeypatch.setattr(health, "STATE_FILE", str(tmp_path / "usage.json"))
    spec = config.REGISTRY["gpt-oss-120b"]

    def worker():
        for _ in range(50):
            health.note_request(spec)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert health.snapshot()["requests_today"]["groq:openai/gpt-oss-120b"] == 400


# ---------------------------------------------------------------- voice + media
class _VResp:
    def __init__(self, status, body=None, text="", content=b""):
        self.status_code, self._body, self.text, self.content = status, body, text, content

    def json(self):
        return self._body


def test_gemini_voice_uses_key_two_when_key_one_is_out_of_quota(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "gem_one")
    monkeypatch.setenv("GEMINI_API_KEY_2", "gem_two")
    monkeypatch.setenv("TTS_DIR", str(tmp_path))
    voice._dead.clear(); voice._rest.clear(); voice._cache.clear()
    used = []
    pcm = base64.b64encode(b"\x01\x00" * 400).decode()

    async def fake_post(self, url, **kw):
        key = kw["headers"]["x-goog-api-key"]
        used.append(key)
        if key == "gem_one":
            return _VResp(429, text="quota")
        return _VResp(200, {"candidates": [{"content": {"parts": [{"inlineData": {
            "mimeType": "audio/L16;rate=24000", "data": pcm}}]}}]})

    monkeypatch.setattr("httpx.AsyncClient.post", fake_post)
    out = run(voice.handle({"text": "Hello there my friend"}))
    assert out["type"] == "audio" and used[:2] == ["gem_one", "gem_two"]


def test_nvidia_media_switches_key_on_429_but_not_on_timeout(monkeypatch, tmp_path):
    monkeypatch.setenv("GENERATED_MEDIA_DIR", str(tmp_path))
    monkeypatch.setenv("NVIDIA_API_KEY", "nv_one")
    monkeypatch.setenv("NVIDIA_API_KEY_2", "nv_two")
    used = []

    async def fake_post(url, body, api_key, timeout, extra_headers=None):
        used.append(api_key)
        if api_key == "nv_one":
            raise nvidia_media.MediaError("quota", status_code=429)
        raise nvidia_media.MediaError("NVIDIA request timeout ho gaya.")

    monkeypatch.setattr(nvidia_media, "_post", fake_post)
    with pytest.raises(nvidia_media.MediaError) as e:
        run(nvidia_media.generate({"kind": "image", "prompt": "a red bicycle on a hill"}))
    assert used == ["nv_one", "nv_two"] and "timeout" in str(e.value)
