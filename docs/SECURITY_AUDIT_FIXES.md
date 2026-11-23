# Security audit fixes (audit of commit 414076e, fixed on branch `new`)

Status of every finding of `ADARSH_Audit_Report.pdf`. "Fixed" means code + a regression test where one is possible.

| ID | Finding | Status | What changed |
|---|---|---|---|
| C1 | Proof "sandbox" reaches host files and network | Fixed (off by default) | `sandbox.py`: code proofs only run when `CODE_PROOFS=1`; numpy/scipy/sympy/pint imports removed from the proof allowlist. Tests: `tests/test_security_backend.py`. |
| H1 | Release signing key + password in the public repo | Fixed in code; **needs 4 GitHub secrets from the owner** | New RSA-4096 release key kept outside the repo; v3 signing-key rotation with a public lineage file `android/app/signing/adarsh-release-lineage.bin`; CI re-signs with the new key when the secrets exist (otherwise it warns and keeps the legacy key so updates keep working); `UpdateManager.kt` accepts the legacy and the rotated certificate. See `docs/SIGNING.md`. |
| H2 | Server auth fail-open | Fixed | `main.py` fails closed (401) without `APP_API_KEY` unless `ALLOW_ANONYMOUS=1` is set; constant-time compare; `/docs` off unless `ENABLE_DOCS=1`. |
| H3 | No body-size / concurrency limit on `/api/chat` | Fixed | Streaming 16 MiB body cap before JSON parsing, request semaphore, bounded history / attachments / meta in `chat_adapter`. |
| H4 | `javascript:` URLs in research / council links (XSS) | Fixed | `safeExternalUrl()` (https only) used by the renderer and the council page. `ui/tests/security.test.cjs`. |
| H5 | Call / message confirmation was only a JS Boolean | Fixed | `MainActivity.runActions`: `call.dial` / `message.draft` run only after a **native AlertDialog** that shows the exact number / text of the same parsed step object that is executed; the page's `confirmed` flag alone no longer runs anything. 60 s timeout = cancel. |
| H6 | Mutable action tags, write-scoped publish job | Fixed | All actions pinned by commit SHA, least-privilege `permissions`, `environment: release`, publish concurrency, `.github/dependabot.yml`. `tests/test_ci_security.py`. |
| H7 | Unpinned build inputs, native AAR without hash | Fixed | Pinned Chaquopy pip requirements, sherpa-onnx AAR SHA-256 verified before use. |
| H8 | Quota counters not thread-safe, non-atomic `.usage.json` | Fixed | `health._usage_lock` (RLock) around every usage mutation; save via temp file + `os.replace`. |
| H9 | Time parsing wrong at night / 12 AM / Devanagari units | Fixed | `actions/timeparse.py` rewritten; `tests/test_timeparse.py`. |
| M1 | `AdarshNative` bridge visible to every frame / origin | Fixed (mitigation) | Every bridge method checks `MainActivity.pageTrusted()` (top document must be `https://appassets.androidplatform.net`, tracked in `shouldInterceptRequest` / `onPageStarted`); the page sets CSP `frame-src 'none'; object-src 'none'; base-uri 'none'`, so no frame can load; non-app URLs never load in the WebView. `addWebMessageListener` migration was not needed for this. |
| M2 | Neural voice pack unpinned, zip path issues | Fixed | `NeuralTTS.kt`: SHA-256 pin, canonical-path checks, temp-dir extraction with rollback. |
| M3 | Loose citation regex | Fixed | `verified.SOURCE_CITATION_RE` strict `[S<n>]` grammar used everywhere. |
| M4 | `.lessons.json` fields not coerced | Fixed | Safe coercion; bad rows dropped. |
| M5 | User lessons injected into the prompt as instructions | Fixed | Lessons go into a `<lessons>` data block marked as data. |
| M6 | v6 speech queue race | Fixed | Atomic queue snapshot under the lock in `voice_router`. |
| M7 | API key compare not constant-time | Fixed | `secrets.compare_digest`. |
| M8 | Backup import unbounded / unvalidated | Fixed | 8 MB file cap, version check, typed and capped lists (chats 500, memories 2000, missions 500), filtered objects (`04-views.js`, `04-productivity.js`). |
| M9 | Backend reply / council record unbounded | Fixed | 256 KiB per reply, 512 KiB per council record, visibly marked when cut. |
| M10 | Browser mode allows HTTP backends / token over HTTP | Fixed | HTTPS only (HTTP only for localhost, and never with a bearer token). |
| M11 | Publisher did not verify the APK | Fixed | `scripts/publish_android_release.py` checks package / version with aapt2 and the signature with apksigner. |
| M12 | Old "main is still..." publish path | Fixed | Protected `release` environment + concurrency on the publish job. |
| L1 | Default `CORS_ORIGINS=*` | Fixed | No wildcard default; explicit allowlist. |
| L2 | Provider error text / exception types leaked | Fixed | Generic server errors with a correlation id; Android engine errors capped at 300 chars. |
| L3 | v6 `response_id` used in a filename unchecked | Fixed | UUID ids only + index check. |
| L4 | `BootReceiver` exported | Fixed | `exported="false"`; `ActionReceiver` validates URI / action. |
| L5 | `SecureKeys` wiped all keys on any error | Fixed | 3 retries with back-off before a reset; the reset is reported once in the API keys sheet. |
| L6 | 4-digit PIN, fail counter only in memory | Partly fixed | Lockout counter persisted (`adarsh.lockout.v1`). PIN length unchanged (changing it would lock existing users out). |
| L7 | No CSP, Google Fonts at runtime | Partly fixed | CSP meta with `frame-src 'none'; object-src 'none'; base-uri 'none'`. A full `script-src` CSP needs hashes for the inline bundle and self-hosted fonts: left for a later change. |
| L8 | Repo hygiene (duplicate root `test_ratelimit.py`) | Fixed | Duplicate removed. |
| I1 | Daily-cap rollover at UTC (05:30 IST) | Documented only | Providers reset on UTC as well, so the counters stay aligned. |

Not done in this round: Gradle dependency verification metadata (`gradle/verification-metadata.xml`).
