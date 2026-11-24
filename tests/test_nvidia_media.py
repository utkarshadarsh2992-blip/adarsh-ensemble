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


def install_sequence_client(monkeypatch, responses, calls):
    queue = list(responses)

    class SequenceClient(FakeClient):
        def stream(self, method, url, *, headers, json):
            self.calls.append((url, headers, json))
            return queue.pop(0)

    monkeypatch.setattr(
        nvidia_media.httpx,
        "AsyncClient",
        lambda **kwargs: SequenceClient(response=None, calls=calls, **kwargs),
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
    assert calls[0][2]["mode"] == "t2i"
    assert "seed" not in calls[0][2]
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
    assert calls[0][1]["NVCF-POLL-SECONDS"] == "300"
    assert len(calls) == 1


def test_cosmos3_gateway_404_retries_once_on_function_invocation_route(monkeypatch, tmp_path):
    mp4 = b"\x00\x00\x00\x18ftypisom" + b"fallback-mp4"
    calls = []
    assert nvidia_media.COSMOS3_FALLBACK_URL == (
        "https://d09cd49d-d7f2-4361-928f-ea22af707249.invocation.api.nvcf.nvidia.com/v1/infer"
    )
    install_sequence_client(
        monkeypatch,
        [
            FakeResponse(status_code=404, text="404 page not found"),
            FakeResponse({"b64_video": base64.b64encode(mp4).decode(), "action": None}),
        ],
        calls,
    )
    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    monkeypatch.setenv("GENERATED_MEDIA_DIR", str(tmp_path))

    result = asyncio.run(nvidia_media.generate({"kind": "video", "prompt": "A dog runs", "frames": 25}))

    assert [call[0] for call in calls] == [nvidia_media.COSMOS3_URL, nvidia_media.COSMOS3_FALLBACK_URL]
    assert calls[0][2] == calls[1][2]
    assert calls[1][1]["Authorization"] == "Bearer key"
    assert (tmp_path / f"{result['mediaId']}.mp4").read_bytes() == mp4


@pytest.mark.parametrize("status", [401, 403, 422, 500])
def test_cosmos3_non_404_errors_do_not_try_backup_route(monkeypatch, status):
    calls = []
    install_sequence_client(monkeypatch, [FakeResponse({"detail": "provider said no"}, status_code=status)], calls)
    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    with pytest.raises(nvidia_media.MediaError, match=f"HTTP {status}"):
        asyncio.run(nvidia_media.generate({"kind": "video", "prompt": "A dog runs", "frames": 25}))
    assert [call[0] for call in calls] == [nvidia_media.COSMOS3_URL]


def test_cosmos3_reports_backup_error_when_both_routes_fail(monkeypatch):
    calls = []
    install_sequence_client(
        monkeypatch,
        [
            FakeResponse(status_code=404, text="404 page not found"),
            FakeResponse({"detail": "Unauthorized access"}, status_code=403),
            FakeResponse({"detail": "Function 'x': Not found for account 'secret-key'"}, status_code=404),
        ],
        calls,
    )
    monkeypatch.setenv("NVIDIA_API_KEY", "secret-key")
    with pytest.raises(nvidia_media.MediaError) as exc_info:
        asyncio.run(nvidia_media.generate({"kind": "video", "prompt": "A dog runs", "frames": 25}))
    message = str(exc_info.value)
    assert "public route HTTP 404" in message and "backup NVCF route" in message and "HTTP 403" in message
    assert "Cosmos 1.0 backup" in message and "help@build.nvidia.com" in message
    assert "secret-key" not in message
    assert [call[0] for call in calls] == [nvidia_media.COSMOS3_URL, nvidia_media.COSMOS3_FALLBACK_URL,
                                           nvidia_media.COSMOS1_URL]


def _zip_with(name, data):
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("meta.json", "{}")
        archive.writestr(name, data)
    return buf.getvalue()


def test_cosmos1_backup_polls_the_nvcf_queue_and_unzips_the_mp4(monkeypatch, tmp_path):
    mp4 = b"\x00\x00\x00\x18ftypisom" + b"cosmos1-mp4"
    calls = []
    install_sequence_client(
        monkeypatch,
        [
            FakeResponse(status_code=404, text="404 page not found"),
            FakeResponse({"detail": "Function 'd09cd49d': Not found for account 'abc'"}, status_code=404),
            FakeResponse(status_code=202, body=b"", headers={"nvcf-reqid": "11111111-2222-3333-4444-555555555555"}),
            FakeResponse(body=_zip_with("output/video.mp4", mp4), headers={"content-type": "application/zip"}),
        ],
        calls,
    )
    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    monkeypatch.setenv("GENERATED_MEDIA_DIR", str(tmp_path))

    result = asyncio.run(nvidia_media.generate({"kind": "video", "prompt": 'A "red" car drives', "frames": 49}))

    assert [call[0] for call in calls] == [
        nvidia_media.COSMOS3_URL, nvidia_media.COSMOS3_FALLBACK_URL, nvidia_media.COSMOS1_URL,
        nvidia_media.NVCF_STATUS_URL + "11111111-2222-3333-4444-555555555555"]
    command = calls[2][2]["inputs"][0]["data"][0]
    assert command == "text2world --prompt=\"A 'red' car drives\""
    assert calls[3][1]["Authorization"] == "Bearer key" and calls[3][2] is None
    assert result["frames"] == 121 and result["model"] == "cosmos-1.0-7b-text2world"
    assert (tmp_path / f"{result['mediaId']}.mp4").read_bytes() == mp4


def test_cosmos1_result_link_is_downloaded_without_the_api_key(monkeypatch, tmp_path):
    mp4 = b"\x00\x00\x00\x18ftypisom" + b"linked"
    calls = []
    install_sequence_client(
        monkeypatch,
        [
            FakeResponse(status_code=404, text="404 page not found"),
            FakeResponse({"detail": "Not found for account"}, status_code=404),
            FakeResponse(status_code=302, body=b"", headers={"location": "https://assets.ngc.nvidia.com/r.zip"}),
            FakeResponse(body=_zip_with("video.mp4", mp4)),
        ],
        calls,
    )
    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    monkeypatch.setenv("GENERATED_MEDIA_DIR", str(tmp_path))
    result = asyncio.run(nvidia_media.generate({"kind": "video", "prompt": "A cat", "frames": 25}))
    assert calls[3][0] == "https://assets.ngc.nvidia.com/r.zip"
    assert "Authorization" not in calls[3][1]
    assert (tmp_path / f"{result['mediaId']}.mp4").read_bytes() == mp4


def test_cosmos1_rejects_plain_http_result_links(monkeypatch):
    calls = []
    install_sequence_client(
        monkeypatch,
        [
            FakeResponse(status_code=404, text="404 page not found"),
            FakeResponse({"detail": "Not found for account"}, status_code=404),
            FakeResponse(status_code=302, body=b"", headers={"location": "http://evil.example/r.zip"}),
        ],
        calls,
    )
    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    with pytest.raises(nvidia_media.MediaError, match="safe nahi"):
        asyncio.run(nvidia_media.generate({"kind": "video", "prompt": "A cat", "frames": 25}))
    assert len(calls) == 3


def test_cosmos1_is_not_tried_when_the_backup_fails_for_other_reasons(monkeypatch):
    calls = []
    install_sequence_client(
        monkeypatch,
        [FakeResponse(status_code=404, text="404 page not found"), FakeResponse({"detail": "bad"}, status_code=422)],
        calls,
    )
    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    with pytest.raises(nvidia_media.MediaError, match="HTTP 422"):
        asyncio.run(nvidia_media.generate({"kind": "video", "prompt": "A cat", "frames": 25}))
    assert len(calls) == 2


def test_media_queued_202_is_reported_clearly(monkeypatch):
    calls = []
    install_sequence_client(monkeypatch, [FakeResponse(status_code=202, body=b"", headers={"nvcf-reqid": "abc"})], calls)
    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    with pytest.raises(nvidia_media.MediaError, match="HTTP 202"):
        asyncio.run(nvidia_media.generate({"kind": "video", "prompt": "A dog runs", "frames": 25}))
    assert len(calls) == 1


def test_flux_404_does_not_use_cosmos_backup_route(monkeypatch):
    calls = []
    install_sequence_client(monkeypatch, [FakeResponse(status_code=404, text="404 page not found")], calls)
    monkeypatch.setenv("NVIDIA_API_KEY", "key")
    with pytest.raises(nvidia_media.MediaError, match="HTTP 404"):
        asyncio.run(nvidia_media.generate({"kind": "image", "prompt": "A tree"}))
    assert [call[0] for call in calls] == [nvidia_media.FLUX_URL]
    assert "NVCF-POLL-SECONDS" not in calls[0][1]


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
