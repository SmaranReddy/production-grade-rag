"""
Enterprise Knowledge Platform — FastAPI application entry point.

Startup order:
  1. Create DB tables
  2. Register middleware (CORS, rate limiting, structured logging, Prometheus)
  3. Register all routers
  4. Keep legacy /query, /query_full, /chat endpoints if global index exists
"""

import logging
import time
import uuid

import structlog
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from prometheus_fastapi_instrumentator import Instrumentator
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.core.config import settings
from app.core.database import create_tables

# --------------------------------------------------------------------------
# Structured logging setup (JSON output → Loki / CloudWatch)
# --------------------------------------------------------------------------

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
)

log = structlog.get_logger()
logging.basicConfig(level=logging.INFO)


# --------------------------------------------------------------------------
# Rate limiter (slowapi — per IP, override per-route with API key rate limits)
# --------------------------------------------------------------------------

limiter = Limiter(key_func=get_remote_address, default_limits=["200/minute"])


# --------------------------------------------------------------------------
# App factory
# --------------------------------------------------------------------------

app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    description="Production-grade multi-tenant enterprise knowledge platform.",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS — adjust origins for production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5500"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Prometheus metrics at /metrics
Instrumentator().instrument(app).expose(app)


# --------------------------------------------------------------------------
# Request ID + structured logging middleware
# --------------------------------------------------------------------------

@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    request_id = str(uuid.uuid4())[:8]
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        request_id=request_id,
        method=request.method,
        path=request.url.path,
    )

    t0 = time.perf_counter()
    response = await call_next(request)
    latency_ms = int((time.perf_counter() - t0) * 1000)

    log.info(
        "request_completed",
        status_code=response.status_code,
        latency_ms=latency_ms,
    )

    response.headers["X-Request-ID"] = request_id
    return response


# --------------------------------------------------------------------------
# Startup: create DB tables
# --------------------------------------------------------------------------

@app.on_event("startup")
async def startup():
    log.info("startup", msg="Creating database tables...")
    await create_tables()
    log.info("startup", msg="Database ready.")

    # Warn about missing/insecure configuration
    if not settings.GROQ_API_KEY:
        log.warning("startup", msg="GROQ_API_KEY is not set — query endpoints will fail.")
    if settings.SECRET_KEY == "change-me-in-production-use-openssl-rand-hex-32":
        log.warning("startup", msg="SECRET_KEY is using the default insecure value. Set a real secret in .env.")


# --------------------------------------------------------------------------
# Register new enterprise routers
# --------------------------------------------------------------------------

from api.routes.auth import router as auth_router
from api.routes.knowledge_bases import router as kb_router
from api.routes.documents import router as docs_router
from api.routes.query import router as query_router
from api.routes.feedback import router as feedback_router
from api.routes.api_keys import router as api_keys_router
from api.routes.metrics_route import router as metrics_router

app.include_router(auth_router)
app.include_router(kb_router)
app.include_router(docs_router)
app.include_router(query_router)
app.include_router(feedback_router)
app.include_router(api_keys_router)
app.include_router(metrics_router)


# --------------------------------------------------------------------------
# Health endpoints
# --------------------------------------------------------------------------

@app.get("/health", tags=["Health"])
async def health():
    return {"status": "ok", "version": "1.0.0"}


@app.get("/health/ready", tags=["Health"])
async def readiness():
    """Readiness probe — checks DB connectivity."""
    try:
        from app.core.database import engine
        async with engine.connect() as conn:
            await conn.execute(__import__("sqlalchemy", fromlist=["text"]).text("SELECT 1"))
        return {"status": "ready", "database": "ok"}
    except Exception as e:
        return JSONResponse(
            
            status_code=503,
            content={"status": "degraded", "database": str(e)},
        )


# --------------------------------------------------------------------------
# Legacy endpoints (kept for backward compatibility with existing clients)
# Gracefully disabled if global index files are missing.
# --------------------------------------------------------------------------

class LegacyQueryRequest(BaseModel):
    query: str


_legacy_available = False

try:
    from app.retrieval.search import hybrid_search as _global_search
    from app.retrieval.rerank import Reranker as _Reranker
    from app.generation.answer_generator import AnswerGenerator as _Gen
    from app.retrieval.query_rewriter import QueryRewriter as _QR
    from app.cache.simple_cache import SimpleCache as _Cache
    from app.memory.chat_memory import ChatMemory as _Mem

    _reranker = _Reranker()
    _rewriter = _QR()
    _cache = _Cache()
    _memory = _Mem()
    _generator = _Gen(api_key=settings.GROQ_API_KEY)
    _legacy_available = True
    log.info("legacy_endpoints", status="enabled")
except Exception as _e:
    log.info("legacy_endpoints", status="disabled", reason=str(_e))


if _legacy_available:
    @app.post("/query", tags=["Legacy"], include_in_schema=True)
    def legacy_query(request: LegacyQueryRequest):
        query = request.query
        try:
            rewritten = _rewriter.rewrite(query)
            results = _global_search(query=rewritten, top_k=20)
            if not results:
                raise HTTPException(500, "No retrieval results")
            reranked = _reranker.rerank(rewritten, results, top_k=3)
            context = [c["text"] for c in reranked]
        except Exception as e:
            raise HTTPException(500, f"Retrieval failed: {e}")

        def _stream():
            full = ""
            try:
                for token in _generator.stream_generate(rewritten, context):
                    full += token
                    yield token
                _cache.set(query, {"answer": full, "sources": reranked})
            except Exception:
                yield "\n[Error generating response]"

        return StreamingResponse(_stream(), media_type="text/plain")

    @app.post("/query_full", tags=["Legacy"], include_in_schema=True)
    def legacy_query_full(request: LegacyQueryRequest):
        query = request.query
        try:
            rewritten = _rewriter.rewrite(query)
            results = _global_search(query=rewritten, top_k=20)
            reranked = _reranker.rerank(rewritten, results, top_k=3)
            context = [c["text"] for c in reranked]
            answer = _generator.generate(rewritten, context)
            return {"answer": answer, "sources": reranked}
        except Exception as e:
            raise HTTPException(500, f"Query failed: {e}")

    @app.post("/chat", tags=["Legacy"], include_in_schema=True)
    def legacy_chat(request: LegacyQueryRequest):
        session_id = "default"
        history = _memory.get(session_id)
        try:
            rewritten = _rewriter.rewrite(request.query)
            results = _global_search(query=rewritten, top_k=20)
            reranked = _reranker.rerank(rewritten, results, top_k=3)
            context = [c["text"] for c in reranked]
            answer = _generator.generate(rewritten, context)
            _memory.add(session_id, request.query, answer)
            return {"answer": answer, "history": history[-5:], "sources": reranked}
        except Exception as e:
            raise HTTPException(500, f"Chat failed: {e}")
