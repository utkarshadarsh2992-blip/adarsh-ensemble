import pathlib

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field, model_validator

import config
import health
import chat_adapter
import pipeline

app = FastAPI(title="ADARSH + Multi-Model Ensemble", version="5.1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-API-Key"],
)

UI_PAGE = pathlib.Path(__file__).parent / "ui" / "dist" / "adarsh.html"


def _authorized(x_api_key: str | None, authorization: str | None) -> bool:
    if not config.APP_API_KEY:
        return True
    bearer = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else None
    return config.APP_API_KEY in (x_api_key, bearer)


class UserAnswer(BaseModel):
    source: str = Field("", max_length=60)  # e.g. "ChatGPT", "Gemini" (optional label)
    text: str = Field(min_length=1, max_length=12000)


class AskRequest(BaseModel):
    question: str = Field(min_length=2, max_length=8000)

    # "auto":   our 6-model panel writes the drafts
    # "manual": you send answers from other AIs in `answers`
    # "hybrid": your answers + our panel's drafts
    source: str = Field("auto", pattern="^(auto|manual|hybrid)$")
    answers: list[UserAnswer] = Field(default_factory=list, max_length=config.MAX_USER_ANSWERS)

    # "verified": tone-strip -> Popper falsification -> Python proofs -> 3-part final answer
    # "simple":   plain debate + synthesis (cheaper, fewer API calls)
    engine: str = Field("verified", pattern="^(verified|simple)$")
    mode: str = Field("deep", pattern="^(deep|fast)$")  # fast = 3 drafters, 2 falsifiers, no OpenRouter drafts
    run_code: bool = True  # verified engine: execute Python checks in the sandbox
    guard: bool = True  # scan pasted answers for prompt injection (flag + warn only)
    debate_rounds: int = Field(1, ge=0, le=config.MAX_DEBATE_ROUNDS)  # simple engine only
    reply_lang: str = Field("auto", pattern="^(auto|hinglish|english|hindi)$")
    depth: str = Field("normal", pattern="^(simple|normal|detailed)$")
    style: str = Field("auto", pattern="^(auto|solve|explain)$")  # auto: concept questions get a plain explanation
    debug: bool = False  # drafts, claims map, falsifier reports, proofs, model trace, usage

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


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "providers_configured": {k: bool(v.api_key) for k, v in config.PROVIDERS.items()},
        "plan_problems": config.PLAN_PROBLEMS + __import__("mode_plans").PLAN_PROBLEMS,  # empty = every role spans all 3 providers
        "roles": _roles(),
        "usage": health.snapshot(),
    }


@app.post("/ask")
async def ask(
    req: AskRequest,
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
):
    if not _authorized(x_api_key, authorization):
        raise HTTPException(401, "Invalid API key")
    try:
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
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@app.post("/api/chat")
async def api_chat(
    request: Request,
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
):
    """The ADARSH UI talks to this (Settings > Connection, or automatically when served from here)."""
    if not _authorized(x_api_key, authorization):
        raise HTTPException(401, "Invalid token")
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Body must be JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "Body must be a JSON object")
    try:
        return JSONResponse(await chat_adapter.handle(body))
    except RuntimeError as e:
        # shown in the chat as a normal reply instead of a generic HTTP error
        return JSONResponse({"type": "text", "text": f"Models se jawab nahi mila: {e}"[:1500]})


@app.get("/", response_class=HTMLResponse)
async def ui():
    if not UI_PAGE.exists():
        return HTMLResponse("UI not built. Run: python3 ui/build.py", status_code=404)
    # same-origin flag: the UI then uses /api/chat without any Connection setup
    page = UI_PAGE.read_text(encoding="utf-8").replace("<head>", "<head><script>window.ADARSH_SAME_ORIGIN=true</script>", 1)
    return HTMLResponse(page)
