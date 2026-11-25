import app_context


def test_local_memories_and_project_history_only_leave_device_when_opted_in():
    body = {
        "access": {"localRead": True, "personalOnline": True},
        "app_context": {"records": [
            {"kind": "memory", "text": "Sir prefers Hinglish and structured explanations."},
            {"kind": "project", "name": "Robot arm", "concepts": ["Torque"],
             "versions": [{"version": i, "learned": f"Torque concept v{i}"} for i in range(1, 5)]},
            {"kind": "memory", "text": "Unrelated gardening note."},
        ]},
    }
    text = app_context.context(body, "Explain torque in Hinglish for my robot arm")
    assert "Sir prefers Hinglish" in text
    assert '"name": "Robot arm"' in text
    assert '"version": 2' in text and '"version": 4' in text
    assert "Unrelated gardening" not in text

    body["access"]["personalOnline"] = False
    assert app_context.context(body, "Explain torque in Hinglish for my robot arm") == ""


def test_unrelated_prompt_does_not_receive_personal_context():
    body = {
        "access": {"localRead": True, "personalOnline": True},
        "app_context": {"records": [{"kind": "memory", "text": "I prefer Hinglish explanations"}]},
    }
    assert app_context.context(body, "What is the capital of France?") == ""


def test_project_record_is_bounded_and_secrets_redacted():
    record = app_context.clean_record({
        "kind": "project", "name": "Robot arm", "concepts": ["Torque", "password: hidden"],
        "versions": [{"version": i, "learned": "api_key: hidden"} for i in range(1, 8)],
        "arbitrary": "must not pass",
    })
    assert record is not None
    assert len(record["versions"]) == 3
    assert record["concepts"] == ["Torque", "[redacted]"]
    assert all(v["learned"] == "[redacted]" for v in record["versions"])
    assert "arbitrary" not in record
