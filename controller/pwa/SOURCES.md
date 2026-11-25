# Implementation sources

The existing ADARSH launcher vector (`android/app/src/main/res/drawable/ic_launcher_foreground.xml`) supplies the reused A-mark path. The bundled model list is extracted from existing `config.py` without importing keys or calling providers. It is not a verified live provider model catalog.

Supabase’s official passwordless guide confirms `shouldCreateUser:false` disables automatic signup and that inline email OTP requires the Magic Link email template to include `{{ .Token }}`. Authentication is not granted until verified Supabase Auth and server-side controller allowlist checks succeed. See https://supabase.com/docs/guides/auth/auth-email-passwordless . If email templates/SMTP are not configured, login remains unavailable and the app shows the setup requirement rather than inventing a session.

UI icons come from `lucide-react` under the ISC/MIT notices shipped in the package. License source: https://lucide.dev/license . No decorative stock imagery is needed for this private operations dashboard.
