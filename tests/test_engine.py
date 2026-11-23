"""Offline tests: no network. Providers are faked by patching llm.chat.
Run: python -m pytest tests -q
"""
import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")

import android_entry  # noqa: E402
import config  # noqa: E402
import llm  # noqa: E402
import pipeline  # noqa: E402
import sandbox  # noqa: E402
import verified  # noqa: E402

JUDGE_TEXT = "1. Direct Core Truth: 4.\n2. Verified Mechanism: 2+2 [PROVEN by code]\n3. Trap Warning: none"


@pytest.fixture(autouse=True)
def _council_standard(monkeypatch):
    """These tests check the full council path; the Standard quick path has its own tests (test_quick.py)."""
    import chat_adapter
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", False)


@pytest.fixture(autouse=True)
def fake_models(monkeypatch):
    calls = []

    async def fake_chat(client, spec, messages, **kw):
        calls.append(spec.label)
        if spec is config.CLASSIFIER:
            return "math"
        if spec is config.STRIPPER:
            return json.dumps({"claims": []})
        return JUDGE_TEXT

    monkeypatch.setattr(pipeline, "chat", fake_chat)
    monkeypatch.setattr(verified, "chat", fake_chat)
    monkeypatch.setattr(config, "CHAT_ENGINE", "verified")  # these tests cover the older 3-section engine (roles: test_roles.py)
    return calls


def test_provider_config_valid():
    assert config.PLAN_PROBLEMS == []
    assert set(config.PROVIDERS) == {"groq", "gemini", "openrouter", "cloudflare", "nvidia"}


def test_every_role_has_fallbacks():
    for name, spec in config.all_roles():
        assert spec.fallbacks, name


def test_set_key_roundtrip(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    assert not config.PROVIDERS["groq"].api_key
    assert android_entry.set_key("GROQ_API_KEY", "gsk_test_123456")
    assert config.PROVIDERS["groq"].api_key == "gsk_test_123456"
    assert android_entry.set_key("GROQ_API_KEY", "")
    assert not config.PROVIDERS["groq"].api_key
    assert not android_entry.set_key("NOT_A_KEY", "x")


def test_pipeline_runs_fast_and_deep():
    for deep in (False, True):
        res = asyncio.run(pipeline.run("2+2 kya hai?", deep=deep, run_code=False, use_guard=False))
        assert "Direct Core Truth" in res["answer"]
        assert res["task_type"] == "math"


def test_lint_downgrades_unproven():
    out, warns = verified.lint_answer("x [PROVEN by code]", [])
    assert "[REASONED]" in out and warns


def test_sandbox_blocks_bad_code_and_unsupported(monkeypatch):
    monkeypatch.setattr(config, "CODE_EXEC_SUPPORTED", True)
    monkeypatch.setenv("CODE_PROOFS", "1")
    assert sandbox.run_python("import os\nprint('PASS')")["status"] == "REJECTED"
    assert sandbox.run_python("print('PASS')")["status"] == "PASS"
    monkeypatch.setattr(config, "CODE_EXEC_SUPPORTED", False)
    assert sandbox.run_python("print('PASS')")["status"] == "UNSUPPORTED"


def test_handle_without_keys(monkeypatch):
    for k in android_entry.KEY_NAMES:
        monkeypatch.delenv(k, raising=False)
    out = json.loads(android_entry.handle(json.dumps({"text": "hi there"})))
    assert "API key" in out["text"]


def test_handle_with_key_returns_replies(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    out = json.loads(android_entry.handle(json.dumps({"text": "2+2 kya hai?", "history": []})))
    assert out[0]["type"] == "text" and "Direct Core Truth" in out[0]["text"]


def test_handle_bad_json_and_ping():
    assert "samajh" in json.loads(android_entry.handle("{not json"))["text"]
    assert json.loads(android_entry.handle(json.dumps({"ping": True}))) == {"ok": True}


def test_provider_error_is_reported_and_key_scrubbed(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_secret_abcdef")

    async def boom(*a, **k):
        raise RuntimeError("401 for key gsk_secret_abcdef")

    monkeypatch.setattr(pipeline, "run", boom)
    out = json.loads(android_entry.handle(json.dumps({"text": "hello world"})))
    assert "gsk_secret_abcdef" not in out["text"] and "***" in out["text"]


def test_network_failure_falls_back_to_error_reply(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")

    async def down(*a, **k):
        raise llm.LLMError("all providers unreachable")

    monkeypatch.setattr(pipeline, "chat", down)
    monkeypatch.setattr(verified, "chat", down)
    out = json.loads(android_entry.handle(json.dumps({"text": "hello world"})))
    assert out["type"] == "text" if isinstance(out, dict) else out[0]["type"] == "text"


def test_progress_callback_and_timeout(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    seen = []

    class CB:
        def accept(self, m):
            seen.append(m)

    out = json.loads(android_entry.handle(json.dumps({"text": "2+2 kya hai?"}), CB()))
    assert out[0]["type"] == "text" and any("draft" in m for m in seen)

    async def slow(*a, **k):
        await asyncio.sleep(5)

    monkeypatch.setattr(pipeline, "run", slow)
    monkeypatch.setenv("ANDROID_TIMEOUT_S", "0.2")
    out = json.loads(android_entry.handle(json.dumps({"text": "hello world"})))
    assert "Test connection" in out["text"]


def _handle_in_thread(request_json, request_id):
    import threading

    box = {}
    t = threading.Thread(target=lambda: box.setdefault("out", android_entry.handle(request_json, None, request_id)))
    t.start()
    return t, box


def _wait_running(request_id, seconds=3.0):
    import time

    end = time.monotonic() + seconds
    while request_id not in android_entry._running:
        assert time.monotonic() < end, "request never started"
        time.sleep(0.01)


def test_stop_cancels_running_request_and_its_model_calls(monkeypatch):
    """Stop must end the Python request (no further model calls), not only drop the late answer."""
    import threading

    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    monkeypatch.setenv("ANDROID_TIMEOUT_S", "60")
    seen = {"started": 0, "finished": 0, "cancelled": 0}
    entered = threading.Event()

    async def slow(*a, **k):
        seen["started"] += 1
        try:
            entered.set()
            await asyncio.sleep(30)  # stands in for a long chain of model calls
        except asyncio.CancelledError:
            seen["cancelled"] += 1
            raise
        seen["finished"] += 1

    monkeypatch.setattr(pipeline, "run", slow)
    t, box = _handle_in_thread(json.dumps({"text": "hello world"}), "stop-1")
    assert entered.wait(3), "model call never started"
    assert android_entry.cancel("stop-1") is True
    t.join(5)
    assert not t.is_alive(), "cancel did not stop the request"
    assert json.loads(box["out"])["text"] == "Rok diya gaya."
    assert seen == {"started": 1, "finished": 0, "cancelled": 1}
    assert "stop-1" not in android_entry._running


def test_stop_before_start_refuses_request_and_finished_ids_are_cleaned(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    calls = []

    async def never(*a, **k):
        calls.append(1)

    monkeypatch.setattr(pipeline, "run", never)
    assert android_entry.cancel("stop-2") is False  # Stop tapped before the pool thread reached Python
    out = json.loads(android_entry.handle(json.dumps({"text": "hello world"}), None, "stop-2"))
    assert out["text"] == "Rok diya gaya." and calls == []
    assert "stop-2" not in android_entry._early_cancel and "stop-2" not in android_entry._running
    # The id is used once: a normal request afterwards is not affected, and no id means the old behaviour.
    android_entry.handle(json.dumps({"text": "hello world"}), None, "stop-3")
    android_entry.handle(json.dumps({"text": "hello world"}))
    assert calls == [1, 1] and android_entry._running == {}


def test_stop_cancels_natural_voice_request(monkeypatch):
    import voice

    async def slow_tts(req):
        await asyncio.sleep(30)

    monkeypatch.setattr(voice, "handle", slow_tts)
    t, box = _handle_in_thread(json.dumps({"tts": {"text": "namaste"}}), "tts-1")
    _wait_running("tts-1")
    assert android_entry.cancel("tts-1") is True
    t.join(5)
    assert not t.is_alive()
    assert json.loads(box["out"]) == {"type": "error", "error": "cancelled"}


def test_stop_cancels_gather_children_without_stopping_another_request():
    import threading

    ready = threading.Event()
    child_cancelled = []
    results = {}

    async def child(n):
        try:
            if n == 1:
                ready.set()
            await asyncio.sleep(30)
        finally:
            child_cancelled.append(n)

    async def council():
        return await asyncio.gather(child(0), child(1))

    def run_council():
        try:
            android_entry._run_cancellable(council, 60, "council-stop")
        except asyncio.CancelledError:
            results["cancelled"] = True

    async def other():
        await asyncio.sleep(0.1)
        return "unaffected"

    t = threading.Thread(target=run_council)
    t.start()
    assert ready.wait(3)
    assert android_entry.cancel("council-stop") is True
    assert android_entry._run_cancellable(other, 5, "other-request") == "unaffected"
    t.join(5)
    assert not t.is_alive() and results == {"cancelled": True}
    assert sorted(child_cancelled) == [0, 1]
    assert android_entry._running == {}


def test_diagnose_reports_network_key_and_missing_models(monkeypatch):
    import httpx

    for k in android_entry.KEY_NAMES:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    monkeypatch.setenv("GEMINI_API_KEY", "g_test_123456")
    monkeypatch.setenv("OPENROUTER_API_KEY", "or_test_123456")

    def fake_get(url, **kw):
        if "groq" in url:
            return httpx.Response(200, json={"data": [{"id": "openai/gpt-oss-120b"}]}, request=httpx.Request("GET", url))
        if "openrouter" in url:
            return httpx.Response(401, json={}, request=httpx.Request("GET", url))
        raise httpx.ConnectError("dns fail")

    monkeypatch.setattr(httpx, "get", fake_get)
    text = json.loads(android_entry.diagnose())["text"]
    assert "groq: key OK, 1/" in text and "Nahi mile" in text
    assert "openrouter: key reject" in text
    assert "gemini: NETWORK FAIL ConnectError" in text
    assert "gsk_test_123456" not in text


def test_casual_path_skips_pipeline(monkeypatch):
    import chat_adapter

    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    ran = []

    async def no_pipeline(*a, **k):
        ran.append(1)
        raise AssertionError("pipeline must not run for greetings")

    async def quick(messages, **kw):
        assert kw.get("tools") is False  # small talk: one Groq call, no search tools
        return {"text": "Hello! Kaise ho?", "used": "gpt-oss-120b", "searches": 0, "wiki": [], "sources": [], "secs": 0.1}
    monkeypatch.setattr(pipeline, "run", no_pipeline)
    monkeypatch.setattr(chat_adapter.standard_agent, "answer", quick)
    for greeting in ("Hlo", "hello!", "Namaste", "thanks"):
        out = json.loads(android_entry.handle(json.dumps({"text": greeting})))
        assert out[0]["text"] == "Hello! Kaise ho?" and not ran
    assert not chat_adapter._is_casual("2+2 kya hai?")
    assert not chat_adapter._is_casual("explain photosynthesis")


def test_casual_failure_falls_back_to_pipeline(monkeypatch):
    import chat_adapter

    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")

    async def down(*a, **k):
        raise chat_adapter.standard_agent.StandardError("down")
    monkeypatch.setattr(chat_adapter.standard_agent, "answer", down)
    out = json.loads(android_entry.handle(json.dumps({"text": "Hlo"})))
    assert "Direct Core Truth" in out[0]["text"]  # fake pipeline models answer instead


def test_manual_and_hybrid_sources(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    seen = {}
    real_run = pipeline.run

    async def spy(question, **kw):
        seen.update(kw)
        return await real_run(question, **kw)

    monkeypatch.setattr(pipeline, "run", spy)
    two = [{"source": "ChatGPT", "text": "Answer is 4."}, {"source": "Gemini", "text": "It is 4."}, {"source": "x", "text": "  "}]

    out = json.loads(android_entry.handle(json.dumps({"text": "2+2 kya hai?", "source": "manual", "answers": two})))
    assert seen["source"] == "manual" and len(seen["answers"]) == 2 and seen["use_guard"] is True
    assert any(s.startswith("Source: manual (2 yours") for s in out[0]["steps"])

    seen.clear()
    json.loads(android_entry.handle(json.dumps({"text": "2+2 kya hai?", "source": "hybrid", "answers": two})))
    assert seen["source"] == "hybrid"

    # auto ignores stray answers (the pipeline would reject them) and does not run the guard
    seen.clear()
    json.loads(android_entry.handle(json.dumps({"text": "2+2 kya hai?", "source": "auto", "answers": two})))
    assert seen["source"] == "auto" and seen["answers"] == [] and seen["use_guard"] is False


def test_manual_without_answers_is_refused_and_greeting_not_casual(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    out = json.loads(android_entry.handle(json.dumps({"text": "hello", "source": "manual", "answers": []})))
    assert "pasted answer" in out["text"]


# ---------------------------------------------------------------- explain style, reply prefs, falsifier notes

import prompts  # noqa: E402

POPPER_TEXT = (
    "A. CONFLICTS: none.\n"
    "B. CONSENSUS: Edge case: the 'discovered vs invented' split is a philosophical stance, not a fact.\n"
    "C. TESTABLE: claims Python can check: none.\n"
    "D. TRAP: treating the school curriculum list as the definition of mathematics."
)
EXPLAIN_TEXT = (
    "### Short answer\nMath studies structures. [REASONED]\n"
    "### Explanation\nStart from axioms. [PROVEN by code]\n"
    "### Common mistake\nConfusing curriculum with the subject. [UNVERIFIED]"
)


@pytest.fixture
def spy_models(monkeypatch):
    """Fake models that answer by prompt type and record every system/user prompt."""
    seen = {"panel": [], "popper": [], "judge": [], "verifier": 0, "audit": [], "revise": [], "repair": [],
            "audit_reply": json.dumps({"issues": []}), "revised_text": None}

    async def fake_chat(client, spec, messages, **kw):
        user = messages[-1]["content"]
        system = messages[0]["content"]
        if spec is config.CLASSIFIER:
            return "math"  # a trap: 'math' appears in the question but it is a concept question
        if spec is config.STRIPPER:
            return json.dumps({"claims": {"A": ["x"]}, "consensus": ["x"], "conflicts": []})
        if "Popperian falsifier" in user:
            seen["popper"].append(user)
            return POPPER_TEXT
        if "final editor of an explanation" in user:
            seen["judge"].append(user)
            return EXPLAIN_TEXT
        if "You are the final judge" in user:
            seen["judge"].append(user)
            return JUDGE_TEXT
        if "hostile, precise fact-checker" in system:
            seen["audit"].append(user)
            return seen["audit_reply"]
        if "Corrections to apply" in user:
            seen["revise"].append(user)
            return seen["revised_text"] or EXPLAIN_TEXT
        if user.startswith("Format error:"):
            seen["repair"].append(spec.label)
            return EXPLAIN_TEXT
        if "verification scripts" in system:
            seen["verifier"] += 1
            return "NO_CHECKS"
        seen["panel"].append(system)
        return "draft answer"

    monkeypatch.setattr(pipeline, "chat", fake_chat)
    monkeypatch.setattr(verified, "chat", fake_chat)
    return seen


@pytest.mark.parametrize(
    "q,task,expected",
    [
        ("What is math", "math", "explain"),
        ("math kya hai", "math", "explain"),
        ("Explain recursion", "coding", "explain"),
        ("What is a closure in JavaScript", "coding", "explain"),
        ("Why is the sky blue?", "science", "explain"),
        ("2+2 kya hai?", "math", "solve"),
        ("A 2 kg block slides down a 30 degree incline, mu=0.2, find acceleration", "science", "solve"),
        ("Prove that sqrt 2 is irrational", "math", "solve"),
        ("Write a function to reverse a list", "coding", "solve"),
        ("What is 15% of 240?", "math", "solve"),
        ("Is zero even?", "math", "solve"),
        ("Should I start a bakery?", "business", "explain"),
        # only the question counts, numbers in the appended chat context do not
        ("What is math\n\n[Earlier in this chat, context only]\nUser: 2+2=4 and 5*6=30", "math", "explain"),
    ],
)
def test_answer_style(q, task, expected):
    assert prompts.answer_style(q, task) == expected


def test_explain_flow_no_proofs_no_tags_and_notes(spy_models):
    res = asyncio.run(pipeline.run("What is math", deep=False, run_code=True, use_guard=False))
    assert res["style"] == "explain" and res["engine"] == "verified"
    assert "### Short answer" in res["answer"]
    assert not any(t in res["answer"] for t in ("[REASONED]", "[PROVEN", "[UNVERIFIED]"))
    assert spy_models["verifier"] == 0  # no code-writer call for a concept question
    assert "Direct Core Truth" not in spy_models["judge"][0]
    notes = res["falsifier_notes"]
    assert notes and "curriculum" in notes[0]["text"] and "TESTABLE" not in notes[0]["text"]
    assert res.get("proofs_summary", {}).get("total", 0) == 0


def test_solve_flow_keeps_old_format(spy_models):
    res = asyncio.run(pipeline.run("2+2 kya hai?", deep=False, run_code=True, use_guard=False))
    assert res["style"] == "solve" and "Direct Core Truth" in res["answer"]
    assert spy_models["verifier"] == 1  # math + solve still asks for code proofs


def test_explain_style_can_be_disabled(spy_models, monkeypatch):
    monkeypatch.setattr(config, "EXPLAIN_STYLE", False)
    res = asyncio.run(pipeline.run("What is math", deep=False, run_code=False, use_guard=False))
    assert res["style"] == "solve" and "Direct Core Truth" in res["answer"]


def test_reply_language_and_depth_reach_the_right_prompts(spy_models):
    asyncio.run(
        pipeline.run("What is math", deep=False, run_code=False, use_guard=False, reply_lang="hinglish", depth="simple")
    )
    assert all("Hinglish" in s and "Keep it simple" in s for s in spy_models["panel"])
    assert all("Hinglish" in u and "Keep it simple" not in u for u in spy_models["popper"])  # falsifiers: language only
    assert "Hinglish" in spy_models["judge"][0] and "Keep it simple" in spy_models["judge"][0]

    spy_models["panel"].clear()
    asyncio.run(pipeline.run("What is math", deep=False, run_code=False, use_guard=False, reply_lang="english", depth="detailed"))
    assert all("simple, clear English" in s and "worked example" in s for s in spy_models["panel"])


def test_adapter_passes_prefs_and_returns_notes(spy_models, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    body = {"text": "What is math", "reply": {"lang": "hinglish", "depth": "simple"}}
    out = json.loads(android_entry.handle(json.dumps(body)))
    assert "### Short answer" in out[0]["text"]
    assert out[0]["notes"]["title"] == "Kahan galat ho sakta hai" and out[0]["notes"]["items"]
    assert out[0]["steps"][0].endswith("· explain")
    assert "Python code proofs are off" not in out[0]["text"]  # not shown for explanations
    assert all("Hinglish" in s for s in spy_models["panel"])
    # junk prefs fall back to defaults instead of breaking the request
    spy_models["panel"].clear()
    json.loads(android_entry.handle(json.dumps({"text": "What is math", "reply": {"lang": "klingon", "depth": 5}})))
    assert not any("Keep it simple" in s for s in spy_models["panel"])


def test_falsifier_notes_trim_and_section_c():
    long = "A. x\nB. " + ("word " * 600) + "\nC. TESTABLE: a\nmore c\nD. TRAP: t"
    n = verified.falsifier_notes({"Falsifier 1": long}, limit=300)
    assert len(n[0]["text"]) <= 305 and n[0]["text"].endswith("…")
    n2 = verified.falsifier_notes({"Falsifier 1": "A. one\nC. TESTABLE: py\nD. TRAP: two"})
    assert "TESTABLE" not in n2[0]["text"] and "TRAP: two" in n2[0]["text"]
    assert verified.falsifier_notes({}) == []


# ---------------------------------------------------------------- repair loop + audit/revise
# These use FAKE models: they test the mechanism (what is asked, what is shown), not whether a real
# auditor model would catch a given mistake.

BROKEN = "Mathematics is a formal discipline. It has axioms and theorems."  # the judge dropped every heading
GOOD = "### Short answer\nMath studies structures.\n### Explanation\nStart from axioms.\n### Common mistake\nConfusing curriculum with the subject."
WITH_ERRORS = (
    "### Short answer\nA transformer decodes fast. KV-cache makes per-step compute O(1).\n"
    "### Explanation\nThe base model has about 100M parameters. FlashAttention reduces FLOPs of attention. "
    "Proof here is always exact, and zero-knowledge proofs are proofs too.\n"
    "### Common mistake\nConfusing speed with memory."
)
FIXED = (
    "### Short answer\nA transformer decodes fast. With a KV-cache the per-step compute is O(t·d).\n"
    "### Explanation\nThe base model has 65M parameters. FlashAttention is IO-aware and keeps the same FLOPs. "
    "Classical proofs give absolute certainty, ZKPs give probabilistic certainty.\n"
    "### Common mistake\nConfusing speed with memory."
)
AUDIT_ISSUES = json.dumps({"issues": [
    {"quote": "KV-cache makes per-step compute O(1)", "problem": "Q still attends to all t cached keys",
     "fix": "per-step compute is O(t·d), linear in sequence length", "confidence": "high"},
    {"quote": "FlashAttention reduces FLOPs of attention", "problem": "it is exact attention, only IO-aware",
     "fix": "FlashAttention keeps O(n^2) FLOPs and cuts memory traffic", "confidence": "medium"},
    {"quote": "a sentence the answer never contained", "problem": "invented", "fix": "n/a", "confidence": "high"},
    {"quote": "about 100M parameters", "problem": "base model has 65M", "fix": "65M (big model: 213M)", "confidence": "low"},
]})


@pytest.fixture
def scripted(monkeypatch):
    s = {"judge_replies": [], "repair_replies": [], "revise_replies": [], "audit_reply": json.dumps({"issues": []}),
         "repair_labels": [], "audit": [], "revise": []}

    async def fake_chat(client, spec, messages, **kw):
        user, system = messages[-1]["content"], messages[0]["content"]
        if spec is config.CLASSIFIER:
            return "general"
        if spec is config.STRIPPER:
            return json.dumps({"claims": {"A": ["x"]}, "consensus": ["x"], "conflicts": []})
        if "Popperian falsifier" in user:
            return POPPER_TEXT
        if user.startswith("Format error:"):  # a repair, also when it continues a revise conversation
            s["repair_labels"].append(spec.label)
            return s["repair_replies"].pop(0)
        if "Corrections to apply" in user:
            s["revise"].append(user)
            return s["revise_replies"].pop(0)
        if "hostile, precise fact-checker" in system:
            s["audit"].append(user)
            if isinstance(s["audit_reply"], Exception):
                raise s["audit_reply"]
            return s["audit_reply"]
        if "final editor of an explanation" in user or "You are the final judge" in user:
            return s["judge_replies"].pop(0)
        return "draft answer"

    monkeypatch.setattr(pipeline, "chat", fake_chat)
    monkeypatch.setattr(verified, "chat", fake_chat)
    return s


def _ask(q="What is math"):
    return asyncio.run(pipeline.run(q, deep=False, run_code=False, use_guard=False))


def test_repair_fixes_missing_sections_before_user_sees_it(scripted):
    scripted["judge_replies"], scripted["repair_replies"] = [BROKEN], [GOOD]
    res = _ask()
    assert "### Short answer" in res["answer"] and res["repairs"] == 1
    assert not any("missing" in w for w in res.get("warnings", []))
    assert scripted["repair_labels"] == [config.SYNTHESIZER.label]


def test_second_repair_attempt_uses_a_different_model(scripted):
    scripted["judge_replies"], scripted["repair_replies"] = [BROKEN], [BROKEN, GOOD]
    res = _ask()
    assert res["repairs"] == 2 and "### Explanation" in res["answer"]
    assert scripted["repair_labels"] == [config.SYNTHESIZER.label, config.SYNTHESIZER.fallbacks[0]]


def test_format_that_cannot_be_repaired_is_flagged_and_not_audited(scripted):
    scripted["judge_replies"], scripted["repair_replies"] = [BROKEN], [BROKEN, BROKEN]
    res = _ask()
    assert res["repairs"] == 2
    assert any("Format check failed after 2 repair attempt(s)" in w for w in res["warnings"])
    assert not any(w.startswith("Final answer is missing") for w in res["warnings"])
    assert scripted["audit"] == []  # no point fact-checking text that is not in the required shape


def test_missing_sections_check_is_whitespace_tolerant():
    assert verified.missing_sections("### Short   answer\n### Explanation\n### Common\nmistake", "explain") == []
    assert verified.missing_sections("Direct Core Truth\nVerified Mechanism", "solve") == ["Trap Warning"]


def test_audit_applies_high_and_medium_fixes_and_keeps_the_rest_as_doubts(scripted):
    scripted["judge_replies"], scripted["revise_replies"] = [WITH_ERRORS], [FIXED]
    scripted["audit_reply"] = AUDIT_ISSUES
    res = _ask()
    assert "O(t·d)" in res["answer"] and "65M" in res["answer"] and "O(1)" not in res["answer"]
    json.dumps(res)  # /ask returns this dict as JSON
    audit = res["audit"]
    assert audit["ran"] and len(audit["applied"]) == 2
    # the invented quote was capped to low (not found in the answer), the explicit low one stays low
    assert {i["quote"] for i in audit["unsure"]} == {"a sentence the answer never contained", "about 100M parameters"}
    assert all(i["confidence"] == "low" for i in audit["unsure"])
    # only the two real findings reached the rewrite prompt
    assert "O(t·d)" in scripted["revise"][0] and "memory traffic" in scripted["revise"][0]
    assert "never contained" not in scripted["revise"][0] and "65M" not in scripted["revise"][0]
    # the auditor only sees the question and the final answer, not drafts or claims
    assert "Atomic claims" not in scripted["audit"][0] and "KV-cache makes per-step" in scripted["audit"][0]


def test_a_rewrite_that_loses_its_sections_is_discarded(scripted):
    scripted["judge_replies"] = [WITH_ERRORS]
    scripted["revise_replies"], scripted["repair_replies"] = [BROKEN], [BROKEN, BROKEN]
    scripted["audit_reply"] = AUDIT_ISSUES
    res = _ask()
    assert res["answer"] == WITH_ERRORS  # never worse than before the audit
    assert res["audit"]["applied"] == [] and len(res["audit"]["unsure"]) == 4
    assert not any("Format check failed" in w for w in res.get("warnings", []))
    assert res["repairs"] == 0


def test_audit_failures_do_not_break_the_answer(scripted, monkeypatch):
    scripted["judge_replies"] = [GOOD]
    scripted["audit_reply"] = llm.LLMError("auditor down")
    res = _ask()
    assert res["answer"] == GOOD and res["audit"]["enabled"] and not res["audit"]["ran"]

    scripted["judge_replies"], scripted["audit_reply"] = [GOOD], "not json at all"
    res = _ask()
    assert res["answer"] == GOOD and not res["audit"]["ran"]


def test_audit_can_be_switched_off(scripted, monkeypatch):
    monkeypatch.setattr(config, "AUDIT_ENABLED", False)
    scripted["judge_replies"] = [GOOD]
    res = _ask()
    assert scripted["audit"] == [] and res["audit"]["enabled"] is False and res["answer"] == GOOD


def test_adapter_shows_audit_repairs_and_doubts(scripted, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    scripted["judge_replies"], scripted["revise_replies"] = [BROKEN], [FIXED]
    scripted["repair_replies"] = [WITH_ERRORS]  # the repair of the judge answer produces the (wrong) full answer
    scripted["audit_reply"] = AUDIT_ISSUES
    out = json.loads(android_entry.handle(json.dumps({"text": "What is math"})))
    steps = out[0]["steps"]
    assert "Format repair x1" in steps and "Audit: 2 sudhar, 2 shak" in steps
    items = out[0]["notes"]["items"]
    assert items[0]["title"] == "Audit ne sudhara (2)" and "→" in items[0]["text"] and "O(t·d)" in items[0]["text"]
    assert items[1]["title"] == "Audit ko shak hai, khud check karo" and "shayad sahi" in items[1]["text"]
    assert items[2]["title"] == "Checker 1"  # falsifier notes follow the audit
    assert "O(t·d)" in out[0]["text"]


def test_rotated_chain_starts_on_another_model_and_keeps_all():
    r = config.rotated(config.SYNTHESIZER)
    assert r.label == config.SYNTHESIZER.fallbacks[0] and r.label != config.SYNTHESIZER.label
    chain = [c.label for c in config.chain_of(r)]
    assert config.SYNTHESIZER.label in chain and len(set(chain)) == len(chain)
    assert config.PLAN_PROBLEMS == [] and "auditor" in dict(config.all_roles())
    assert config.AUDITOR.provider != config.SYNTHESIZER.provider  # not the judge's family


def test_prompts_carry_the_new_rules():
    judge = prompts.judge_messages("q", "m", "f", "p", "lang")[1]["content"]
    explain = prompts.judge_explain_messages("q", "m", "f", "lang")[1]["content"]
    popper = prompts.popper_messages("q", "m", "lang")[1]["content"]
    for text in (judge, explain):
        assert "Avoid absolutes" in text and "stay in English" in text
    assert "RED FLAGS" in popper and "compute (FLOPs), memory and IO" in popper
    audit = prompts.audit_messages("q", "a", "lang")[1]["content"]
    for must in ("Wrong exact figures", "Complexity and cost claims", "Absolutes", "Category errors", "limitation"):
        assert must in audit


# ---------------------------------------------------------------- new providers, pattern finder, council record
def test_cloudflare_needs_token_and_account_id(monkeypatch):
    p = config.PROVIDERS["cloudflare"]
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    assert p.api_key == ""
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "cf_token_123456")
    assert p.api_key == ""  # account id still missing: provider is skipped, never called with a broken URL
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "abc123")
    assert p.api_key == "cf_token_123456"
    assert p.url == "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1"
    assert config.PROVIDERS["nvidia"].url == "https://integrate.api.nvidia.com/v1"
    for name in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "NVIDIA_API_KEY"):
        assert name in android_entry.KEY_NAMES and name in config.SECRET_ENVS


def test_new_models_registered_and_chat_models_only():
    for label in ("gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "cf-gpt-oss-120b", "cf-gemma-4-26b",
                  "mistral-large-4", "laguna-xs-2.1", "glm-5-3-flash", "inkling-2-small"):
        assert label in config.REGISTRY, label
    assert not any("bge" in m.model for m in config.REGISTRY.values())  # embedding model is not a chat model


def test_pattern_finder_is_last_panel_member_and_off_in_fast_mode():
    assert config.PANEL[-1].role == "pattern_finder" and len(config.PANEL) == 7
    assert "pattern_finder" not in [s.role for s in config.PANEL[:3]]
    assert "PATTERN:" in __import__("prompts").ROLES["pattern_finder"]


def test_llm_chat_records_stage_prompt_output_and_skips(monkeypatch):
    import health

    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    health.reset()

    class R:
        status_code, headers, text = 200, {}, ""

        def json(self):
            return {"choices": [{"message": {"content": "hello"}}], "usage": {"total_tokens": 5}}

    class C:
        async def post(self, *a, **k):
            return R()

    async def go():
        trace = health.start_trace(True)
        health.set_stage("panel:logic_math")
        out = await llm.chat(C(), config.PANEL[0], [{"role": "user", "content": "q?"}])
        return out, trace

    out, trace = asyncio.run(go())
    e = trace[0]
    assert out == "hello" and e["stage"] == "panel:logic_math" and e["ok"] and e["used"] == config.PANEL[0].label
    assert e["prompt"][0]["content"] == "q?" and e["output"] == "hello" and "secs" in e
    assert "skips" not in e  # first model answered: nothing was skipped

    async def light():
        trace = health.start_trace(False)
        await llm.chat(C(), config.PANEL[0], [{"role": "user", "content": "q?"}])
        return trace

    assert "prompt" not in asyncio.run(light())[0]  # recording is opt-in (it is large)


def test_council_record_is_built_and_sent_to_the_ui(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")
    out = json.loads(android_entry.handle(json.dumps({"text": "2+2 kya hai?"})))
    c = out[0]["council"]
    assert c["v"] == 1 and c["setup"]["task"] == "math" and c["final"].strip().startswith("1. Direct Core Truth")
    assert c["question"].startswith("2+2") and {"calls", "drafts", "falsifiers", "audit", "provenance", "patterns"} <= set(c)
    assert all(d["text"] for d in c["drafts"])
    # without record=True nothing is built
    res = asyncio.run(pipeline.run("2+2 kya hai?", run_code=False, use_guard=False))
    assert "council" not in res


def test_provenance_marks_kept_and_dropped_sentences():
    import council

    final = "Attention cost grows quadratically with sequence length because every token attends to every other token."
    drafts = {
        "A": "Attention cost grows quadratically with sequence length because every token attends to every other token. Extra.",
        "B": "A completely different sentence about banana farming economics in tropical regions near the equator.",
    }
    p = council.provenance(final, drafts)
    assert p["final_sentences"][0]["from"] == "A" and p["final_sentences"][0]["score"] >= 0.9
    assert "B" in p["dropped"] and "A" not in p["dropped"]


def test_patterns_reads_named_pattern_and_warns_on_total_agreement():
    import council

    drafts = {"pattern_finder": "PATTERN: Pigeonhole principle\nbody", "a": "x", "b": "y"}
    cm = {"claims": {}, "consensus": ["same thing"], "conflicts": []}
    p = council.patterns(drafts, cm)
    assert p["named"] == "Pigeonhole principle" and p["warning"] and p["shared"] == ["same thing"]


def test_council_record_is_size_capped_and_prompts_marked_when_cut(monkeypatch):
    import council
    import health

    big = "x" * 40000
    rec = {"calls": [{"stage": "judge", "prompt": [{"role": "user", "content": big}]} for _ in range(12)], "final": "ok"}
    out = council._fit(rec)
    assert out.get("trimmed") and all(len(m["content"]) < 3200 for c in out["calls"] for m in c["prompt"])
    assert out["final"] == "ok"  # outputs / analysis are never cut
    assert "kaata gaya" in health._cut(big, 100) and health._cut("short", 100) == "short"
