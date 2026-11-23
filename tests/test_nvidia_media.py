import asyncio
import base64
import json
import threading
import time

import httpx
import pytest

import android_entry
import nvidia_media


class FakeResponse:
    def __init__(self, data=None, status_code=200, text="", body=None, headers=None):
        self.body = body if body is not None else (json.dumps(data).encode() if data is not None else text.encode())
        self.headers = headers if headers is not None else {"content-length": str(len(self.body))}
        self.status_code = status_code

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def aiter_bytes(self, chunk_size=65536):
        for start in range(0, len(self.body), chunk_size):
            yield self.body[start:start + chunk_size]


class FakeClient:
    def __init__(self, *, response, calls, **kwargs):
        self.response = response
        self.calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def stream(self, method, url, *, headers, json):
        self.calls.append((url, headers, json))
        return self.response


def install_fake_client(monkeypatch, response, calls):
    monkeypatch.setattr(
        nvidia_media.httpx,
        "AsyncClient",
        lambda **kwargs: FakeClient(response=response, calls=calls, **kwargs),
    )


def test_flux_request_stores_jpeg_by_opaque_id_not_base64(monkeypatch, tmp_path):
    jpeg = b"\xff\xd8\xff" + b"fake-jpeg-data"
    calls = []
    assert nvidia_media.FLUX_URL == "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux-3-image-klein"
    install_fake_client(monkeypatch, FakeResponse({"artifacts": [{"base64": base64.b64encode(jpeg).decode()}]}), calls)
    monkeypatch.setenv("NVIDIA_API_KEY", "test-nvidia-key")
    monkeypatch.setenv("GENERATED_MEDIA_DIR", str(tmp_path))

    result = asyncio.run(nvidia_media.generate({"kind": "image", "prompt": "A blue mountain at sunrise"}))

    assert calls[0][0] == nvidia_media.FLUX_URL
    assert calls[0][1]["Authorization"] == "Bearer test-nvidia-key"
    assert calls[0][2]["prompt"] == "A blue mountain at sunrise"
    assert calls[0][2]["height"] == calls[0][2]["width"] == 1024
    assert calls[0][2]["samples"] == 1
    assert result["type"] == "image" and result["mime"] == "image/jpeg"
    assert len(result["mediaId"]) == 32
    assert not any(key.lower().startswith("b64") or key == "base64" for key in result)
    assert (tmp_path / f"{result['mediaId']}.jpg").read_bytes() == jpeg


def test_cosmos3_video_request_is_bounded_and_stores_mp4(monkeypatch, tmp_path):
    mp4 = b"\x00\x00\x00\x18ftypisom" + b"safe-mp4"
    calls = []
    assert nvidia_media.COSMOS3_URL == "https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano"
    install_fake_client(monkeypatch, FakeResponse({"b64_video": base64.b64encode(mp4).decode()}), calls)
    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    monkeypatch.setenv("GENERATED_MEDIA_DIR", str(tmp_path))

    result = asyncio.run(nvidia_media.generate({"kind": "video", "prompt": "A small robot waves", "frames": 73}))

    assert calls[0][0] == nvidia_media.COSMOS3_URL
    assert calls[0][2] == {
        "model_mode": "text2video",
        "prompt": "A small robot waves",
        "resolution": "480_16_9",
        "num_frames": 73,
        "num_inference_steps": 35,
        "fps": 24,
        "seed": 0,
    }
    assert result["type"] == "video" and result["mime"] == "video/mp4"
    assert result["frames"] == 73
    assert (tmp_path / f"{result['mediaId']}.mp4").read_bytes() == mp4


def test_media_rejects_missing_key_invalid_frames_and_invalid_image_payload(monkeypatch, tmp_path):
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    with pytest.raises(nvidia_media.MediaError, match="API key"):
        asyncio.run(nvidia_media.generate({"kind": "image", "prompt": "A tree"}))

    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    with pytest.raises(nvidia_media.MediaError, match="duration"):
        asyncio.run(nvidia_media.generate({"kind": "video", "prompt": "A tree", "frames": 900}))

    calls = []
    install_fake_client(monkeypatch, FakeResponse({"artifacts": [{"base64": "not-base64"}]}), calls)
    monkeypatch.setenv("GENERATED_MEDIA_DIR", str(tmp_path))
    with pytest.raises(nvidia_media.MediaError, match="base64"):
        asyncio.run(nvidia_media.generate({"kind": "image", "prompt": "A tree"}))
    assert list(tmp_path.iterdir()) == []


def test_provider_response_is_rejected_during_streaming_before_json_parse(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(nvidia_media, "MAX_RESPONSE_BYTES", 16)
    install_fake_client(monkeypatch, FakeResponse(body=b"x" * 17, headers={}), calls)
    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    monkeypatch.setenv("GENERATED_MEDIA_DIR", str(tmp_path))

    with pytest.raises(nvidia_media.MediaError, match="safely process"):
        asyncio.run(nvidia_media.generate({"kind": "image", "prompt": "A tree"}))
    assert list(tmp_path.iterdir()) == []


def test_media_timeout_is_reported_as_a_retryable_error(monkeypatch):
    class TimeoutClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def stream(self, *args, **kwargs):
            raise httpx.ReadTimeout("provider stalled")

    monkeypatch.setattr(nvidia_media.httpx, "AsyncClient", TimeoutClient)
    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    with pytest.raises(nvidia_media.MediaError, match="timeout"):
        asyncio.run(nvidia_media.generate({"kind": "image", "prompt": "A tree"}))


def test_android_media_dispatch_can_be_cancelled_without_chat_model_routing(monkeypatch):
    entered = threading.Event()
    result = {}
    request_id = "nvidia-media-cancel-test"

    async def slow_generate(request):
        entered.set()
        await asyncio.sleep(60)

    monkeypatch.setattr(nvidia_media, "generate", slow_generate)
    payload = json.dumps({"media": {"kind": "video", "prompt": "Long clip", "frames": 121}})
    worker = threading.Thread(target=lambda: result.setdefault("json", android_entry.handle(payload, request_id=request_id)))
    worker.start()
    assert entered.wait(5), "media request should reach dedicated generator"
    deadline = time.monotonic() + 5
    while request_id not in android_entry._running and time.monotonic() < deadline:
        time.sleep(0.01)
    android_entry.cancel(request_id)
    worker.join(5)

    assert not worker.is_alive()
    reply = json.loads(result["json"])
    assert reply["type"] == "text"
    assert "Generation rok di gayi" in reply["text"]
