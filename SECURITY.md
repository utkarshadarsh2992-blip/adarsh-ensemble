# Security policy

ADARSH is a personal project, developed in a public repository.

* **Provider API keys never belong in this repository or the APK.** They are managed through authenticated Controller operations backed by Supabase Vault. For a paired, authorized device, the native app receives only its managed credential bundle and stores applied values in Android encrypted storage; the ordinary WebView does not receive secret values. CI deployment secrets, if used, belong in GitHub Actions secrets.
* **Report a vulnerability privately** through GitHub: Security tab -> "Report a vulnerability" (private vulnerability reporting is enabled). Please do not open a public issue for security problems.
* Supported version: the latest GitHub release.
* Secret scanning and push protection are enabled for this repository.
* Release APKs are signed in CI only; see `docs/SIGNING.md`.
