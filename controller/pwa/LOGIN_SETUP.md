# ADARSH Controller — owner login ka remaining setup

Controller source aur private APIs ready hain, lekin owner ka Supabase Auth account abhi nahi mila. Admin allowlist intentionally empty hai. Koi public signup, fake user, password request ya login bypass nahi banaya gaya.

## 1. Supabase Auth account provision karo

Apne Supabase project Dashboard mein **Authentication → Users → Add user / Send invitation** se apne supplied owner email ko invite karo. Email ka invitation apne browser mein complete karo. Password ya email OTP Manus chat/GitHub mein mat bhejo. UI names Dashboard version ke hisaab se thode alag ho sakte hain.

## 2. Email OTP setup

**Authentication → Email Templates → Magic Link** mein OTP ke liye `{{ .Token }}` include hona chahiye. Controller email OTP use karta hai aur `shouldCreateUser:false` hai. Email provider/SMTP aur allowed redirect-origin configuration sahi honi chahiye; unpublished Preview ko use karte waqt uska actual browser-facing origin allow karo. Template/SMTP configuration is task mein inspect ya change nahi ki gayi.

## 3. Verified owner ko private allowlist mein add karna

Account banne aur email verify hone ke baad Manus ko sirf “Auth account ban gaya” batao. Hum existence/verification check karke actual immutable Auth UUID ko `controller_admins` mein add kar sakte hain. Password, access token ya service-role key ki zaroorat share karne ki nahi hai. Email-only fabricated identity seed nahi karni hai.

Agar khud SQL run karna ho, apne email se placeholder replace karo. Ye existing **verified** Auth user ke liye hi insert karega; zero rows ka matlab setup abhi incomplete hai:

```sql
insert into public.controller_admins (user_id, enabled)
select id, true
from auth.users
where lower(email) = lower('YOUR_OWNER_EMAIL')
  and email_confirmed_at is not null
limit 1
on conflict (user_id) do update set enabled = true;
```

## 4. Controller aur ADARSH link

Manus ke **Preview** panel se controller kholo, Owner login par apna email/OTP enter karo. **Devices & changes → Pair device** se short-lived one-time code banao. Updated ADARSH app mein **Settings → Controller** par wahi code enter karke sync karo. Pairing token native encrypted storage mein rahega; provider keys PWA mein nahi jayengi.

**Important:** Android integration abhi source mein hai. Purane installed APK ko is source change ke bina controller pairing nahi milegi. Is task mein aapke instruction ke mutabik koi APK/Gradle build nahi kiya gaya. Ek initial updated app version ke baad compatible remote config changes bina further APK rebuild ke apply ho sakte hain.

## Status aur limitations

- Supabase `controller-admin` aur `controller-device` deployed/ACTIVE hain; anonymous access rejects with 401.
- PWA unpublished hai; Preview/checkpoint publication nahi hai.
- Live owner login, valid pairing aur real-device report upload abhi verify nahi hue.
- Available token/request numbers configured caps aur observed usage ke **estimates** hain, guaranteed live provider account balance nahi.
- News, keys, chats aur old usage data ko wipe/reset nahi kiya gaya.
