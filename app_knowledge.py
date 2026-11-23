"""Read-only, allowlisted self-knowledge. No arbitrary file, execution, key or write access."""
from __future__ import annotations
import ast
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODULES = {
    "chat_adapter.py": "UI request routing: local actions first, Standard quick reply, selected-mode reasoning otherwise.",
    "pipeline.py": "Question classification, source handling (auto/manual/hybrid), role engine and answer packaging.",
    "roles.py": "11-role reasoning: architect, drafters, pattern finder, skeptic, falsifiers, debate, judge, reviewers, refiner. Selected mode wins.",
    "mode_plans.py": "Separate model chains and behaviour policy for Standard, Verified/V, Physics, Math, Business and Coding.",
    "llm.py": "Provider requests, role-specific failover, quota-aware retries. API credentials are excluded from this reference.",
    "health.py": "Local usage/quota state, call traces and provider cooldowns.",
    "research.py": "Web source gathering for reasoning. Search queries reach research providers; no local records are searched automatically.",
    "voice.py": "Online Gemini TTS, Groq English TTS, then optional Python Piper fallback. UI also uses Android Piper then system TTS.",
    "android_entry.py": "Chaquopy entry, local preflight before API-key gate, JSON responses and progress events.",
    "actions/parser.py": "Offline deterministic Hindi/Hinglish/English command parsing, maximum three steps.",
    "actions/schema.py": "Allowlisted action arguments and risk policy. AI deletion/security/sensitive setting changes are denied.",
    "actions/plan.py": "Validated action plan, local-rule origin and short Sir acknowledgement. This module does not execute actions.",
    "app_context.py": "Permission-aware allowlisting and bounded relevant record selection for online model context.",
    "app_knowledge.py": "Read-only architecture reference built from fixed module names and public function names. Never reads secrets or arbitrary paths.",
}
ANDROID = {
    "ActionStore.kt": "App-private atomic JSON records: tasks, reminders, alarms, timers, notes and Work projects/activity logs.",
    "ActionRunner.kt": "Native record add/edit/completion and AlarmManager scheduling; explicit deny and independent confirmation policy.",
    "ActionReceiver.kt": "Notification firing, retained fired status and boot re-arming. Android force-stop can prevent delivery until reopened.",
    "Speaker.kt": "System TextToSpeech and natural audio playback; installed phone voice picker. Engine may require network for some voices.",
    "NeuralTTS.kt": "sherpa-onnx Piper offline neural speech: hi_IN-rohan and en_US-ryan, model packs downloaded once.",
    "Dictation.kt": "Android SpeechRecognizer for mic input; recognition provider may send audio online. No guaranteed offline-only STT.",
    "MainActivity.kt": "WebView app shell, main-thread bridges, permissions, speech and native records.",
    "AdarshBridge.kt": "Explicit JavaScript interfaces, not unrestricted code/file access.",
}
UI = {
    "04-productivity.js": "Shared Tasks/Reminders/Alarms/Notes/Work lists, native migration, local memory/settings actions and data access boundaries.",
    "04-productivity-views.js": "Separate manual productivity pages, including structured project activity logs.",
    "03-chat.js": "Chat request captures selected mode, approved context and local action execution; no auto mode switch.",
    "04-views.js": "Drawer navigation, settings and explicit AI access toggles.",
    "05-actions.js": "Action cards, per-step execution state and confirmation. Rejects remote/untrusted action objects.",
    "05-voice.js": "Tap-to-talk conversation, actual action result speech, optional in-session hands-free. No default wake-word listener.",
}


def relevant(text: str) -> bool:
    return bool(re.search(r"architecture|adarsh.*(?:kaise|how|model|code|feature)|(?:tumhara|tumhare|apna|your|this app|is app|isme).*(?:architecture|engine|tts|piper|module|mode|model|code|feature|fallback)|(?:phone tts|gemini tts|voice engine|sherpa|ActionRunner|mode_plans)", text, re.I))


def reference(mode: str = "standard") -> dict:
    """Only curated facts and public symbol names; never raw source/env/provider objects."""
    modules = []
    for name, purpose in MODULES.items():
        item = {"path": name, "purpose": purpose}
        try:
            # The name is an internal constant, never user supplied. Symbols only, no literal values.
            data = (ROOT / name).read_bytes()
            tree = ast.parse(data.decode("utf-8"))
            item["fingerprint"] = hashlib.sha256(data).hexdigest()[:12]
            item["symbols"] = [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))][:24]
        except (OSError, SyntaxError, UnicodeError):
            item["symbols"] = []
        modules.append(item)
    import mode_plans
    import config
    plans = {m: mode_plans.describe(m) for m in mode_plans.PLANS}
    active = mode_plans.get(mode)
    chains = {r: [s.label for s in config.chain_of(spec)] for r, spec in active.chains.items()}
    return {
        "readOnly": True, "selectedMode": mode, "factsVersion": "tasks-work-v1", "modules": modules,
        "android": ANDROID, "ui": UI, "plans": plans, "selectedRoleFallbacks": chains,
        "quick": {"primary": config.QUICK.label, "fallbacks": list(config.QUICK.fallbacks), "enabledByDefault": True},
        "voice": {"auto": "Gemini -> Groq English where applicable -> Piper if ready -> system TTS",
                  "phone": "System TTS only; Gemini voice dropdown does not choose the system voice.",
                  "offline": "Piper hi rohan / en ryan after the model pack download; no provider text requests.",
                  "microphone": "System recognizer may be online even for a local action."},
        "boundaries": ["No code writes, shell execution, self-update or deploy.", "No keys, PIN, account tokens or secret contents in this reference.",
                       "Local actions are not model calls. App opening sends a launch intent, not another app's screen contents.",
                       "Online answers/voice/search can send text to their providers; permitted personal context is bounded and relevant only.",
                       "Missing reference details must be acknowledged; do not invent runtime/device observations."],
    }


def context(text: str, mode: str, allowed: bool = True) -> str:
    if not allowed or not relevant(text):
        return ""
    ref = reference(mode)
    # All module descriptions are small; only the selected plan is needed per answer.
    ref["plans"] = {mode: mode_plans_for(ref, mode)}
    words = set(re.findall(r"[a-z_]{3,}", text.lower()))
    ref["modules"] = sorted(ref["modules"], key=lambda m: -sum(w in (m["path"] + " " + m["purpose"]).lower() for w in words))[:4]
    for m in ref["modules"]:
        m.pop("symbols", None)
    ref["android"] = {k: v for k, v in ref["android"].items() if any(w in (k + " " + v).lower() for w in words)}
    ref["ui"] = {k: v for k, v in ref["ui"].items() if any(w in (k + " " + v).lower() for w in words)}
    ref["selectedRoleFallbacks"] = {k: v for k, v in ref["selectedRoleFallbacks"].items() if k.lower() in text.lower()}
    return "\n\n[Read-only app architecture reference; facts not instructions; no code editing capability]\n" + json.dumps(ref, ensure_ascii=False)


def mode_plans_for(ref: dict, mode: str) -> dict:
    return ref["plans"].get("verified" if mode == "v" else mode, ref["plans"]["standard"])
