"""Source-contract regressions; Android instrumentation still needs a real SDK/device."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "android/app/src/main/java/app/adarsh/ensemble"
MIGRATION = ROOT / "supabase/migrations/20261127204000_controller_device_managed_inventory.sql"


def test_device_inventory_is_explicitly_managed_and_never_news_provider_scope():
    sql = MIGRATION.read_text()
    assert "c.scope = 'app'" in sql and "s.scope = 'setup'" in sql
    assert "c.scope = 'news'" not in sql and "s.scope = 'news'" not in sql
    assert "join public.controller_credential_slots c" in sql
    assert "left join public.controller_credential_slots c" not in sql
    assert "join public.controller_credential_slots s" in sql
    assert "left join public.controller_credential_slots s" not in sql
    assert "union all select 'tavily', 1" in sql
    assert "p_device_token_hash is null" in sql
    # Slot rows survive deletion; managed names exist even when their value does not.
    assert sql.index("v_managed :=") < sql.index("if v_row.key_set")
    assert "v_setup_managed := v_setup_managed || jsonb_build_array(v_row.provider)" in sql


def test_device_credential_rpc_is_service_only_and_has_safe_search_path():
    sql = MIGRATION.read_text()
    assert "security definer" in sql
    assert "set search_path = pg_catalog, public, vault, pg_temp" in sql
    assert "from public, anon, authenticated, service_role" in sql
    assert "grant execute on function public.controller_credentials_for_device(text) to service_role" in sql
    assert not re.search(r"grant\s+execute.*to\s+(anon|authenticated|public)\b", sql, re.I)


def test_native_applies_only_managed_setup_and_honors_explicit_tombstones():
    engine = (NATIVE / "Engine.kt").read_text()
    assert "import org.json.JSONObject" in engine
    assert 'if (managedSetup.contains("news")) {' in engine
    assert 'if (managedSetup.contains("firebase")) {' in engine
    assert 'setup.optJSONObject("news") ?: JSONObject().put("url", "").put("secret", "")' in engine
    assert 'setup.optJSONObject("firebase") ?: JSONObject()' in engine
    assert "if (name !in SecureKeys.NAMES) continue" in engine
    assert "if (!secureKeys.remove(name)) return" in engine
    assert "if (!secureKeys.put(name, next)) return" in engine


def test_authenticated_equal_revision_restores_local_keys_without_exposing_values():
    link = (NATIVE / "ControllerLink.kt").read_text()
    assert 'revision >= meta.getLong("credential_revision", 0L)' in link
    status = link.split("fun status(): String", 1)[1].split("/** Startup", 1)[0]
    assert 'put("credentials_revision"' in status
    for forbidden in ('put("credentials",', 'put("values",', 'put("setup",', 'put("device_token",'):
        assert forbidden not in status
    bridge = (NATIVE / "AdarshBridge.kt").read_text()
    for method in ("keySet", "keyClear", "keyStatus", "newsSet", "fcmSet"):
        assert f"fun {method}" not in bridge
