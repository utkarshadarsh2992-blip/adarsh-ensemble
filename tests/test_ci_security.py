import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/android-apk.yml"
BUILD = ROOT / "android/app/build.gradle.kts"
UPDATER = ROOT / "android/app/src/main/java/app/adarsh/ensemble/UpdateManager.kt"
PUBLISHER = ROOT / "scripts/publish_android_release.py"


def test_workflow_actions_are_full_sha_pinned_and_release_is_serialized():
    source = WORKFLOW.read_text(encoding="utf-8")
    action_refs = re.findall(r"uses:\s+([^\s]+)", source)
    assert action_refs
    assert all(re.fullmatch(r"[^@]+@[0-9a-f]{40}", ref) for ref in action_refs)
    assert "environment: release" in source
    assert "group: android-release-publish" in source
    assert "cancel-in-progress: false" in source
    assert "actions/dependabot" not in source


def test_rotation_and_hash_pins_are_present():
    build = BUILD.read_text(encoding="utf-8")
    workflow = WORKFLOW.read_text(encoding="utf-8")
    updater = UPDATER.read_text(encoding="utf-8")
    assert 'httpx==0.28.1' in build
    assert 'python-dotenv==1.2.4' in build
    assert 'f6c225258b8528ab7537ff92fbb452df4c68d31632c19f45c8ddb9b56eea238d' in build
    assert 'adarsh-release-lineage.bin' in workflow
    assert 'rotation-min-sdk-version 28' in workflow
    assert 'ADARSH_RELEASE_KEYSTORE_B64' in workflow
    assert 'NEW_CERTIFICATE_SHA256' in updater
    assert 'signingCertificateHistory' in updater
    assert 'certificateSha256' in PUBLISHER.read_text(encoding="utf-8")


def test_private_signing_material_is_ignored_but_lineage_is_trackable():
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "android/app/signing/*.jks" in ignore
    assert "android/app/signing/*.b64" in ignore
    assert (ROOT / "android/app/signing/adarsh-release-lineage.bin").is_file()
