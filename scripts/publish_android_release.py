#!/usr/bin/env python3
"""Build and validate public Android release metadata without network access.

GitHub CLI remains the only publisher in CI. This module intentionally contains no token,
API-key, or remote-call logic so it is safe to reuse in tests and workflow assets.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

REPOSITORY = "utkarshadarsh2992-blip/adarsh-ensemble"
SCHEMA = 1
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-fA-F]{7,64}$")
FULL_COMMIT_RE = re.compile(r"^[0-9a-fA-F]{40}$")
ASSET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
TAG_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
MAX_APK_BYTES = 150 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024


def _safe_tag(tag: str) -> str:
    if not TAG_RE.fullmatch(tag):
        raise ValueError("invalid release tag")
    return tag


def _safe_asset(name: str) -> str:
    if not ASSET_RE.fullmatch(name):
        raise ValueError("invalid release asset name")
    return name


def github_asset_url(repository: str, tag: str, name: str) -> str:
    """Return the only URL shape accepted by the Android updater."""
    if repository != REPOSITORY:
        raise ValueError("unexpected repository")
    return f"https://github.com/{repository}/releases/download/{_safe_tag(tag)}/{_safe_asset(name)}"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_manifest(
    apk: Path,
    *,
    application_id: str,
    version_code: int,
    version_name: str,
    commit: str,
    tag: str,
    asset_name: str | None = None,
    notes: str = "",
    repository: str = REPOSITORY,
) -> dict[str, Any]:
    """Create the schema consumed by UpdateManager from a local APK fixture."""
    apk = Path(apk)
    if not apk.is_file():
        raise ValueError(f"APK does not exist: {apk}")
    if version_code <= 0 or not version_name.strip():
        raise ValueError("version must be positive and named")
    if not COMMIT_RE.fullmatch(commit):
        raise ValueError("invalid commit")
    name = _safe_asset(asset_name or apk.name)
    size = apk.stat().st_size
    if size <= 0 or size > MAX_APK_BYTES:
        raise ValueError("APK size is outside the allowed range")
    result: dict[str, Any] = {
        "schema": SCHEMA,
        "applicationId": application_id,
        "versionCode": int(version_code),
        "versionName": version_name,
        "apk": {
            "name": name,
            "url": github_asset_url(repository, tag, name),
            "sha256": sha256_file(apk),
            "size": size,
        },
        "commit": commit,
    }
    if notes:
        result["notes"] = notes[:8192]
    validate_manifest(result, repository=repository, tag=tag)
    return result


def validate_manifest(manifest: dict[str, Any], *, repository: str = REPOSITORY, tag: str | None = None) -> None:
    """Validate structure and URL/path safety independently of any installed app."""
    if manifest.get("schema") != SCHEMA:
        raise ValueError("unsupported manifest schema")
    if not isinstance(manifest.get("applicationId"), str) or not manifest["applicationId"]:
        raise ValueError("missing applicationId")
    if not isinstance(manifest.get("versionCode"), int) or isinstance(manifest["versionCode"], bool) or manifest["versionCode"] <= 0:
        raise ValueError("invalid versionCode")
    if not isinstance(manifest.get("versionName"), str) or not manifest["versionName"].strip():
        raise ValueError("invalid versionName")
    if not COMMIT_RE.fullmatch(str(manifest.get("commit", ""))):
        raise ValueError("invalid commit")
    apk = manifest.get("apk")
    if not isinstance(apk, dict):
        raise ValueError("missing apk object")
    name = apk.get("name")
    if not isinstance(name, str):
        raise ValueError("missing APK name")
    _safe_asset(name)
    if not isinstance(apk.get("url"), str):
        raise ValueError("missing APK URL")
    expected_url = github_asset_url(repository, tag, name) if tag is not None else None
    if expected_url is not None and apk["url"] != expected_url:
        raise ValueError("APK URL is not the intended GitHub release path")
    if not isinstance(apk.get("sha256"), str) or not SHA256_RE.fullmatch(apk["sha256"]):
        raise ValueError("invalid APK SHA-256")
    if not isinstance(apk.get("size"), int) or isinstance(apk["size"], bool) or not 0 < apk["size"] <= MAX_APK_BYTES:
        raise ValueError("invalid APK size")
    if "notes" in manifest and not isinstance(manifest["notes"], str):
        raise ValueError("notes must be text")
    encoded = json.dumps(manifest, separators=(",", ":")).encode()
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise ValueError("manifest exceeds 64 KiB")


def verify_release_fixture(
    apk: Path,
    manifest: dict[str, Any],
    *,
    expected_commit: str,
    expected_version_code: int,
    repository: str = REPOSITORY,
    tag: str | None = None,
) -> None:
    """Verify the local assets before gh uploads them."""
    validate_manifest(manifest, repository=repository, tag=tag)
    if manifest["commit"] != expected_commit:
        raise ValueError("manifest commit does not match built SHA")
    if manifest["versionCode"] != expected_version_code:
        raise ValueError("manifest versionCode does not match run number")
    apk = Path(apk)
    entry = manifest["apk"]
    if apk.name != entry["name"]:
        raise ValueError("APK filename does not match manifest")
    if apk.stat().st_size != entry["size"] or sha256_file(apk) != entry["sha256"]:
        raise ValueError("APK digest/size does not match manifest")


def _asset_digest(path: Path) -> str:
    return f"sha256:{sha256_file(path)}"


def verify_existing_release(
    release: dict[str, Any],
    *,
    tag: str,
    expected_commit: str,
    expected_version_code: int,
    apk: Path,
    manifest_file: Path,
    manifest: dict[str, Any],
) -> list[str]:
    """Verify an existing GitHub release and return any missing expected asset names.

    Existing assets are immutable: a matching name with a missing or different API digest is
    rejected rather than overwritten. A draft may therefore be safely resumed only by uploading
    assets that are absent and then undrafting it.
    """
    if release.get("tag_name") != tag:
        raise ValueError("existing release tag does not match immutable identity")
    target = str(release.get("target_commitish", ""))
    if target.lower() != expected_commit.lower():
        raise ValueError("existing release target does not match built SHA")
    verify_release_fixture(
        apk,
        manifest,
        expected_commit=expected_commit,
        expected_version_code=expected_version_code,
        tag=tag,
    )
    manifest_file = Path(manifest_file)
    if not manifest_file.is_file() or manifest_file.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError("local update manifest is missing or too large")
    expected_files = {Path(apk).name: Path(apk), "update.json": manifest_file}
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ValueError("existing release has no asset list")
    by_name = {item.get("name"): item for item in assets if isinstance(item, dict) and isinstance(item.get("name"), str)}
    missing: list[str] = []
    for name, path in expected_files.items():
        existing = by_name.get(name)
        if existing is None:
            missing.append(name)
            continue
        expected_digest = _asset_digest(path)
        if existing.get("digest") != expected_digest:
            raise ValueError(f"existing release asset digest does not match: {name}")
        if existing.get("size") != path.stat().st_size:
            raise ValueError(f"existing release asset size does not match: {name}")
    return missing


def release_decision(
    existing_release: dict[str, Any] | None,
    *,
    tag: str,
    expected_commit: str,
    expected_version_code: int,
    run_number: int,
    latest_version_code: int,
    apk: Path,
    manifest_file: Path,
    manifest: dict[str, Any],
) -> str:
    """Return create, retry_draft, finalize_draft, or skip for a release publication."""
    verify_release_fixture(
        apk,
        manifest,
        expected_commit=expected_commit,
        expected_version_code=expected_version_code,
        tag=tag,
    )
    if existing_release is not None:
        missing = verify_existing_release(
            existing_release,
            tag=tag,
            expected_commit=expected_commit,
            expected_version_code=expected_version_code,
            apk=apk,
            manifest_file=manifest_file,
            manifest=manifest,
        )
        if existing_release.get("draft", False) and run_number < latest_version_code:
            return "skip"
        if not existing_release.get("draft", False):
            if missing:
                raise ValueError("published release is missing an immutable asset")
            return "skip"
        return "retry_draft" if missing else "finalize_draft"
    if run_number <= latest_version_code:
        return "skip"
    return "create"


def publication_allowed(
    event_name: str,
    ref: str,
    built_sha: str,
    current_main_sha: str,
    *,
    run_number: int | None = None,
    latest_version_code: int | None = None,
) -> bool:
    """Only successful main builds at the current main head may publish a new release."""
    allowed_event = event_name in {"push", "workflow_dispatch"}
    if not (
        allowed_event
        and ref == "refs/heads/main"
        and FULL_COMMIT_RE.fullmatch(built_sha or "")
        and FULL_COMMIT_RE.fullmatch(current_main_sha or "")
        and built_sha.lower() == current_main_sha.lower()
    ):
        return False
    if run_number is not None and latest_version_code is not None and run_number <= latest_version_code:
        return False
    return True


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    manifest = sub.add_parser("manifest")
    manifest.add_argument("--apk", type=Path, required=True)
    manifest.add_argument("--application-id", required=True)
    manifest.add_argument("--version-code", type=int, required=True)
    manifest.add_argument("--version-name", required=True)
    manifest.add_argument("--commit", required=True)
    manifest.add_argument("--tag", required=True)
    manifest.add_argument("--asset-name", required=True)
    manifest.add_argument("--notes", default="")
    manifest.add_argument("--output", type=Path, required=True)

    gate = sub.add_parser("gate")
    gate.add_argument("--event", required=True)
    gate.add_argument("--ref", required=True)
    gate.add_argument("--built-sha", required=True)
    gate.add_argument("--head-sha", required=True)
    gate.add_argument("--run-number", type=int)
    gate.add_argument("--latest-version-code", type=int)

    version = sub.add_parser("manifest-version")
    version.add_argument("--manifest", type=Path, required=True)

    decide = sub.add_parser("decide")
    decide.add_argument("--tag", required=True)
    decide.add_argument("--expected-commit", required=True)
    decide.add_argument("--expected-version-code", type=int, required=True)
    decide.add_argument("--run-number", type=int, required=True)
    decide.add_argument("--latest-version-code", type=int, required=True)
    decide.add_argument("--apk", type=Path, required=True)
    decide.add_argument("--manifest", type=Path, required=True)
    decide.add_argument("--existing-release", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "manifest":
            payload = build_manifest(
                args.apk,
                application_id=args.application_id,
                version_code=args.version_code,
                version_name=args.version_name,
                commit=args.commit,
                tag=args.tag,
                asset_name=args.asset_name,
                notes=args.notes,
            )
            encoded = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
            if len(encoded.encode()) > MAX_MANIFEST_BYTES:
                raise ValueError("manifest exceeds 64 KiB")
            args.output.write_text(encoded, encoding="utf-8")
            return 0
        if args.command == "manifest-version":
            manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
            validate_manifest(manifest)
            print(manifest["versionCode"])
            return 0
        if args.command == "gate":
            print(
                "publish"
                if publication_allowed(
                    args.event,
                    args.ref,
                    args.built_sha,
                    args.head_sha,
                    run_number=args.run_number,
                    latest_version_code=args.latest_version_code,
                )
                else "skip"
            )
            return 0
        if args.command == "decide":
            manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
            existing = None
            if args.existing_release and args.existing_release.is_file():
                existing = json.loads(args.existing_release.read_text(encoding="utf-8"))
            print(
                release_decision(
                    existing,
                    tag=args.tag,
                    expected_commit=args.expected_commit,
                    expected_version_code=args.expected_version_code,
                    run_number=args.run_number,
                    latest_version_code=args.latest_version_code,
                    apk=args.apk,
                    manifest_file=args.manifest,
                    manifest=manifest,
                )
            )
            return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"publish_android_release.py: {error}", file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
