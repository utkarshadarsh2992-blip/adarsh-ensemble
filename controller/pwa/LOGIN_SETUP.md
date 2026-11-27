# ADARSH Controller — owner login setup

## Owner account aur password

`adarshutkarsh5@gmail.com` ka Supabase Auth account pehle se verified hai aur uska current Auth UUID private `controller_admins` allowlist mein approved hai. **Is user ko delete karke same email se naya account mat banao.** Allowlist Auth UUID se judi hai; deletion se purani allowlist entry cascade-delete hoti hai, aur naya account ko naya UUID milta hai. Sabse safe rasta isi existing account par password set/reset karna hai.

Controller login source mein **Password** aur **Email code** dono options hain. Password option `signInWithPassword` se Supabase Auth ko authenticate karta hai; controller mein password save nahi hota, signup nahi hai, aur successful Auth login ke baad bhi server-side owner UUID allowlist check hota hai. Is source update ko abhi live deployment mein include nahi kiya gaya hai; jab tak update deploy na ho, current site par password tab dikhna zaroori nahi.

Agar tumne user pehle hi delete karke dobara bana diya ho, naya account apne-aap owner access nahi lega. Password ya token bhejne ki zaroorat nahi; sirf bata dena ki verified user dobara ban gaya hai, taaki us naye Auth UUID ko verify karke allowlist ki ja sake. Email ke basis par fabricated identity add nahi karni.

## Password option par jaane se pehle

Supabase Dashboard → **Authentication → Users** mein existing owner user ko select karke available password set/reset flow use karo. Password, recovery code, OTP, access token ya token-wala URL chat/GitHub mein share mat karo. Agar reset email bhejni pade to pehle neeche ka redirect config theek karna hoga; current project email limit bhi hit ho chuki hai. Login email assistant ne dobara request nahi ki.

## Email code aur localhost redirect

Supabase logs mein `over_email_send_rate_limit` ke saath 429 responses aaye. Supabase built-in email provider ki documented limit 2 emails per hour per project hai; exact current reset time logs se maloom nahi. Abhi OTP/invitation email dobara request na karo. Password mode ko fallback ke roop mein use karo.

Agar future login email localhost par khulti hai, mobile par Supabase Dashboard → **Authentication → URL Configuration** mein:

- **Site URL:** `https://adarshctl-pc68aukk.manus.space`
- **Redirect URLs:** isi exact URL ko allowlist mein add karo; unrelated valid entries preserve karo aur broad wildcard add mat karo.

Numeric email code ke liye **Authentication → Email Templates → Magic Link** mein `{{ .Token }}` hona chahiye. App email code `verifyOtp({ email, token, type: "email" })` se verify karta hai. Supabase ke mutabik email link/code request limit aur built-in project email-send quota alag controls hain. Abhi Site URL, allowlist aur template ke actual Supabase values read nahi hue hain; localhost ka sabab abhi likely hai, confirmed config finding nahi.

## Controller aur ADARSH pairing

Owner login ke baad **Devices & changes → Pair device** se short-lived one-time code banao. Updated ADARSH app mein **Settings → Controller** par code enter karke sync karo. Pairing token native encrypted storage mein rahega. Provider keys aur News/Firebase setup secrets ab dedicated **Keys & settings** tab se owner-only write-only actions ke zariye manage honge; values browser/backend response mein dobara nahi dikhengi. Native encrypted credential delivery aur naya credentials API parent-owned integration hai, isliye purani hosted PWA mein settings backend unavailable dikh sakta hai jab tak woh integration publish na ho.

**Android integration source mein hai, lekin purana installed APK ise nahi jaanta.** Is kaam mein APK/Gradle build nahi hua. Updated app ki ek initial release ke baad compatible remote config changes ke liye agla APK rebuild zaroori nahi.

## Status aur limitations

- Supabase `controller-admin` aur `controller-device` deployed/ACTIVE hain; anonymous admin requests 401 se reject hui.
- Owner Auth email verified hai aur current Auth UUID allowlist mein enabled hai.
- Password/email-code login ka real end-to-end test, valid pairing aur real-device config/report round trip abhi pending hai.
- Password/OTP UI update source mein hai, lekin is update ka checkpoint/deployment abhi nahi hua; current hosted site pehle se deployed version dikha sakti hai.
- Available token/request numbers configured caps aur observed usage ke estimates hain, guaranteed live provider account balance nahi.
- News, provider keys, chats aur existing phone usage/history ko wipe/reset nahi kiya gaya.
