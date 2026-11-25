import asyncio
import json
import os
import hashlib
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")

import chat_adapter  # noqa: E402
import config  # noqa: E402
import controller_config as controller  # noqa: E402
import mode_plans  # noqa: E402
import standard_agent  # noqa: E402

BUNDLED_MODELS = [
    {"label": spec.label, "provider": spec.provider, "model": spec.model, "enabled": True, "extra": dict(spec.extra)}
    for spec in config.REGISTRY.values()
]


@pytest.fixture(autouse=True)
def restore_runtime():
    controller.restore_bundled_for_test()
    yield
    controller.restore_bundled_for_test()


def document(**changes):
    doc = {
        "schema_version": 1,
        "providers": {},
        "models": [dict(row, extra=dict(row["extra"])) for row in BUNDLED_MODELS],
        "routes": {},
        "quality": {},
        "limits": {},
    }
    doc.update(changes)
    return doc


def test_wire_schema_accepts_only_supported_data_and_whitelisted_extras():
    doc = document(models=[{
        "label": "groq-new-compatible", "provider": "groq", "model": "org/model-v2",
        "enabled": True, "extra": {"reasoning_effort": "medium", "reasoning_format": "hidden"},
    }])
    checked = controller.validate_document(doc)
    assert checked["models"][0]["model"] == "org/model-v2"
    for extra in ({"api_key": "not-allowed"}, {"tools": []}, {"reasoning_effort": "turbo"}):
        bad = document(models=[{"label": "bad", "provider": "groq", "model": "x", "enabled": True, "extra": extra}])
        with pytest.raises(controller.ControllerConfigError):
            controller.validate_document(bad)
    with pytest.raises(controller.ControllerConfigError):
        controller.validate_document({**doc, "python": "print(1)"})


def test_endpoint_host_and_url_components_are_fixed():
    good = document(providers={"groq": {"base_url": "https://api.groq.com/openai/v1"}})
    assert controller.validate_document(good)["providers"]["groq"]["base_url"].endswith("/openai/v1")
    bad_urls = [
        "http://api.groq.com/openai/v1",
        "https://evil.example/openai/v1",
        "https://user@api.groq.com/openai/v1",
        "https://api.groq.com:443/openai/v1",
        "https://api.groq.com/openai/v1?key=secret",
        "https://api.groq.com/openai/../v1",
        "https://api.groq.com/openai/v1/chat/completions",
    ]
    for url in bad_urls:
        with pytest.raises(controller.ControllerConfigError):
            controller.validate_document(document(providers={"groq": {"base_url": url}}))
    with pytest.raises(controller.ControllerConfigError):
        controller.validate_document(document(providers={"cloudflare": {"base_url": "https://api.cloudflare.com/client/v4/accounts/123/ai/v1"}}))


def test_invalid_schema_limits_models_routes_and_provider_are_rejected():
    samples = [
        document(schema_version=2),
        document(models=[{"label": "x", "provider": "other", "model": "m", "enabled": True}]),
        document(models=[{"label": "x", "provider": "groq", "model": "a b", "enabled": True}]),
        document(models=[{"label": "x", "provider": "groq", "model": "m", "enabled": 1}]),
        document(routes={"not-a-route": ["gpt-oss-120b"]}),
        document(routes={"standard:single": []}),  # deliberately unsupported synthetic route
        document(limits={"groq": {"daily_requests": -1}}),
    ]
    for sample in samples:
        with pytest.raises(controller.ControllerConfigError):
            controller.validate_document(sample)
    too_many = document(models=[{"label": f"m{i}", "provider": "groq", "model": "x", "enabled": True} for i in range(101)])
    with pytest.raises(controller.ControllerConfigError):
        controller.validate_document(too_many)


def test_missing_and_invalid_files_keep_bundled_defaults(tmp_path):
    assert not config.CONTROLLER_CONFIG_ACTIVE
    result = controller.apply_files(str(tmp_path / "missing.json"), str(tmp_path / "pending.json"))
    assert result["source"] == "bundled"
    assert not config.CONTROLLER_CONFIG_ACTIVE
    (tmp_path / "invalid.json").write_text('{"schema_version":1,"python":"x"}', encoding="utf-8")
    result = controller.apply_files(str(tmp_path / "invalid.json"), None)
    assert result["source"] == "bundled"
    assert config.PLAN_PROBLEMS == [] and mode_plans.PLAN_PROBLEMS == []


def test_pending_valid_config_is_promoted_as_last_known_good_atomically(tmp_path):
    cache = tmp_path / "config.json"
    pending = tmp_path / "incoming.json"
    pending.write_text(json.dumps(document(quality={"research": False})), encoding="utf-8")
    expected_digest = hashlib.sha256(pending.read_bytes()).hexdigest()
    result = controller.apply_files(str(cache), str(pending))
    assert result == {"ok": True, "source": "remote", "active": True, "cached": True, "config_digest": expected_digest}
    assert cache.is_file() and not pending.exists()
    assert json.loads(cache.read_text(encoding="utf-8"))["quality"] == {"research": False}
    assert config.RESEARCH_ENABLED is False
    controller.restore_bundled_for_test()
    result = controller.apply_files(str(cache), None)
    assert result["source"] == "cache" and config.RESEARCH_ENABLED is False
    assert result["config_digest"] == expected_digest


def test_invalid_incoming_route_falls_back_to_cached_last_good(tmp_path):
    cache = tmp_path / "good.json"
    pending = tmp_path / "bad.json"
    good = document(quality={"audit": False})
    cache.write_text(json.dumps(good), encoding="utf-8")
    # The Standard route references this label, so disabling it must reject the incoming document.
    bad_models = [dict(row, extra=dict(row["extra"])) for row in BUNDLED_MODELS]
    next(row for row in bad_models if row["label"] == "gpt-oss-120b")["enabled"] = False
    bad = document(models=bad_models,
                   routes={"utility:quick": ["gpt-oss-120b"]}, quality={"research": False})
    pending.write_text(json.dumps(bad), encoding="utf-8")
    result = controller.apply_files(str(cache), str(pending))
    assert result["source"] == "cache"
    assert config.REMOTE_QUALITY == {"audit": False}
    assert config.STANDARD_CHAIN_LABELS == ("gpt-oss-120b",)
    assert config.PLAN_PROBLEMS == [] and mode_plans.PLAN_PROBLEMS == []


def test_remote_route_and_quality_overrides_win_but_missing_fields_keep_phone_values():
    doc = document(
        routes={
            "utility:quick": ["gpt-oss-20b", "gemini-3.1-flash-lite", "nemotron-lightning", "gpt-oss-120b"],
            "mode:standard:architect": ["gemini-3.1-flash-lite", "gpt-oss-20b", "nemotron-lightning"],
        },
        quality={"truthLevel": "strict", "factCheck": "always", "builtInWebSearch": False,
                 "audit": False, "ground": True, "research": False, "review": False, "debate": False},
    )
    _apply(doc)
    assert config.STANDARD_CHAIN_LABELS == ("gpt-oss-20b", "gpt-oss-120b")
    assert mode_plans.get("standard").spec("architect").label == "gemini-3.1-flash-lite"
    assert config.AUDIT_ENABLED is False and config.GROUND_ENABLED is True
    assert config.RESEARCH_ENABLED is False and config.REVIEW_ENABLED is False and config.DEBATE_ENABLED is False
    stale = {"truth": {"level": "creative", "check": "off"}, "reply": {"web": "on"}}
    assert chat_adapter._effective_truth_options(stale) == {"level": "strict", "check": "always"}
    assert chat_adapter._effective_web_search(stale) is False

    # An omitted controller field deliberately leaves the old device value as the fallback.
    _apply(document(quality={"audit": False}))
    assert chat_adapter._effective_truth_options(stale) == {"level": "creative", "check": "off"}
    assert chat_adapter._effective_web_search(stale) is True


def test_disabled_default_models_are_filtered_only_when_invariants_survive(tmp_path):
    pending = tmp_path / "config.json"
    models = [dict(row, extra=dict(row["extra"])) for row in BUNDLED_MODELS]
    next(row for row in models if row["label"] == "gpt-oss-120b")["enabled"] = False
    doc = document(models=models)
    pending.write_text(json.dumps(doc), encoding="utf-8")
    result = controller.apply_files(str(tmp_path / "cache.json"), str(pending))
    # The default Standard-only chain would be empty, so no broken runtime config is promoted.
    assert result["source"] == "bundled"
    assert config.STANDARD_CHAIN_LABELS == ("gpt-oss-120b",)
    assert config.PLAN_PROBLEMS == [] and mode_plans.PLAN_PROBLEMS == []


def test_replaced_then_deleted_model_is_not_union_restored(tmp_path):
    models = [dict(row, extra=dict(row["extra"])) for row in BUNDLED_MODELS if row["label"] != "safeguard-20b"]
    doc = document(models=models, routes={
        "utility:classifier": ["gemini-3.1-flash-lite", "gpt-oss-20b", "nemotron-lightning"]
    })
    path = tmp_path / "deleted.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    result = controller.apply_files(str(path))
    assert result["active"]
    assert "safeguard-20b" not in config.REGISTRY
    assert config.CLASSIFIER.label == "gemini-3.1-flash-lite"
    assert config.PLAN_PROBLEMS == [] and mode_plans.PLAN_PROBLEMS == []


def test_standard_agent_uses_only_the_configured_groq_chain_without_model_calls(monkeypatch):
    config.STANDARD_CHAIN_LABELS = ("groq-primary", "groq-backup")
    calls = []

    async def fake_one(messages, *, model_label, **kwargs):
        calls.append(model_label)
        if model_label == "groq-primary":
            raise standard_agent.StandardError("failed")
        return {"used": model_label}

    monkeypatch.setattr(standard_agent, "_answer_one", fake_one)
    result = asyncio.run(standard_agent.answer([]))
    assert result["used"] == "groq-backup"
    assert calls == ["groq-primary", "groq-backup"]


def _apply(doc):
    import tempfile

    with tempfile.TemporaryDirectory() as folder:
        path = os.path.join(folder, "cfg.json")
        with open(path, "w", encoding="utf-8") as stream:
            json.dump(doc, stream)
        result = controller.apply_files(path)
        assert result["active"]
