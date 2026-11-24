"""Big input detection, lossless chunking, sub-topic map (models faked)."""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")
import bigtask  # noqa: E402
from llm import LLMError  # noqa: E402


def _words(s):
    return s.split()


def test_is_big_by_length_and_by_questions():
    assert not bigtask.is_big("Newton ka pehla niyam kya hai?")
    assert bigtask.is_big("a " * 3100)
    assert bigtask.is_big("Force kya hai? Mass kya hai? Energy kya hai?")
    assert bigtask.is_big("1. friction\n2. gravity\n3. momentum")
    assert not bigtask.is_big("Force kya hai? Mass kya hai?")


def test_split_is_lossless_and_bounded():
    text = "\n\n".join(f"Paragraph {i}. " + "Sentence here is long enough. " * 40 for i in range(12))
    text += "\n\n" + "x" * 9000  # one giant unbreakable line
    chunks = bigtask.split_chunks(text, 3500)
    assert all(len(c) <= 3500 for c in chunks)
    assert "".join(_words("".join(chunks))).replace(" ", "") == "".join(_words(text)).replace(" ", "")


def test_decompose_uses_one_call_per_chunk_and_merges(monkeypatch):
    calls = []

    async def fake_chat(client, spec, messages, **kw):
        calls.append(spec.label)
        k = len(calls)
        return json.dumps({"topics": [{"title": "Friction" if k < 3 else f"Topic {k}", "ask": f"ask {k}", "facts": "mu=0.3"}]})

    monkeypatch.setattr(bigtask, "chat", fake_chat)
    text = "\n\n".join("Para. " + "words " * 600 for _ in range(4))
    topics = asyncio.run(bigtask.decompose(None, text))
    n = len(bigtask.split_chunks(text))
    assert len(calls) == n and n >= 3
    assert topics[0]["title"] == "Friction" and "ask 1" in topics[0]["ask"] and "ask 2" in topics[0]["ask"]


def test_decompose_falls_back_locally_when_models_fail(monkeypatch):
    async def fail(*a, **k):
        raise LLMError("all failed")

    monkeypatch.setattr(bigtask, "chat", fail)
    errors = {}
    topics = asyncio.run(bigtask.decompose(None, "Pehla topic\nbody\n\nDoosra topic\nbody", errors))
    assert topics and topics[0]["title"] == "Pehla topic" and "decompose:1" in errors


def test_merge_caps_topics():
    ts = [{"title": f"T{i}", "ask": "a", "context": "c"} for i in range(12)]
    out = bigtask.merge(ts, 8)
    assert len(out) == 8 and out[-1]["title"].startswith("Baaki points")


def test_brief_lists_every_topic_and_fits():
    topics = [{"title": f"T{i}", "ask": "explain", "context": "x=1"} for i in range(5)]
    b = bigtask.brief("long " * 5000, topics, 8000)
    assert len(b) <= 8000 and all(f"{i + 1}. T{i}" in b for i in range(5)) and "## k. title" in b
