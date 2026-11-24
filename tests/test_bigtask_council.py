"""Big input in a council mode: one council run, a heading per sub-topic, long answers as Part 1/N ... (faked models)."""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["USAGE_FILE"] = os.path.join(os.path.dirname(__file__), ".usage-test.json")

import bigtask  # noqa: E402
import chat_adapter  # noqa: E402
import config  # noqa: E402
from tests.test_roles import GOOD, run, script  # noqa: E402,F401

TOPICS = [{"title": t, "ask": f"explain {t}", "context": ""} for t in
          ("Newton laws", "Friction", "Circular motion", "Gravitation", "Work energy")]
P1 = "**Part 1/2**\n## 1. Newton laws\nF = ma [REASONED]\n## 2. Friction\nf = mu N\n## 3. Circular motion\na = v^2/r"
P2 = "## 4. Gravitation\nF = GMm/r^2 [S1]\n## 5. Work energy\nW = dK\n" + GOOD


def test_five_topics_become_two_judge_parts(script, monkeypatch):
    monkeypatch.setattr(bigtask, "PART_GAP_S", 0)
    script["judge"] = [P1, P2]
    seen = []
    token = config.PROGRESS.set(seen.append)  # live progress lines, as the chat UI receives them
    try:
        res = run(q="5 topics brief", topics=TOPICS)
    finally:
        config.PROGRESS.reset(token)
    assert script["calls"].count("judge") == 2 and "refiner" not in script["calls"]
    users = script["users"]["judge"]
    assert "Write ONLY Part 1/2" in users[0] and "1. Newton laws; 2. Friction; 3. Circular motion" in users[0]
    assert "Write ONLY Part 2/2" in users[1] and "4. Gravitation; 5. Work energy" in users[1]
    assert len(res["parts"]) == 2 and res["parts"][1].startswith("**Part 2/2**")
    assert res["answer"] == "\n\n".join(res["parts"]) and res["topics"][0] == "Newton laws"
    live = [json.loads(s[len(config.PART_TAG):]) for s in seen if isinstance(s, str) and s.startswith(config.PART_TAG)]
    assert [(e["n"], e["of"]) for e in live] == [(1, 2), (2, 2)]


def test_skipped_topic_gets_its_own_part(script, monkeypatch):
    monkeypatch.setattr(bigtask, "PART_GAP_S", 0)
    three = TOPICS[:3]
    script["judge"] = ["## 1. Newton laws\nx\n## 2. Friction\ny\n" + GOOD, "## 3. Circular motion\na = v^2/r"]
    res = run(q="3 topics", topics=three)
    assert script["calls"].count("judge") == 2
    assert "Write ONLY Part 2/2" in script["users"]["judge"][1] and "3. Circular motion" in script["users"]["judge"][1]
    assert res["parts"][0].startswith("**Part 1/2**") and "## 3. Circular motion" in res["parts"][1]


def test_small_topic_list_is_one_normal_answer(script):
    script["judge"] = ["## 1. Newton laws\nx\n## 2. Friction\ny\n" + GOOD]
    res = run(q="2 topics", topics=TOPICS[:2])
    assert script["calls"].count("judge") == 1 and not res.get("parts")


def test_adapter_splits_big_message_and_sends_parts(script, monkeypatch):
    monkeypatch.setattr(bigtask, "PART_GAP_S", 0)
    asks = []

    async def fake_decompose_chat(client, spec, messages, **kw):
        asks.append(messages[-1]["content"])
        k = len(asks)
        return json.dumps({"topics": [TOPICS[(k - 1) % 5] | {"facts": "given"}]})

    monkeypatch.setattr(bigtask, "chat", fake_decompose_chat)
    script["judge"] = [P1, P2]
    text = "\n\n".join(f"Topic {i}: " + "detail " * 700 for i in range(5))
    out = asyncio.run(chat_adapter.handle({"text": text, "mode": "physics"}))
    assert len(asks) == len(bigtask.split_chunks(text)) >= 5
    assert [r["part"] for r in out] == [{"n": 1, "of": 2}, {"n": 2, "of": 2}]
    assert out[0]["steps"] and out[0]["council"] and "notes" not in out[0]
    assert any("sub-topic" in s for s in out[0]["steps"])
    assert "**Sources**" in out[1]["text"] and out[1].get("notes")
    assert "Answer EVERY sub-topic" in script["users"]["architect"][0]


def test_standard_never_decomposes(monkeypatch):
    from tests.test_quick import _fake_standard
    calls = []

    async def boom(*a, **k):
        raise AssertionError("Standard must not split input")

    monkeypatch.setattr(bigtask, "chat", boom)
    monkeypatch.setattr(chat_adapter.standard_agent, "answer", _fake_standard(calls, "ok"))
    monkeypatch.setattr(chat_adapter, "QUICK_STANDARD", True)
    out = asyncio.run(chat_adapter.handle({"text": "Force kya hai? Mass kya hai? Energy kya hai? " * 10, "mode": "standard"}))
    assert len(calls) == 1 and "part" not in out[0]
