# ADARSH Control Center — Plan

## User-approved direction

ADARSH ke liye ek alag, admin-only PWA control center banega. Usme techy, smooth, mobile-first aur clearly structured UI hogi. Controller existing app ke supported model providers, model IDs/endpoints, routing/fallbacks, AI-quality controls aur usage ko manage karega. Controller se supported model configuration badalne par har baar APK rebuild nahi chahiye; naye API format ya native app code ke liye app update ab bhi zaroori hoga.

Jo setting PWA manage karegi, uska duplicate edit control ADARSH Settings se hataya jayega. Phone-specific settings aur API keys jahan hain wahan rahenge; existing local values, chats, usage files, News rows aur FCM devices delete/reset nahi honge.

## Inspected existing implementation

- `config.py` provider endpoints aur model registry define karta hai; `mode_plans.py` six chat-mode role chains import time par banata hai. Runtime config ko Python modules load hone se pehle apply karna hoga.
- Android Python bootstrap `android_entry.py` mein hai; `Engine.kt` Chaquopy start karta hai. Provider keys `SecureKeys.kt` ke encrypted storage mein hain; controller un keys ko read, copy ya replace nahi karega.
- ADARSH Settings mein duplicate hone wale current controls `ui/src/js/04-views.js` aur `ui/src/js/04-usage.js` mein hain: API Usage view, hallucination/fact-check controls, aur Built-in web search switch. Unke stored values/phone par maujood usage history preserve rahenge; sirf duplicate editing/navigation PWA mein move hogi.
- Supabase project `yepupldfjtikalfzehvl` healthy hai. Existing `public.ai_usage` News scoring ka counter hai, ADARSH phone AI usage ka nahi; isliye is table ko reuse/modify nahi karna. Current public tables par RLS enabled hai aur `anon`/`authenticated` ko table access nahi mila.
- Deployed functions abhi News-only hain; `APP_SECRET` News API credential hai, controller-admin login nahi. Controller ke liye alag Auth/admin boundary hogi.
- Supabase migration history mein abhi `20261125132821_news_service_role_acl_and_cron_timeouts` hi recorded hai. Existing data aur current News functions ko untouched rakhna hai; nayi schema sirf additive hogi.

## Scope and behavior

### PWA control center

- **Overview:** selected model/config revision, app-reported usage today, recent-day totals, sync/device status, aur limits ke saath remaining amount.
- **Models:** current providers (Groq, OpenRouter, Gemini, Cloudflare, NVIDIA) ke andar model label/ID aur compatible HTTPS endpoint add, edit, enable/disable; supported mode/role primary aur fallback order choose. Existing model definitions ke defaults remain karenge jab tak admin remote override save na kare.
- **Quality:** existing `truthLevel` (strict/balanced/creative), Standard fact-check mode, Built-in web search, aur supported research/audit/grounding controls. UI inhe hallucination kam karne wale safeguards bolegi—accuracy guarantee nahi.
- **Usage:** app-local counters se provider/model/key-slot (slot number only) ke calls/tokens, feature use aur recent-day totals. Provider ka official quota/balance API available ho to actual label; warna configured cap ke against remaining ko estimated label kare.
- **Devices and changes:** paired app devices, revoke action, versioned change history aur last-known-good config par rollback. Rollback sirf controller config par hoga, user content/data par nahi.

### ADARSH app integration

- Android secure pairing token aur remote config use karega. Token encrypted Android storage mein; remote document mein API keys, prompts, chats, private user records ya executable Python nahi.
- App startup par bounded HTTPS fetch; strict schema/provider/model/role validation; config cache alag file mein atomic write; offline, timeout ya invalid config par bundled model plans aur last-known-good config fallback.
- Supported compatible model definitions/endpoints aur quality settings dynamic apply honge. Arbitrary code deployment, arbitrary provider keys, unsupported audio/image/video formats remote config se enable nahi honge.
- App ke counters ko prompt-free daily snapshots ke roop mein sync kiya jayega. Retry duplicate totals nahi banayega. Existing local `usage.json` aur counters remain intact.
- PWA-managed controls ke duplicate editors/navigations ADARSH Settings se remove honge; connection/pairing aur phone-specific controls rahenge. Existing locally saved values first remote override se pehle fallback ke roop mein preserve honge.

## Security and data boundaries

- PWA login Supabase Auth se; admin actions ke liye server-side verified user token + `controller_admins` allowlist. Client role/email ko bina server check ke trust nahi karna.
- Browser mein sirf Supabase URL/publishable key; `service_role`, provider API keys, APP_SECRET aur pairing-token hashes browser/API responses/logs mein nahi.
- Admin Edge Function hi privileged DB operations kare. Mobile app ke public device endpoint par pair-code exchange/device-token authentication; raw token sirf pairing response par, DB mein hash.
- Endpoint defaults provider host allowlist ke andar. Endpoint badalne par UI exact host dikhaye; HTTP, localhost/private address, credentials-in-URL aur unsafe host reject. Existing provider key us endpoint ko bhejne se pehle clear confirmation.
- Nayi tables: admin allowlist, versioned model config, paired devices/pair codes, aggregate usage snapshots, audit history. RLS enabled; anon/authenticated table grants nahi; writes Edge Functions ke through.
- `public.news_items`, `feeds`, `settings`, News `ai_usage`, `kv`, cron jobs, Vault secrets, FCM registration aur existing rows ko controller migration touch nahi karegi.

## Project structure

- `controller/plan.md` and `controller/TODO.md`: project plan/progress.
- `controller/` PWA: separate static, application-owned PWA manifest and service worker; tab/page modules for overview, models, quality, usage, devices, and auth.
- `supabase/migrations/`: additive controller-only schema, with RLS and service-role-only table access.
- `supabase/functions/controller-admin/`: verified Supabase Auth + admin allowlist; config CRUD, usage reads, audit, pairing-code creation, rollback.
- `supabase/functions/controller-device/`: public config fetch, one-time device pairing and authenticated usage snapshot ingestion; no privileged table access outside server-side service client.
- `android/app/src/main/java/app/adarsh/ensemble/`: pairing/token storage and bounded HTTPS bridge.
- `android_entry.py`, `config.py`, `mode_plans.py`, `health.py`, and `ui/src/`: pre-import remote config application, usage sync, remote quality settings, and duplicate-control removal.

## Visual system

- **Design movement:** ADARSH operations console—precise, instrument-panel-like, not a generic admin template.
- **Core principles:** clear hierarchy; live state visible; one safe change at a time; no hidden destructive action.
- **Color philosophy:** reuse ADARSH light paper/clay-orange identity and dark near-black mode; restrained technical blue for selection and existing good/warn/bad status colors.
- **Layout paradigm:** mobile-first control surfaces with a compact persistent section navigator, overview cards and focused edit sheets; wider screens expand into a two-rail control layout rather than enlarging phone cards.
- **Signature elements:** monospace endpoint/model chips; revision/status pill; compact usage bars/sparklines.
- **Interaction:** small reversible transitions; save/test/apply states visible; disable/revoke/rollback confirm; reduced-motion support.
- **Typography:** Inter/system sans for controls and JetBrains Mono for model IDs, endpoints, revisions and counters.
- **Brand essence:** owner-only control plane for changing ADARSH behavior without repeatedly rebuilding the app; precise, calm, transparent.
- **Brand voice:** concise Roman Hinglish; e.g. “Config save hua · app next sync par apply karega” and “Remaining estimate hai—provider ka official balance nahi.”
- **Wordmark:** compact clay-orange A mark with “ADARSH / CONTROL” stacked, not an unstyled heading.
- **Signature brand color:** ADARSH clay orange (`#D0623A` light, `#DA7551` dark); blue remains selection-only.

## Delivery constraints

Work stays on `adarsh-news-workflow`, preserving `main` and `new`. Existing database rows remain intact; no reset/drop/truncate. Provider keys/secrets are never requested or printed. Do not build an APK. Do not publish the controller until the user separately asks to publish; preview/config can be built and reviewed first.