# ADARSH Control Center PWA — Current implementation plan

## Current approved direction

Implement the Controller PWA UI only in this directory. The 27 Nov 2026 approved contract explicitly supersedes the earlier plan's “no provider-key entry” constraint: the authenticated owner can now manage provider credentials through a dedicated Keys/settings tab. The UI must be write-only and treat raw keys/setup secrets as sensitive input, never as state metadata. Parent owns the corresponding shared credentials API, Supabase Vault/migrations, controller-admin/controller-device and Android integration, and publication. This PWA task does not change those systems, use MCP, commit, push, deploy, or publish.

Preserve the existing Controller's Supabase Auth boundary, admin API helper, model/config routes, routing/quality/usage views, theme/navigation, and existing News reader/budget panel. New state is loaded from the owner metadata action when available. If the deployed backend predates the new actions, show an unavailable/fail-safe state and leave existing screens usable; do not infer or locally persist credentials. Device privacy consent remains phone-local.

## Scope and UI behavior

- Add an owner-only Keys/settings tab. Manage app Groq, OpenRouter, Gemini, NVIDIA, and Cloudflare with three slots each; the app **Answer / research Tavily** slot 1; and separate **News Groq** and **News Tavily** slots 1–2. App Tavily and News Tavily are independent scopes: saving or deleting one must only affect its own scope, with no shared or automatic fallback. Include a Cloudflare Account ID per Cloudflare slot. Never preload a key, show/reveal it, put it in URL/query, browser persistence/cache, logs, or a response-derived UI field. Inputs are `type=password`; clear key/Account ID fields after save/delete. Only show `key_set`, `account_id_set`, generation, update time, and status metadata. Empty Cloudflare key may accompany Account ID-only update; deletion is a separate action.
- Use the exact owner `credentials_state`, `credentials_set`, `credentials_delete`, and `news_key_reset` actions and contract fields from `/tmp/fix/WORK_2026-11-27.md`. The editable reset is `HH:MM`, defaults to `05:00`, and is fixed to `Asia/Kolkata`; display the timezone and validate locally before sending.
- Move the screenshot-related controls into Controller: briefing enabled, briefing time, news inclusion, Telegram copy; News setup URL/APP_SECRET; Firebase fields `apiKey`, `appId`, `projectId`, `senderId`, with optional parsing of a selected `google-services.json`; Telegram Link/Test/Digest and Push Test use only the protected `news_operation` action. Setup values use write-only inputs and are cleared after save/delete. Keep the News reader, existing News AI budget panel, pairing entry, and app phone permissions/privacy/app-update controls in their existing locations.
- Preserve the current API helper/auth pattern and route names. Metadata and operation errors from an older/unavailable backend are caught and surfaced without disabling other Controller tabs. Do not fall back to direct provider/service calls from the browser.
- Replace misleading “API keys app mein” and “NO PROVIDER KEYS” text with encrypted Vault / owner-managed key hints, without promising backend encryption when an unsupported action is unavailable.

## Existing implementation and fit

- `src/App.tsx` owns authenticated shell, hash tabs, global status/refresh, and dispatches views. Add a Settings tab and mount its owner UI here without changing current route/config editing behavior.
- `src/api.ts` owns Supabase Auth and `controller-admin` request/error handling. Extend the typed action client only as needed; always use `cache: "no-store"` and never include secret values in error messages.
- `src/components/News.tsx` owns the existing News budget/read experience; retain it. Keep new secure News setup and operations in the dedicated settings UI.
- `src/domain.ts`, `src/domain.test.ts`, and existing UI helpers/tests provide project conventions. Put pure validation, slot construction, Google-services parsing, and metadata-only normalization in small source helpers with focused tests.
- `src/style.css` and `src/components/ui.tsx` define the existing ADARSH responsive visual language. Reuse it; this is not a redesign.

## Security and API boundary

- All new mutations use the existing authenticated owner `admin()` helper. Server remains authoritative for owner authorization and secret storage. The UI never writes credentials to local/session storage, IndexedDB, URL/search/hash parameters, service-worker cache, or config drafts.
- `credentials_state` returns metadata only: `{ok:true,slots:[{scope,provider,slot,key_set,account_id_set?,generation,updated_at}],reset_time,timezone,device_settings,setup_status}`. Never assume credential contents can be read.
- `credentials_set` accepts `{action,scope,provider,slot,key,account_id?}` for app/news only; `credentials_delete` is separate. `device_settings_set` is an additive patch. `setup_set`/`setup_delete` manage protected News/Firebase setup; setup inputs are not echoed or put in metadata. `news_operation` supports only `telegram_link`, `telegram_test`, `fcm_test`, and `digest_now`. All requests are authenticated controller-admin operations.
- Optional `google-services.json` parsing is strictly local, parses only Firebase `apiKey`, `appId`, `projectId`, and `messagingSenderId` into the `senderId` field, and does not upload or retain the file. Do not put file contents in logs or errors.
- PWA route manifest remains a single-page `/` route; no new external page routes are introduced.

## Project structure

- `src/App.tsx`: existing shell and tab navigation; add Settings tab and preserve existing views.
- `src/components/KeysSettings.tsx` (or focused component modules): provider-slot key UI, briefing controls, setup fields, and protected News operations.
- `src/credentials.ts`: pure provider-slot definitions, validation, metadata sanitization, reset-time and Firebase JSON parsing helpers.
- `src/credentials.test.ts`: pure field/contract helper tests; do not use real secrets.
- `src/api.ts`: authenticated action transport (no secret-bearing response or diagnostic handling).
- `src/components/News.tsx`: existing News reader and AI budget panel remain in place.
- `src/style.css`: focused responsive styles consistent with current theme.
- `plan.md` and `TODO.md`: current PWA implementation assumptions and outcome progress.

## Visual and interaction system

Reuse the existing ADARSH operations-console look: compact clay-orange identity, technical blue selection, dark/light theme, responsive navigation, and the current concise Roman Hinglish microcopy. Forms remain clearly grouped by scope/provider, visibly distinguish app vs News credentials, show only metadata/status after mutation, and use explicit confirmation for deletion and external operations where the current UI pattern calls for it. Password inputs stay masked; no reveal control. Respect reduced motion and existing focus/contrast conventions.

## Delivery boundary

Modify only Controller PWA source, tests, and relevant documentation in this directory. Run the PWA's `pnpm test`, `pnpm check`, and `pnpm build`. The parent will integrate compatible backend wiring and handle canonical publication. Do not claim deployment or live backend acceptance from UI build checks.
