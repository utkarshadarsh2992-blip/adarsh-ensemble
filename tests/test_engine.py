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
def fake_models(monkeypatch):
    calls = []

    async def fake_chat(client, spec, messages, **kw):
        calls.append(spec.label)
        sys_text = messages[0]["content"] if messages else ""
        if spec is config.CLASSIFIER:
            return "math"
        if spec is config.STRIPPER:
            return json.dumps({"claims": []})
        return JUDGE_TEXT

    monkeypatch.setattr(pipeline, "chat", fake_chat)
    monkeypatch.setattr(verified, "chat", fake_chat)
    return calls


def test_provider_config_valid():
    assert config.PLAN_PROBLEMS == []
    assert set(config.PROVIDERS) == {"groq", "gemini", "openrouter"}


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

    async def quick(client, spec, messages, **kw):
        return "Hello! Kaise ho?"

    monkeypatch.setattr(pipeline, "run", no_pipeline)
    monkeypatch.setattr(chat_adapter, "chat", quick)
    for greeting in ("Hlo", "hello!", "Namaste", "thanks"):
        out = json.loads(android_entry.handle(json.dumps({"text": greeting})))
        assert out[0]["text"] == "Hello! Kaise ho?" and not ran
    assert not chat_adapter._is_casual("2+2 kya hai?")
    assert not chat_adapter._is_casual("explain photosynthesis")


def test_casual_failure_falls_back_to_pipeline(monkeypatch):
    import chat_adapter

    monkeypatch.setenv("GROQ_API_KEY", "gsk_test_123456")

    async def down(*a, **k):
        raise llm.LLMError("down")

    monkeypatch.setattr(chat_adapter, "chat", down)
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
    seen = {"panel": [], "popper": [], "judge": [], "verifier": 0}

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
