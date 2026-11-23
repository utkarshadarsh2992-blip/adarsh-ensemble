from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "android/app/src/main/java/app/adarsh/ensemble"


def source(name: str) -> str:
    return (NATIVE / name).read_text(encoding="utf-8")


def test_unified_records_bridge_and_standard_mode_contract():
    activity = source("MainActivity.kt")
    bridge = source("AdarshBridge.kt")
    assert 'mode != "standard"' in activity
    assert "fun recordsList()" in activity and 'put("records", arr)' in activity
    assert "fun recordsImport(json: String)" in activity
    assert "fun recordsDelete(id: String)" in activity
    for method in ("recordsList", "recordsImport", "recordsDelete"):
        assert f"fun {method}" in bridge


def test_native_store_is_process_locked_and_atomic():
    store = source("ActionStore.kt")
    assert "private val PROCESS_LOCK = Any()" in store
    assert "synchronized(PROCESS_LOCK)" in store
    assert "StandardCopyOption.ATOMIC_MOVE" in store
    assert "Native records are corrupted; no changes made" in store
    assert '"firedAt"' in store and "markFired" in store


def test_import_whitelist_and_native_safety_guards():
    store = source("ActionStore.kt")
    runner = source("ActionRunner.kt")
    assert 'normalizeAndValidate(raw, allowLegacy = false' in store
    assert 'action == "note.clear"' in runner
    assert 'action == "dnd.set"' in runner and 'action == "panel.open"' in runner
    assert 'equals("settings", true)' in runner
    assert 'action.contains("delete"' in runner and 'action.contains("clear"' in runner
    assert 'action == "message.draft" || action == "call.dial"' in runner
    # Risk metadata from JavaScript must not be trusted by the executor.
    assert 'step.optString("risk"' not in runner


def test_firing_receiver_keeps_record_and_uses_persisted_fields():
    receiver = source("ActionReceiver.kt")
    assert "ActionStore(ctx).transaction" in receiver
    assert 'record.optBoolean("done", false)' in receiver
    assert 'record.has("firedAt")' in receiver
    assert 'record.optLong("at") > now + 1000L' in receiver
    assert 'record.put("firedAt", now)' in receiver
    assert "ActionStore(ctx).remove(id)" not in receiver
    assert "record.optString(\"kind\"" in receiver


def test_productivity_contract_validates_native_inputs_and_dates():
    runner = source("ActionRunner.kt")
    store = source("ActionStore.kt")
    assert 'presentString(a, "category")' in runner
    assert 'presentString(a, "goal")' in runner
    assert 'presentString(a, "outcome")' in runner
    assert 'seconds !in 1.0..86400.0' in runner
    assert 'minutes > 1440L' in runner
    assert "LocalDate.parse(value)" in runner and "Instant.parse(value)" in runner
    assert "ZoneId.systemDefault()" in runner
    assert "normalizeActivityDate(date" in store
    assert "m > 1440" in store


def test_native_matching_and_editing_preserve_js_semantics():
    runner = source("ActionRunner.kt")
    store = source("ActionStore.kt")
    assert "val exact = candidates.filter" in runner
    assert "if (exact.size == 1) return exact.single().index" in runner
    assert "val timeChanged = a.has(\"at\")" in runner
    assert "if (timeChanged) record.remove(\"firedAt\")" in runner
    assert "if (kind == \"task\" || kind == \"work\") o.remove(\"text\")" in store


def test_legacy_note_delete_serializes_inside_string_main_thread_bridge():
    activity = source("MainActivity.kt")
    body = activity.split("fun deleteNote(id: String): String = onMain {", 1)[1].split("fun actionInfo()", 1)[0]
    assert "val result = if" in body
    assert "result.toString()" in body
    assert "}.toString()" not in body
