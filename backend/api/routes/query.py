"""Query routes — synchronous and streaming."""

import asyncio
import json
import time
import uuid
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from api.dependencies import Principal, check_rate_limit, require_scope
from app.cache.simple_cache import SimpleCache
from app.core.config import settings
from app.core.database import get_db
from app.core.models import KnowledgeBase, QueryLog
from app.core.schemas import QueryRequest, QueryResponse, SourceChunk
from app.generation.answer_generator import AnswerGenerator
from app.kb.manager import kb_manager
from app.retrieval.rerank import Reranker

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/kb/{kb_id}", tags=["Query"])

_reranker: Reranker | None = None
_generator: AnswerGenerator | None = None
_cache = SimpleCache()


def _get_reranker() -> Reranker:
    global _reranker
    if _reranker is None:
        _reranker = Reranker()
    return _reranker


def _get_generator() -> AnswerGenerator:
    global _generator
    if _generator is None:
        _generator = AnswerGenerator(api_key=settings.GROQ_API_KEY)
    return _generator


async def _get_kb_or_404(kb_id: str, org_id: str, db: AsyncSession) -> KnowledgeBase:
    kb = await db.get(KnowledgeBase, kb_id)
    if not kb or kb.org_id != org_id:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    return kb


def _compute_confidence(chunks: list) -> float:
    """
    Weighted average of top-3 scores.
    Weights: 0.6 / 0.3 / 0.1 — top chunk dominates.
    Falls back gracefully for 1 or 2 chunks.
    """
    if not chunks:
        return 0.0
    weights = [0.6, 0.3, 0.1]
    total_w = 0.0
    total_s = 0.0
    for chunk, w in zip(chunks[:3], weights):
        total_s += chunk["score"] * w
        total_w += w
    return round(total_s / total_w, 3)


# ---------------------------------------------------------------------------
# Synchronous query (returns full JSON response)
# ---------------------------------------------------------------------------

@router.post("/query", response_model=QueryResponse)
async def query_kb(
    kb_id: str,
    body: QueryRequest,
    principal: Principal = Depends(require_scope("query")),
    db: AsyncSession = Depends(get_db),
):
    check_rate_limit(principal)

    kb = await _get_kb_or_404(kb_id, principal.org_id, db)

    if kb.index_status == "empty":
        raise HTTPException(
            status_code=422,
            detail="This knowledge base has no documents yet. Upload documents first.",
        )

    # Cache check — keyed by kb_id + query text + (optional) selected doc_ids
    cache_key = f"{kb_id}:{body.query}"
    if body.doc_ids:
        cache_key += ":" + ",".join(sorted(body.doc_ids))
    cached = _cache.get(cache_key)
    if cached is not None:
        cached["request_id"] = str(uuid.uuid4())   # fresh request_id per call
        cached["cache_hit"] = True
        return QueryResponse(**cached)

    request_id = str(uuid.uuid4())
    t0 = time.perf_counter()

    # 1. Embed query
    query_embedding = kb_manager.embed_query(body.query)

    # 2. Hybrid search (FAISS + BM25)
    kb_index = kb_manager.get(kb_id)
    results = kb_index.search(query_embedding, body.query, top_k=20)

    # 2a. Filter to selected documents if doc_ids were provided
    if body.doc_ids:
        results = [c for c in results if c.get("metadata", {}).get("doc_id") in body.doc_ids]

    if not results:
        raise HTTPException(
            status_code=422,
            detail="No documents available in this knowledge base to answer the query.",
        )

    # 3. Rerank
    reranked = _get_reranker().rerank(body.query, results, top_k=body.top_k)

    # 4. Generate answer
    context = [c["text"] for c in reranked]
    answer = _get_generator().generate(query=body.query, retrieved_chunks=context)

    latency_ms = int((time.perf_counter() - t0) * 1000)
    confidence = _compute_confidence(reranked)

    sources = [
        SourceChunk(
            id=c["id"],
            text=c["text"][:300],
            source=c.get("source", ""),
            score=c["score"],
        )
        for c in reranked
    ]

    # 5. Store in cache
    cacheable = {
        "request_id": request_id,
        "answer": answer,
        "sources": [s.model_dump() for s in sources],
        "confidence": confidence,
        "latency_ms": latency_ms,
        "cache_hit": False,
        "model_used": settings.LLM_MODEL,
    }
    _cache.set(cache_key, cacheable)

    # 6. Log to DB
    log = QueryLog(
        org_id=principal.org_id,
        kb_id=kb_id,
        user_id=principal.user_id,
        api_key_id=principal.api_key_id,
        question=body.query,
        answer=answer,
        chunk_ids=[c["id"] for c in reranked],
        confidence=confidence,
        model_used=settings.LLM_MODEL,
        latency_ms=latency_ms,
        cache_hit=False,
    )
    db.add(log)
    await db.commit()

    return QueryResponse(**cacheable)


# ---------------------------------------------------------------------------
# Streaming query (SSE-style, returns text/plain stream)
# ---------------------------------------------------------------------------

@router.post("/stream")
async def stream_kb(
    kb_id: str,
    body: QueryRequest,
    principal: Principal = Depends(require_scope("query")),
    db: AsyncSession = Depends(get_db),
):
    check_rate_limit(principal)

    kb = await _get_kb_or_404(kb_id, principal.org_id, db)

    if kb.index_status == "empty":
        raise HTTPException(
            status_code=422,
            detail="This knowledge base has no documents yet.",
        )

    t0 = time.perf_counter()
    query_embedding = kb_manager.embed_query(body.query)
    kb_index = kb_manager.get(kb_id)
    results = kb_index.search(query_embedding, body.query, top_k=20)

    if body.doc_ids:
        results = [c for c in results if c.get("metadata", {}).get("doc_id") in body.doc_ids]

    if not results:
        raise HTTPException(
            status_code=422,
            detail="No documents available in this knowledge base to answer the query.",
        )

    reranked = _get_reranker().rerank(body.query, results, top_k=body.top_k)
    context = [c["text"] for c in reranked]

    async def _stream() -> AsyncIterator[str]:
        full_answer = ""
        try:
            for token in _get_generator().stream_generate(query=body.query, retrieved_chunks=context):
                full_answer += token
                yield f"data: {json.dumps({'token': token})}\n\n"
                await asyncio.sleep(0)
        except Exception as e:
            logger.error("Streaming generation error: %s", e)
            yield f"data: {json.dumps({'error': 'Error generating response'})}\n\n"
            await asyncio.sleep(0)
            return

        latency_ms = int((time.perf_counter() - t0) * 1000)
        confidence = _compute_confidence(reranked)

        sources = [
            {"id": c["id"], "text": c["text"][:300], "source": c.get("source", ""), "score": c["score"]}
            for c in reranked
        ]

        yield f"data: {json.dumps({'done': True, 'sources': sources, 'confidence': confidence, 'cache_hit': False})}\n\n"
        await asyncio.sleep(0)
        yield "data: [DONE]\n\n"
        await asyncio.sleep(0)

        log = QueryLog(
            org_id=principal.org_id,
            kb_id=kb_id,
            user_id=principal.user_id,
            api_key_id=principal.api_key_id,
            question=body.query,
            answer=full_answer,
            chunk_ids=[c["id"] for c in reranked],
            confidence=confidence,
            model_used=settings.LLM_MODEL,
            latency_ms=latency_ms,
            cache_hit=False,
        )
        from app.core.database import AsyncSessionLocal
        async with AsyncSessionLocal() as bg_db:
            bg_db.add(log)
            await bg_db.commit()

    return StreamingResponse(_stream(), media_type="text/event-stream")
