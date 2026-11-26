"""FastAPI server entry point.

The Android app does not import this module; it uses android_entry/chat_adapter directly.
"""
import asyncio
import json
import logging
import os
import pathlib
import secrets
import uuid

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field, model_validator

import config
import health
import chat_adapter
import pipeline

_LOG = logging.getLogger(__name__)
APP_API_KEY = os.getenv("APP_API_KEY", "").strip()
ALLOW_ANONYMOUS = os.getenv("ALLOW_ANONYMOUS", "0").strip() == "1"
ENABLE_DOCS = os.getenv("ENABLE_DOCS", "0").strip() == "1"

def _positive_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


# 16 MiB is bounded while remaining above the UI's 8 MiB per-file attachment limit
# after base64/JSON overhead. Deployments can lower it with either env spelling.
MAX_CHAT_BODY_BYTES = _positive_int(
    "CHAT_MAX_BODY_BYTES", _positive_int("MAX_BODY_BYTES", 16 * 1024 * 1024)
)
MAX_INFLIGHT_REQUESTS = _positive_int("MAX_INFLIGHT_REQUESTS", 8)
_INFLIGHT = asyncio.Semaphore(MAX_INFLIGHT_REQUESTS)

_cors = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()]
# Never combine wildcard origins with credentials. An empty list means same-origin only.
CORS_ORIGINS = [origin for origin in _cors if origin != "*"]

app = FastAPI(
    title="ADARSH + Multi-Model Ensemble",
    version="5.1",
    docs_url="/docs" if ENABLE_DOCS else None,
    redoc_url="/redoc" if ENABLE_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_DOCS else None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-API-Key"],
    allow_credentials=False,
)


@app.middleware("http")
async def _reject_oversized_requests(request: Request, call_next):
    """Reject declared oversized bodies before FastAPI/Pydantic materializes them."""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_CHAT_BODY_BYTES:
                return JSONResponse({"error": "Request body is too large"}, status_code=413)
        except ValueError:
            return JSONResponse({"error": "Invalid Content-Length"}, status_code=400)
    return await call_next(request)

UI_PAGE = pathlib.Path(__file__).parent / "ui" / "dist" / "adarsh.html"


@app.on_event("startup")
async def _require_auth_configuration():
    if not APP_API_KEY and not ALLOW_ANONYMOUS:
        raise RuntimeError("APP_API_KEY is required; set ALLOW_ANONYMOUS=1 only for local development")


def _authorized(x_api_key: str | None, authorization: str | None) -> bool:
    """Fail closed, and compare supplied credentials in constant time."""
    key = os.getenv("APP_API_KEY", APP_API_KEY).strip()
    anonymous = os.getenv("ALLOW_ANONYMOUS", "1" if ALLOW_ANONYMOUS else "0").strip() == "1"
    if not key:
        return anonymous
    bearer = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else ""
    return any(candidate and secrets.compare_digest(key, candidate) for candidate in (x_api_key or "", bearer))


async def require_auth(
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
):
    if not _authorized(x_api_key, authorization):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _cid() -> str:
    return uuid.uuid4().hex[:16]


def _server_error(cid: str, status: int = 500) -> JSONResponse:
    return JSONResponse({"error": "Internal server error", "correlation_id": cid}, status_code=status)


async def _read_limited_body(request: Request) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_CHAT_BODY_BYTES:
                raise HTTPException(status_code=413, detail="Request body is too large")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length") from None
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_CHAT_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Request body is too large")
        chunks.append(chunk)
    return b"".join(chunks)


class UserAnswer(BaseModel):
    source: str = Field("", max_length=60)
    text: str = Field(min_length=1, max_length=12000)


class AskRequest(BaseModel):
    question: str = Field(min_length=2, max_length=8000)
    source: str = Field("auto", pattern="^(auto|manual|hybrid)$")
    answers: list[UserAnswer] = Field(default_factory=list, max_length=config.MAX_USER_ANSWERS)
    engine: str = Field("verified", pattern="^(verified|simple)$")
    mode: str = Field("deep", pattern="^(deep|fast)$")
    run_code: bool = True
    guard: bool = True
    debate_rounds: int = Field(1, ge=0, le=config.MAX_DEBATE_ROUNDS)
    reply_lang: str = Field("auto", pattern="^(auto|hinglish|english|hindi)$")
    depth: str = Field("normal", pattern="^(simple|normal|detailed)$")
    style: str = Field("auto", pattern="^(auto|solve|explain)$")
    debug: bool = False

    @model_validator(mode="after")
    def _check(self):
        if self.source in ("manual", "hybrid") and not self.answers:
            raise ValueError(f"source='{self.source}' needs at least one item in `answers`")
        if self.source == "auto" and self.answers:
            raise ValueError("`answers` given but source='auto'. Use source='manual' or 'hybrid'.")
        return self


def _roles() -> list[dict]:
    def row(kind, s):
        ok, why = health.available(s)
        return {
            "kind": kind,
            "role": s.role,
            "primary": s.label,
            "model": f"{s.provider}/{s.model}",
            "fallbacks": list(s.fallbacks),
            "providers_in_chain": sorted({c.provider for c in config.chain_of(s)}),
            "primary_usable_now": ok,
            "why_not": why,
        }

    rows = [row("panel", s) for s in config.PANEL]
    rows += [row("falsifier", s) for s in config.DEBATERS]
    for name in ("CLASSIFIER", "GUARD", "STRIPPER", "VERIFIER", "JUDGE", "SYNTHESIZER"):
        rows.append(row(name.lower(), getattr(config, name)))
    return rows


@app.get("/health", dependencies=[Depends(require_auth)])
async def health_check():
    return {
        "status": "ok",
        "providers_configured": {k: bool(v.api_key) for k, v in config.PROVIDERS.items()},
        "plan_problems": config.PLAN_PROBLEMS + __import__("mode_plans").PLAN_PROBLEMS,
        "roles": _roles(),
        "usage": health.snapshot(),
    }


@app.post("/ask", dependencies=[Depends(require_auth)])
async def ask(req: AskRequest):
    cid = _cid()
    try:
        async with _INFLIGHT:
            return await pipeline.run(
                req.question,
                deep=req.mode == "deep",
                debug=req.debug,
                answers=[a.model_dump() for a in req.answers],
                source=req.source,
                debate_rounds=req.debate_rounds,
                engine=req.engine,
                run_code=req.run_code,
                use_guard=req.guard,
                reply_lang=req.reply_lang,
                depth=req.depth,
                style=req.style,
            )
    except RuntimeError:
        _LOG.error("request %s failed in /ask", cid)
        return _server_error(cid, 503)
    except Exception:
        _LOG.error("request %s failed in /ask", cid)
        return _server_error(cid)


@app.post("/api/chat", dependencies=[Depends(require_auth)])
async def api_chat(request: Request):
    """The ADARSH UI talks to this endpoint."""
    cid = _cid()
    try:
        raw = await _read_limited_body(request)
        try:
            body = json.loads(raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Body must be JSON") from None
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body must be a JSON object")
        async with _INFLIGHT:
            return JSONResponse(await chat_adapter.handle(body))
    except HTTPException:
        raise
    except RuntimeError:
        _LOG.error("request %s failed in /api/chat", cid)
        return _server_error(cid, 503)
    except Exception:
        _LOG.error("request %s failed in /api/chat", cid)
        return _server_error(cid)


@app.get("/", response_class=HTMLResponse)
async def ui():
    if not UI_PAGE.exists():
        return HTMLResponse("UI not built. Run: python3 ui/build.py", status_code=404)
    page = UI_PAGE.read_text(encoding="utf-8").replace(
        "<head>", "<head><script>window.ADARSH_SAME_ORIGIN=true</script>", 1
    )
    return HTMLResponse(page)
