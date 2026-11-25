"""Shared test setup for default non-networked check-postpasses and provider streaming.
Tests opt into those paths only where they supply a fake transport/model.
"""
import os
import sys
import pytest
os.environ.setdefault("CHECKS_POSTPASS", "0")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
@pytest.fixture(autouse=True)
def _plain_post_by_default(monkeypatch):
    import config  # imported here, not at collection time: test modules set env vars before importing config
    monkeypatch.setattr(config, "STREAM_PROVIDERS", frozenset())
    yield


@pytest.fixture(autouse=True)
def _sources_offline(monkeypatch):
    """Unit tests must never depend on the network: the source layer returns nothing unless a test asks for it.
    tests/test_sources_pdf.py calls sources.collect()/gather() directly, which this fixture does not patch."""
    import sources

    async def _nothing(text):
        return "", []

    async def _no_rows(text, **kw):
        return []

    monkeypatch.setattr(sources, "gather", _nothing)
    monkeypatch.setattr(sources, "collect", _no_rows)
    yield
