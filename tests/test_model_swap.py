"""Step 3: mistral-large-4 is gone, Kimi / NVIDIA / Cloudflare models take its jobs, and every job's model is one line."""
import config
import mode_plans


def _all():
    return list(config.all_roles()) + [("guard_llm", config.GUARD_LLM)] + list(mode_plans.plan_roles())


def test_mistral_large_is_gone_everywhere():
    assert "mistral-large-4" not in config.REGISTRY
    for name, spec in _all():
        assert all("mistral-large" not in c.model for c in config.chain_of(spec)), name


def test_swap_points_drive_the_chains():
    assert config.MASTER_WRITER.label == config.WRITER == "kimi-k3.1-pro"
    assert config.PANEL[-1].label == config.PATTERN and config.REGISTRY[config.PATTERN].provider == "cloudflare"
    assert mode_plans.get("business").spec("specialist").label == config.WRITER
    assert mode_plans.get("coding").spec("specialist").label == config.CODER
    for name in (config.WRITER, config.PATTERN, config.HEAVY_FALLBACK, config.CODER):
        assert name in config.REGISTRY


def test_nvidia_ids_are_the_verified_ones_and_cloudflare_is_used():
    assert config.REGISTRY["glm-5.3-flash"].model == "z-ai/glm-5.3-flash"
    assert config.REGISTRY["kimi-k3.1-pro"].model == "moonshotai/kimi-k3.1-pro"
    assert config.REGISTRY["nv-nemotron-ultra"].model == "nvidia/nemotron-3-ultra-550b-a55b"
    used = {c.provider for _, s in _all() for c in config.chain_of(s)}
    assert {"cloudflare", "nvidia"} <= used
    assert config.PLAN_PROBLEMS == [] and mode_plans.PLAN_PROBLEMS == []
