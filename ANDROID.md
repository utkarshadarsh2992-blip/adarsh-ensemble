# ADARSH Ensemble: Android APK

Engine ke andar Python (Chaquopy) chalta hai. Koi server, VPS ya localhost nahi. UI ka `AdarshNative` bridge seedha Python `android_entry.handle()` ko call karta hai.

```
WebView (ui/dist/adarsh.html, assets me)
   | AdarshNative.send(id, json)          [ui/src/js/00-android-bridge.js]
Kotlin AdarshBridge -> Engine (thread pool + foreground service)
   | Chaquopy
android_entry.handle() -> chat_adapter -> pipeline (same engine, unchanged)
   | HTTPS (httpx)
Groq / Gemini / OpenRouter (zaroori) + Cloudflare Workers AI / NVIDIA NIM (optional extra)
```

## APK download (GitHub Actions)
1. Is project ko repo me daalo (branch `android-apk`) aur push karo.
2. GitHub > **Actions** > **Android APK** > **Run workflow** (ya push par khud chalega).
3. Run poora hone par (hara tick) run page kholo, neeche **Artifacts** me `adarsh-ensemble-debug-apk` download karo.
4. Zip extract karo, `app-debug.apk` phone me install karo (Unknown sources allow karna padega).
5. App kholo > Settings > **API keys** me Groq/Gemini/OpenRouter key daalo. Cloudflare ke liye token aur Account ID dono chahiye. Test connection har provider ke configured model IDs check karta hai aur galat ID par "shayad: ..." batata hai.

GitHub Secrets APK ke andar nahi jaate, isliye keys sirf app me daalte hain. Keys Android Keystore se encrypt hokar app-private storage me rehti hain.

## Kya badla
Naye: `android/` (Gradle project, Kotlin: AdarshApp, Engine, EngineService, AdarshBridge, SecureKeys, MainActivity), `android_entry.py`, `requirements-android.txt`, `tests/test_engine.py`, `.github/workflows/android-apk.yml`, `ui/src/js/00-android-bridge.js`, `ANDROID.md`.
Badle: `config.py` (ON_ANDROID, CODE_EXEC_SUPPORTED), `sandbox.py` (Android par saaf "UNSUPPORTED"), `verified.py` (UNSUPPORTED count), `chat_adapter.py` (Android par proofs off), `ui/src/index.html` (bridge script), `ui/src/js/04-views.js` (API keys screen), `.gitignore`.
Engine (pipeline, llm, health, prompts, guard) me koi logic change nahi. `main.py` (FastAPI) APK me shamil nahi hai.

## Android par band / alag
- **Python code proofs band:** Android par `python` interpreter spawn nahi ho sakta. Isliye "[PROVEN by code]" nahi milega, steps [REASONED] rahenge. Baaki poori pipeline (panel, falsifiers, judge, linter) chalti hai.
- **Default `CHAT_MODE=fast`** phone par (kam models, kam quota). Deep ke liye `android_entry.init` me default hatao.
- Attachments engine tak nahi jaate. Voice input (speech recognition) WebView me kaam karega ya nahi, ye test nahi hua.
- Request cancel karne par jawab drop hota hai, Python request rukti nahi.
- Debug-signed APK hai (install ke liye theek, Play Store ke liye nahi).

## Test report (sach)
| Test | Status |
|---|---|
| Python offline tests (11): provider config, fallbacks, key set/clear, pipeline fast+deep (fake models), lint, sandbox, error scrub, network failure | **Chala, 11 pass** (yahan Python 3.12/3.11 par, providers fake) |
| UI JS syntax (`node --check`), UI build, YAML/XML well-formed | **Chala, pass** |
| APK build | **Nahi chala.** Yahan Android SDK/Gradle/Chaquopy download blocked hai. GitHub Actions par pehli baar chalega |
| Install, app open, frontend load, bridge, key save/load | **Nahi chala** (device/emulator nahi) |
| Real provider API call, multi-model real run | **Nahi chala** (network blocked, keys nahi) |
| Network failure on device, background/resume recovery | **Nahi chala** (sirf Python side par fake failure test hua) |

Pehli CI build me Gradle/versions ki dikkat aa sakti hai (Chaquopy 16.1.0 + AGP 8.7.3 + Gradle 8.9 + Python 3.12 chuna hai, docs ke hisaab se compatible). Fail ho to Actions ka log bhejo, main fix karunga.

## Kisne kya socha (council view)
Jawab ke upar "Thinking" block live lines dikhata hai (har role ka kaam poora hote hi ek line), jawab aane par "Thought for Ns" ban jaata hai. Block par tap karo to poora page khulta hai: har role ka prompt, kaun sa model chala (fallback ho to wo bhi), poora jawab, claims map, falsifier reports, judge, format repair, audit (pehle/baad), aur "kya aaya, kya gaya" (draft se final tak, shabd-milan ka andaaza). Hardware back pehle is page ko band karta hai.
Record bada hota hai (kuch 10 KB se 100 KB), isliye sirf pichhle 10 jawab ka rakha jaata hai; purane jawab ka text rehta hai, detail page nahi. Export me ye record shamil nahi hota.
Pattern finder 7th panel role hai: sirf deep mode me chalta hai (fast me panel ke pehle 3 hi).

## Manual master answer + Lessons
Manual mode ab sirf tumhare paste kiye answers se ek master answer banata hai (7 section, har baat par [A]/[B] source tag, jo answers me nahi wo "Paste kiye answers me nahi hai."). Panel ke models Manual me nahi chalte. Auto ka format aur stages wahi hain.
Master answer par 👎 dabao to "Kya galat tha?" sheet khulti hai: ek line likho, wo rule ban kar agle master answer me jaati hai. Checks jab known galti pakadte hain (section chhoota, bina source ki baat, gadhi hui kahani, galat tag) to rule apne aap judta hai. Settings > Lessons me list, badlo, hatao. Model train nahi hota: rules prompt me jaate hain.
Lessons ka kaam phone par seedha file ka kaam hai (`AdarshNative.lessons`), isliye API key ya foreground service nahi chahiye. File: app ke private folder me `engine/lessons.json`.
Council page Manual me panel/falsifier/proofs hide karta hai aur Lessons section dikhata hai. Takraav par `factual` / `choice` pill dikhti hai.
**Nahi chala:** Kotlin `lessons()` bridge compile/device par test nahi hua (APK build yahan nahi ho sakta).

## Mic (voice typing)
Pehle mic ka button tha par WebView me Web Speech API nahi hota aur `RECORD_AUDIO` permission bhi nahi thi, isliye kuch nahi hota tha. Ab Android ka apna `SpeechRecognizer` bridge se chalta hai (`Dictation.kt`, `AdarshNative.speechStart/speechStop`). Pehli baar mic dabane par system permission dialog aata hai. Phone par speech service (Google) chahiye; na ho to "Voice typing failed" ka toast aata hai.
**Nahi chala:** Kotlin compile aur asli phone par mic (sirf JS side Chromium me stub ke saath test hua).
