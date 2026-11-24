"""Shared test setup.

Most tests fake model calls with a `post` method (or patch httpx.AsyncClient.post). The streaming path that llm.py uses
for slow providers (config.STREAM_PROVIDERS, via client.stream) would bypass those fakes, so it is switched off here
for every test; tests/test_network_resilience.py switches it back on and tests it with httpx.MockTransport.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture(autouse=True)
def _plain_post_by_default(monkeypatch):
    import config  # imported here, not at collection time: test modules set their env vars before importing config

    monkeypatch.setattr(config, "STREAM_PROVIDERS", frozenset())
    yield
