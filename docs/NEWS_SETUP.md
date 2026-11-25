# Adarsh News System — Setup Guide

1. **Supabase project banayein.** supabase.com par free project banaiye. Project ref aur URL ko sirf apne private notes mein rakhiye. Public repo mein apna URL, key ya token mat daaliye.

2. **SQL chalaiye.** Dashboard > SQL Editor mein pehle `supabase/migrations/20261125000000_news_schema.sql`, phir `supabase/seed.sql` run kijiye. Cron migration tabhi chalaiye jab pg_cron, pg_net aur Vault enabled hon. Seed dobara chalane par duplicate nahi banenge.

3. **Vault secrets banaiye.** Cron migration ke comments mein diye `vault.create_secret` statements ko apne real project URL aur random `CRON_SECRET` ke saath ek baar chalaiye. Cron secret kam se kam 32 random characters ka ho.

4. **Function secrets set kijiye.** Supabase Dashboard > Edge Functions > Secrets mein ye values set kijiye: `APP_SECRET`, `CRON_SECRET`, `GROQ_API_KEY_1` (optional `_2`, `_3` rotation ke liye), `TAVILY_API_KEY`, `TELEGRAM_BOT_TOKEN`, `FCM_SERVICE_ACCOUNT` (poora service-account JSON text), optional `CURRENTS_API_KEY`, optional `NEWSDATA_API_KEY`. `SUPABASE_URL` aur `SUPABASE_SERVICE_ROLE_KEY` Supabase khud inject karta hai. APP_SECRET aur CRON_SECRET ko password manager ke random 32+ character values se banaiye; kabhi repo mein na likhiye.

5. **Functions deploy kijiye.** Supabase CLI mein project link karke `supabase functions deploy news-api --no-verify-jwt`, aur yahi command `news-ingest`, `news-score`, `news-digest`, `news-clean` ke liye chalaiye. Dashboard ke Function Editor mein har folder ka `index.ts` paste karke bhi deploy kar sakte hain. Cron functions mein header `x-cron-secret` aana zaroori hai; API mein `x-app-secret`.

6. **Telegram jodiye.** Telegram mein BotFather se bot banaiye, token ko `TELEGRAM_BOT_TOKEN` secret mein rakhiye. Bot ko `/start` bhejiye. App ke News settings se `telegram_link` action chalaiye; server latest bot update ka chat save karega. Test ke liye `telegram_test` chalaiye.

7. **Firebase/FCM banaiye.** Firebase Console mein project aur Android app package `app.adarsh.ensemble` banaiye. Project settings > General se `apiKey`, `appId`, `projectId`, `messagingSenderId` app Settings mein daliye; `google-services.json` ki zaroorat nahi. Project settings > Service accounts > Generate new private key se JSON download karke poora JSON Supabase secret `FCM_SERVICE_ACCOUNT` mein rakhiye; file ko repo ya phone par na rakhein. App token register karega. `fcm_test` se check kijiye.

8. **Groq aur Tavily.** Groq key aisi use kijiye jiska daily `gpt-oss-20b` quota chat app se shared na ho, ya default 150,000 token cap rakhiye. Tavily key verification ke liye hai; default monthly cap 700 hai. Optional Currents/NewsData keys ke bina un rows ko active mat kijiye.

9. **Limits samajhiye.** Default Groq cap 150,000 tokens aur 400 calls per UTC day hai; 80% par Telegram+FCM warn, 100% par scorer stop hota hai. Tavily cap 700 credits/month; advanced verification 2 credits leti hai. Max 5 breaking alerts/local day; 3 alerts ke baad threshold ek point badhta hai. Telegram ko lagbhag 1 message/second se tez nahi bhejte. State-media-only story kabhi alert nahi hoti. Cleanup purani news rakhta hai.

10. **Digest aur test.** Default digest `21:30` `Asia/Kolkata` hai; Settings se time/timezone badal sakte hain. `ping`, `digest_now`, `fcm_test`, `telegram_test` actions ko API par POST karke test kijiye. API body `{ "action": "ping" }` aur header `x-app-secret` rakhiye. URL aur secret app ke encrypted phone storage mein hi rakhein.

11. **Free project note.** Supabase free project lagbhag 7 idle days ke baad pause ho sakta hai. Kabhi-kabhi app kholkar `ping` kijiye aur Supabase dashboard ka warning email check kijiye.

## Troubleshooting

| Problem | Kya dekhein |
|---|---|
| `Auth galat` | Header name, APP_SECRET/CRON_SECRET exact match aur extra spaces check karein. |
| Feed count zero | Feed URL browser/curl se 200 hai? Feed ko 2 MB cap aur 30 items cap ke andar rakha gaya hai. |
| Telegram nahi aaya | Bot ko `/start`, phir `telegram_link`; token secret mein hai? |
| FCM fail | package `app.adarsh.ensemble`, Firebase values, service-account JSON aur Android Google Play Services check karein. |
| Groq stopped | `budget` action dekhein; UTC day reset ka wait ya settings cap samjhein. |
| No breaking alert | Score 8+, Tavily verification, reviewer confirmed, independent non-state sources aur daily slot sab zaroori hain. |
| Digest nahi aaya | `digest_time`, `tz`, local day aur `digest:last_day` check karein; manual `digest_now` chalaiye. |
| Cron nahi chal raha | Vault mein `project_url` aur `cron_secret`, pg_cron/pg_net enabled, functions deployed aur cron.job rows check karein. |

## Privacy

Public repo mein sirf placeholders aur code hai. APP_SECRET, CRON_SECRET, provider keys, Telegram token, Firebase service-account JSON aur project URL ko sirf Supabase secrets/Vault mein rakhiye. Is local implementation ko real Supabase, Firebase, Telegram, Groq ya Tavily account par test nahi kiya gaya; local parser, in-memory pipeline aur static/SQL checks hi verify kiye gaye hain.
