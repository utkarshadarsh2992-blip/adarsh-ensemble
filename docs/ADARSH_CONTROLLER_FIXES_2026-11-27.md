# ADARSH fixes — 27 Nov 2026

Sir, ye delivery `main` ke liye hai. `new` aur `adarsh-new-plus-today` par koi change/push nahi kiya gaya; force-push use nahi hua.

## Fact-check aur source grounding

Current-news claims ko sirf model memory ke basis par confidently deny/correct karne ka behavior soften kiya gaya hai. Strong verdict ke liye relevant URL evidence chahiye; missing evidence par unverified/uncertain wording use hoti hai. Supplied News/Pattern source URLs bounded, SSRF-safe source fetch se grounding mein aate hain. Irrelevant research sources ko current-news evidence nahi maana jana chahiye.

FCC authorization, proposed plan aur completed deployment ko alag rakha gaya hai. JERA ke Tokyo/Japan talks ko Indian publisher ki wajah se India ka event nahi maana jana chahiye; unsupported/missing scoring region ab WORLD fallback leta hai. Existing stored articles ka bulk geography rewrite nahi kiya gaya. Hallucination risk kam hota hai, zero guarantee nahi milti.

## News Groq aur Tavily failover

News ke liye exactly do Groq slots aur do Tavily slots Controller mein hain. Groq HTTP 402/429 aur Tavily HTTP 402/429/432/433 par affected key suppress hoti hai; alternate key immediately try hoti hai. Suppression shared server KV mein opaque generation identifiers se persist hoti hai, secret values se nahi. Later jobs exhausted generation ko reset se pehle dobara call nahi karte.

Default reset 05:00 Asia/Kolkata hai. Controller ke Keys & settings mein reset time HH:MM format mein edit ho sakta hai. Boundary par key dobara eligible hoti hai. Ye provider ke actual paid/monthly credits replenish nahi karta; provider ab bhi exhausted ho to key phir suppress hogi. Authentication failure key replacement tak block hota hai; network/5xx failure short cooldown aur alternate-key failover use karta hai.

Dono keys blocked hon to honest unavailable/stop behavior rehta hai. Existing global News budgets, safety credits aur queued items preserve hote hain. Key replacement ka naya generation purana cooldown inherit nahi karta. Same secret ko duplicate slots se double-call karna deduplication se prevent hota hai.

## Controller mein moved controls

Keys & settings mein regular app providers ke teen-teen slots hain: Groq, OpenRouter, Gemini, NVIDIA aur Cloudflare. Cloudflare ke har slot ke saath Account ID field hai; token-only ya Account-ID-only update doosra existing field preserve karta hai.

App answer/research Tavily ek separate app slot hai. News Tavily ke do slots independent News scope mein hain. App Tavily News ka fallback nahi hai; News Tavily app answer/research ka fallback nahi hai.

News URL/APP_SECRET, Firebase push setup, protected Telegram/push operations, briefing on/time, Include News aur Telegram-copy controls Controller mein hain. Existing Controller News budget/notification-limit controls wahi rehte hain. Android Settings se provider-key editor, News/Firebase setup, budget editor aur moved briefing behavior controls remove ho gaye hain. News reader, local privacy consent, phone notification/microphone permissions aur pairing remain available.

Sir, Controller metadata initial mein Missing dikha sakta hai jab phone ki old key abhi Vault mein migrate nahi ki gayi. Security ke liye purani phone key read back/import nahi ki gayi. Desired values Controller mein save karke paired app sync karein.

## Credential security aur compatibility

Owner-authenticated write-only operations Supabase Vault use karti hain. PWA ko sirf configured status, generation aur update metadata milta hai; secret values read back nahi hoti. Inputs successful/failed saves ke baad clear hote hain aur normal browser storage/config/reports mein store nahi hote.

Paired, unrevoked native device app/setup bundle receive karta hai. News Groq/Tavily credentials us payload se excluded hain aur News Edge Functions ke server-side scope mein rehte hain. Native applied provider values Android encrypted storage mein hain; ordinary WebView ke key-save/read/status bridge methods remove ho gaye hain.

Untouched pre-Controller native keys aur News/Firebase setup preserve hote hain. Sirf explicit Controller save/delete slot managed banta hai; delete durable tombstone bhejta hai aur next sync par corresponding native value clear hoti hai. Empty new Controller form automatically existing phone keys wipe nahi karta. Controller delete controls legacy slots ko bhi explicitly clear kar sakte hain, warning/confirmation ke saath.

Same authenticated credential revision reset encrypted store ko restore kar sakti hai. Older revision reject hoti hai; ordinary preferences mein only non-secret settings/revisions rehte hain. Privacy consent Controller se overwrite nahi hoti.

Live metadata check ne `controller_admins.email` column confirm kiya. Credential RPCs ke anon/authenticated execute grants false aur service_role execute true hain. Unauthorized Controller requests 401 return karti hain. Real API keys read, insert ya paid provider request se test nahi kiye gaye.

## Hey Adarsh wake word

Android Settings mein Hey Adarsh on/off switch add hai; default OFF hai. Explicit enable microphone/notification permission flow ke saath native on-device recognizer start karta hai. Standby ambient speech ko model providers/cloud STT par nahi bhejta. Conversation/audio start par detector pause/release hota hai aur disable par standby stop hoti hai.

Implementation Android 12+ aur device ke available offline/on-device speech model par depend karti hai. Unsupported device/language ko unsupported report kiya jata hai; silent cloud fallback nahi hai. Ye dedicated low-power hotword DSP nahi, on-device speech-recognition standby hai, isliye battery/microphone use hoga. Process/force-stop/reboot ke baad auto microphone restart nahi hota; explicitly enable dobara karna pad sakta hai. Background/lock-screen launch Android restrictions ke under notification tap require kar sakta hai.

## Verification aur deployment

Python suite: 689 passed, 1 skipped. UI JavaScript suite: 143 passed, 0 failed; process cleanly exit hua. Deno backend suite: 76 passed, 0 failed. Controller PWA suite: 26 passed, 0 failed. PWA typecheck/production build, seven Edge Function checks, all UI JavaScript syntax checks aur diff whitespace checks pass hue.

New native-inventory migration Supabase project yepupldfjtikalfzehvl par successfully apply hui. Seven Edge Functions update deploy hue: news-api, news-digest, news-score, news-ingest, news-clean, controller-admin aur controller-device. Tavily 432/433 change ke baad affected News functions dobara deploy hue.

Canonical Controller checkpoint f39b246872953f4c6d121d864c8383b204f06f13 recorded hai. Existing auto_publish:true setting ne publication submit ki; final rollout status Dashboard mein dikhega. Submission ko successful live rollout claim nahi maana gaya.

Local Android compilation/APK build nahi kiya: is sandbox mein Android SDK/Gradle executable/wrapper unavailable hai. Native checks source-contract tests hain, Android instrumentation/device tests nahi. Main push ke existing GitHub Android APK workflow se actual compiler/build evidence mil sakta hai; run success se pehle APK-ready claim nahi hai.

## Reference sources

Tavily ke actual quota errors official sources se verify hue:
- https://help.tavily.com/articles/8645538886-understanding-http-errors
- https://docs.tavily.com/documentation/api-reference/endpoint/search

Prior fact verification sources:
- https://www.fcc.gov/document/fcc-authorizes-1-million-satellites-data-centers-space-0
- https://docs.fcc.gov/public/attachments/DA-26-1273A1.pdf
- https://www.reuters.com/world/asia-pacific/japans-jera-enters-talks-with-anthropic-meta-build-data-centres-nikkei-reports-2026-11-26/
- https://economictimes.indiatimes.com/tech/artificial-intelligence/japans-jera-enters-talks-with-anthropic-meta-to-build-data-centres/articleshow/136210887.cms
