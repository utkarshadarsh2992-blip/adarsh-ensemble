# Android signing and key rotation

## Current policy (since the audit of 26 Nov 2026)

* Releases are signed **only** with the release key (`adarsh-release`, RSA-4096). The private key lives outside the repository and is read by CI from these repository secrets:
  `ADARSH_RELEASE_KEYSTORE_B64`, `ADARSH_RELEASE_STORE_PASSWORD`, `ADARSH_RELEASE_KEY_ALIAS` (`adarsh-release`), `ADARSH_RELEASE_KEY_PASSWORD`.
* If any of the four secrets is missing, the build **fails**. There is no fallback to another key.
* The old key (`adarsh-debug.keystore`, certificate `2123909d...b068`) was public in this repository for a long time. It is **burnt**: it is no longer in the tree, CI never uses it, and `UpdateManager` does not accept it as the signer of an update. Do not recreate it.
* The release is built with `assembleRelease` (not debuggable), then signed with `apksigner` using APK Signature Scheme **v3 only** plus the public lineage file `android/app/signing/adarsh-release-lineage.bin` (old certificate -> release certificate). minSdk is 28, the first Android version that understands v3.
* CI verifies that the APK is not debuggable, that the signer is the pinned release certificate and that `update.json` records the same certificate before anything is published.

Pinned release certificate SHA-256 (no colons): `600b196ec2224730ea8d24e83e9f9411bd661329569598e07180cd6b596ea5af`

## Why the lineage file is still there

Phones that still carry the old certificate can only upgrade through a v3 lineage. The lineage file is public data (certificates and signatures, no private key). It can be deleted once every device runs a release signed by the new certificate.

## If the release key is ever lost or leaked

1. Generate a new key outside the repository, build a new lineage with `apksigner rotate` (old signer = current release key).
2. Replace the four GitHub secrets, update the pinned certificate in `UpdateManager.kt`, `android-apk.yml` (`EXPECTED_CERT_SHA256`) and this file.
3. Ship the next release signed with the new key plus the new lineage.
