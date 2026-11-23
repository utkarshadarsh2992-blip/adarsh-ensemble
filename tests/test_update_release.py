import importlib.util
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPDATER = ROOT / "android/app/src/main/java/app/adarsh/ensemble/UpdateManager.kt"
WORKFLOW = ROOT / ".github/workflows/android-apk.yml"
BUILD = ROOT / "android/app/build.gradle.kts"
PATHS = ROOT / "android/app/src/main/res/xml/update_paths.xml"
SCRIPT = ROOT / "scripts/publish_android_release.py"


def load_release_module():
    spec = importlib.util.spec_from_file_location("publish_android_release", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_manifest_generation_is_deterministic_and_bounded(tmp_path):
    release = load_release_module()
    apk = tmp_path / "adarsh-ensemble-1.0.42.apk"
    apk.write_bytes(b"offline-apk-fixture")
    result = release.build_manifest(
        apk,
        application_id="app.adarsh.ensemble",
        version_code=42,
        version_name="1.0.42",
        commit="a" * 40,
        tag="v1.0.42",
    )
    assert result["schema"] == 1
    assert result["apk"]["name"] == apk.name
    assert result["apk"]["url"] == (
        "https://github.com/utkarshadarsh2992-blip/adarsh-ensemble/"
        "releases/download/v1.0.42/adarsh-ensemble-1.0.42.apk"
    )
    assert result["apk"]["size"] == len(b"offline-apk-fixture")
    release.validate_manifest(result, tag="v1.0.42")
    assert len(json.dumps(result, separators=(",", ":")).encode()) < 64 * 1024


def test_manifest_rejects_arbitrary_release_paths(tmp_path):
    release = load_release_module()
    apk = tmp_path / "app.apk"
    apk.write_bytes(b"apk")
    result = release.build_manifest(
        apk,
        application_id="app.adarsh.ensemble",
        version_code=2,
        version_name="1.0.2",
        commit="b" * 40,
        tag="v1.0.2",
    )
    result["apk"]["url"] = "https://example.invalid/app.apk"
    try:
        release.validate_manifest(result, tag="v1.0.2")
    except ValueError as error:
        assert "GitHub release path" in str(error)
    else:
        raise AssertionError("arbitrary URL was accepted")


def test_publication_gate_requires_current_main_head_and_allowed_event():
    release = load_release_module()
    sha = "c" * 40
    assert release.publication_allowed("push", "refs/heads/main", sha, sha)
    assert release.publication_allowed("workflow_dispatch", "refs/heads/main", sha, sha)
    assert not release.publication_allowed("pull_request", "refs/heads/main", sha, sha)
    assert not release.publication_allowed("push", "refs/heads/android-apk", sha, sha)
    assert not release.publication_allowed("push", "refs/heads/main", sha, "d" * 40)
    assert not release.publication_allowed("push", "refs/heads/main", "not-a-sha", sha)


def test_release_fixture_gate_checks_commit_version_digest_and_size(tmp_path):
    release = load_release_module()
    apk = tmp_path / "release.apk"
    apk.write_bytes(b"verified fixture")
    manifest = release.build_manifest(
        apk,
        application_id="app.adarsh.ensemble",
        version_code=7,
        version_name="1.0.7",
        commit="e" * 40,
        tag="v1.0.7",
    )
    release.verify_release_fixture(
        apk, manifest, expected_commit="e" * 40, expected_version_code=7, tag="v1.0.7"
    )
    manifest["commit"] = "f" * 40
    try:
        release.verify_release_fixture(
            apk, manifest, expected_commit="e" * 40, expected_version_code=7, tag="v1.0.7"
        )
    except ValueError as error:
        assert "commit" in str(error)
    else:
        raise AssertionError("stale commit was accepted")


def test_release_decision_is_idempotent_and_rejects_asset_digest_mismatch(tmp_path):
    release = load_release_module()
    apk = tmp_path / "adarsh-ensemble-1.0.42.apk"
    apk.write_bytes(b"deterministic-apk")
    manifest = release.build_manifest(
        apk,
        application_id="app.adarsh.ensemble",
        version_code=42,
        version_name="1.0.42",
        commit="a" * 40,
        tag="v1.0.42",
    )
    manifest_file = tmp_path / "update.json"
    manifest_file.write_text(json.dumps(manifest), encoding="utf-8")

    def asset(path):
        return {"name": path.name, "size": path.stat().st_size, "digest": "sha256:" + release.sha256_file(path)}

    existing = {
        "tag_name": "v1.0.42",
        "target_commitish": "a" * 40,
        "draft": True,
        "assets": [asset(apk), asset(manifest_file)],
    }
    kwargs = dict(
        tag="v1.0.42",
        expected_commit="a" * 40,
        expected_version_code=42,
        run_number=42,
        latest_version_code=41,
        apk=apk,
        manifest_file=manifest_file,
        manifest=manifest,
    )
    assert release.release_decision(existing, **kwargs) == "finalize_draft"
    existing["draft"] = False
    assert release.release_decision(existing, **kwargs) == "skip"
    existing["assets"][0]["digest"] = "sha256:" + "0" * 64
    try:
        release.release_decision(existing, **kwargs)
    except ValueError as error:
        assert "digest" in str(error)
    else:
        raise AssertionError("an immutable asset digest mismatch was accepted")


def test_release_decision_skips_older_same_head_draft_and_new_run_gate(tmp_path):
    release = load_release_module()
    apk = tmp_path / "release.apk"
    apk.write_bytes(b"fixture")
    manifest = release.build_manifest(
        apk,
        application_id="app.adarsh.ensemble",
        version_code=7,
        version_name="1.0.7",
        commit="b" * 40,
        tag="v1.0.7",
    )
    manifest_file = tmp_path / "update.json"
    manifest_file.write_text(json.dumps(manifest), encoding="utf-8")
    existing = {"tag_name": "v1.0.7", "target_commitish": "b" * 40, "draft": True, "assets": []}
    assert not release.publication_allowed(
        "workflow_dispatch", "refs/heads/main", "b" * 40, "b" * 40, run_number=7, latest_version_code=8
    )
    assert release.release_decision(
        existing,
        tag="v1.0.7",
        expected_commit="b" * 40,
        expected_version_code=7,
        run_number=7,
        latest_version_code=8,
        apk=apk,
        manifest_file=manifest_file,
        manifest=manifest,
    ) == "skip"


def test_updater_has_required_safety_contracts():
    source = UPDATER.read_text(encoding="utf-8")
    for required in (
        "class UpdateManager(ctx: Context, private val emit: (JSONObject) -> Unit)",
        "fun status(): JSONObject",
        "fun check(force: Boolean = false): JSONObject",
        "fun download(): JSONObject",
        "fun install(): JSONObject",
        "fun destroy()",
        "CHECK_INTERVAL_MS",
        "MAX_MANIFEST_BYTES = 64 * 1024",
        "Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES",
        "state != STATE_READY && state != STATE_PERMISSION_REQUIRED",
        "FILE_PROVIDER_AUTHORITY = \"app.adarsh.ensemble.updates\"",
        "PackageManager.GET_SIGNING_CERTIFICATES",
        "PackageManager.GET_SIGNATURES",
        "sha256(part) != cached.sha256",
        "FileProvider.getUriForFile",
        "Intent.ACTION_VIEW",
        "requireExactAssetUrl",
        "CDN_HOSTS",
    ):
        assert required in source
    assert "http://" not in source
    assert "Authorization" not in source
    assert "latest/download" not in source


def test_status_schema_and_state_values_are_explicit():
    source = UPDATER.read_text(encoding="utf-8")
    for field in ("installedVersion", "versionCode", "versionName", "notes", "progress", "message"):
        assert f'put("{field}"' in source
    states = re.findall(r'const val STATE_\w+ = "([a-z_]+)"', source)
    assert set(states) >= {
        "idle",
        "checking",
        "available",
        "current",
        "downloading",
        "ready",
        "permission_required",
        "error",
    }


def test_cache_provider_is_narrow_and_ci_release_is_main_only():
    root = ET.parse(PATHS).getroot()
    cache = next(iter(root))
    assert cache.tag.endswith("cache-path")
    assert cache.attrib[next(k for k in cache.attrib if k.endswith("name"))] == "updates"
    assert cache.attrib[next(k for k in cache.attrib if k.endswith("path"))] == "updates/"

    workflow = WORKFLOW.read_text(encoding="utf-8")
    assert "permissions:\n  contents: read" in workflow
    assert "contents: write" in workflow
    assert "github.event_name != 'pull_request'" in workflow
    assert "github.ref == 'refs/heads/main'" in workflow
    assert "github.event_name == 'push' || github.event_name == 'workflow_dispatch'" in workflow
    assert "gh release create" in workflow and "--draft" in workflow
    assert "gh release edit" in workflow and "--latest=true" in workflow
    assert "releases/latest" in workflow
    assert "manifest-version" in workflow
    assert "FINAL_GATE" in workflow
    assert "gh release upload" in workflow
    assert "GH_TOKEN" in workflow
    assert "secrets." not in workflow


def test_gradle_version_name_tracks_run_number_without_changing_debug_identity():
    build = BUILD.read_text(encoding="utf-8")
    assert 'versionCode = ciRun' in build
    assert 'versionName = "1.0.$ciRun"' in build
    assert 'storePassword = "adarsh123456"' in build
    assert 'keyAlias = "adarsh"' in build
