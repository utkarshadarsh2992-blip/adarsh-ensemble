# Android signing and key rotation

The repository contains the legacy `android/app/adarsh-debug.keystore` only because existing debug and Android 8.x installs still need the old signer during migration. It is not a secret: its password and private key were public before this rotation. Do not use it as the long-term release trust root.

The prepared release key is an RSA-4096 keystore kept outside the repository. GitHub Actions reads it only from these repository secrets:

- `ADARSH_RELEASE_KEYSTORE_B64`
- `ADARSH_RELEASE_STORE_PASSWORD`
- `ADARSH_RELEASE_KEY_ALIAS` (`adarsh-release`)
- `ADARSH_RELEASE_KEY_PASSWORD`

The user handoff with the exact values and phone-friendly GitHub instructions is at `/home/ubuntu/audit/signing/SECRETS_FOR_USER.md` in the preparation environment. The private JKS and passwords must never be committed. The public-only signing lineage is committed at `android/app/signing/adarsh-release-lineage.bin`.

## Rotation behavior

The lineage connects the legacy certificate to the new certificate. CI builds the APK with the legacy key, then—when all four secrets are present—re-signs it with `apksigner` using the legacy signer for v1/v2 continuity and the new signer for APK Signature Scheme v3 from API 28 onward. CI verifies that the active v3 certificate is the pinned new certificate before creating release metadata. If secrets are absent, CI keeps the existing legacy-signed behavior and emits a warning so ordinary builds remain green.

Android 8.x (API 26–27) does not understand v3 certificate rotation. Those devices continue to require the legacy signer and therefore receive the old-key continuity signature. Android 9+ understands the lineage and can migrate to the new signer. Once an installed app has the new current signer, `UpdateManager` rejects an APK whose current signer is only the old certificate, while still requiring the installed signer to occur in the APK signing history.

Pinned certificate SHA-256 values, without colons, are:

- Legacy: `2123909dc50f1ea3b8c6807192c44dde19249fc5d9d0e76ca164cefde844b068`
- New: `600b196ec2224730ea8d24e83e9f9411bd661329569598e07180cd6b596ea5af`

The publisher records the active APK certificate in `update.json` as `certificateSha256` and compares it with the APK’s package name, version code, version name, and `apksigner` output before publishing.
