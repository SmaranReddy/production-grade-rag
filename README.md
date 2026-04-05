# Enterprise RAG Platform — Scalable Retrieval System

A production-grade Retrieval-Augmented Generation system that answers queries against internal documents using multi-stage hybrid retrieval, grounded LLM generation, and a built-in evaluation pipeline.

---

## Overview

This system enables organizations to query their internal knowledge base through natural language. It ingests documents, builds per-knowledge-base hybrid search indexes (FAISS + BM25), and answers questions using a grounded LLM that is strictly constrained to retrieved context.

The core design principle is that **retrieval determines what is true**. The LLM's role is to verbalize that truth — not to supply it. If retrieval returns no relevant material, the system refuses to answer rather than hallucinate.

The system handles multiple isolated knowledge bases, supports token-streaming responses, enforces grounding at query time, and ships with an offline evaluation pipeline that measures retrieval precision, keyword coverage, confidence accuracy, and latency.

---

## Architecture

### Component Overview

```
Document Upload
      |
      v
Ingestion Pipeline
  - Parse text (TXT / DOCX / PDF)
  - Chunk into 400-token segments (50-token overlap)
  - Embed with all-MiniLM-L6-v2
  - Persist chunks + FAISS vectors + BM25 state per KB
      |
      v
Query Endpoint
  - Optional: LLM-based query rewriting
  - Stage 1: Document Selection
      - Embed query
      - Score all chunks: 70% FAISS + 30% BM25
      - Aggregate to document level (max score per doc)
      - Select top-N documents (default: 5)
  - Stage 2: Chunk Retrieval
      - Repeat hybrid search, filtered to top-N doc set
      - Return top-10 candidate chunks
  - Grounding Check
      - Reject query if keyword overlap is absent AND top score < 0.25
  - Reranking
      - 60% hybrid score + 40% TF-IDF cosine similarity
      - Normalise so top chunk = 1.0
      - Select top-3 chunks
  - LLM Generation (Groq / llama-3.1-8b-instant)
      - Temperature: 0
      - Context: top-3 reranked chunks only
      - Streaming or non-streaming
  - Confidence Scoring
      - Weighted average of top-3 chunk scores (0.6 / 0.3 / 0.1)
      - Boost if multi-chunk agreement (avg > 0.6)
      - Answer-length factor applied
      - Set to 0.0 for grounding-failed fallback responses
      |
      v
Response
  - answer (text or SSE stream)
  - sources (top-3 chunks with text, doc_id, score)
  - confidence (0.0 – 1.0)
  - latency_ms
  - cache_hit (bool)
```

### Persistence

| Layer | Storage |
|---|---|
| Document files | `backend/data/uploads/{user_id}/{kb_id}/` |
| FAISS vector index | `backend/data/indexes/{kb_id}/` (disk-persisted) |
| BM25 index | Rebuilt in-memory from `chunks.json` on load |
| Chunk metadata | `backend/data/indexes/{kb_id}/chunks.json` |
| Users, KBs, documents, query logs | SQLite (async via aiosqlite) |
| Query cache | In-process TTL cache (300s, max 500 entries) |

---

## Retrieval System

### Stage 1 — Document Selection

Before retrieving individual chunks, the system identifies which documents are relevant. It embeds the query, scores every indexed chunk using the hybrid formula, and aggregates scores to document level by taking the maximum chunk score per document. The top `TOP_N_DOCS` documents (default: 5) are selected. All subsequent retrieval is restricted to chunks belonging to this document set.

This prevents a large knowledge base from diluting retrieval with off-topic chunks from irrelevant documents.

### Stage 2 — Chunk Retrieval

Within the filtered document set, the same hybrid search runs again against all chunks. Up to 10 candidate chunks are returned.

### Hybrid Scoring

```
hybrid_score = 0.7 * faiss_similarity + 0.3 * bm25_score
```

- **FAISS similarity**: Converted from L2 distance as `1 / (1 + L2_distance)`, yielding a [0, 1] range.
- **BM25 score**: Lexical term matching with stopword filtering, normalised to [0, 1] across the candidate set.

### Reranking

After the two-stage retrieval, a lightweight TF-IDF reranker (scikit-learn) computes cosine similarity between the query and each chunk. The final score is:

```
rerank_score = 0.6 * hybrid_score + 0.4 * tfidf_cosine
```

Scores are then normalised so that the top chunk has a score of 1.0. The top 3 chunks are passed to the LLM.

If scikit-learn is unavailable, a keyword overlap fallback is used.

---

## Grounding and Safety

The grounding check runs after Stage 2 retrieval and before reranking. It evaluates two heuristics:

1. **Keyword overlap**: At least one meaningful token from the query must appear in the retrieved chunks (stopwords are excluded).
2. **Score threshold**: The top hybrid score must be >= 0.25.

If both conditions fail, generation is skipped entirely and a fixed fallback response is returned:

> "I don't have enough information in the provided documents to answer this question."

The confidence score for fallback responses is set to `0.0`.

This prevents the LLM from generating speculative or hallucinated answers when retrieval does not surface relevant material.

### LLM Prompt Constraint

The system prompt instructs the LLM to:
- Answer only from the provided context passages.
- Say it does not know if the answer is not in the context.
- Not use prior training knowledge.

Temperature is set to 0 for deterministic output.

---

## Confidence Computation

Confidence is a [0.0, 1.0] scalar computed after reranking:

1. **Weighted average** of the top-3 chunk scores: `0.6 * s1 + 0.3 * s2 + 0.1 * s3`
2. **Multi-chunk agreement boost**: If the average of all three scores exceeds 0.6, a small boost is applied.
3. **Answer-length factor**: Very short answers receive a mild penalty.
4. **Fallback override**: If the grounding check failed, confidence is `0.0` regardless.

Confidence is returned to the client alongside the answer and is displayed in the frontend as a labeled bar (High / Medium / Low).

---

## API Design

The API is built with FastAPI. All routes under `/kb` and `/query` require JWT authentication. API key authentication is also supported.

### Auth

| Method | Endpoint | Description |
|---|---|---|
| POST | `/auth/login` | Email + password, returns JWT token |

### Knowledge Bases

| Method | Endpoint | Description |
|---|---|---|
| GET | `/kb` | List all knowledge bases for authenticated user |
| POST | `/kb` | Create a new knowledge base |

### Documents

| Method | Endpoint | Description |
|---|---|---|
| GET | `/kb/{kb_id}/documents` | List documents in a knowledge base |
| POST | `/kb/{kb_id}/documents` | Upload a document (multipart form) |
| DELETE | `/kb/{kb_id}/documents/{doc_id}` | Delete a document and remove its chunks from the index |

### Query

| Method | Endpoint | Description |
|---|---|---|
| POST | `/kb/{kb_id}/query` | Synchronous query, returns full answer JSON |
| POST | `/kb/{kb_id}/stream` | Streaming query via Server-Sent Events |

### Request Schema (Query)

```json
{
  "query": "string",
  "doc_ids": ["string"],
  "top_k": 10
}
```

`doc_ids` is optional. When provided, retrieval is scoped to those documents only, skipping Stage 1.

### Response Schema (Non-Streaming)

```json
{
  "answer": "string",
  "sources": [
    {
      "doc_id": "string",
      "filename": "string",
      "chunk_text": "string",
      "score": 0.0
    }
  ],
  "confidence": 0.0,
  "latency_ms": 0,
  "cache_hit": false
}
```

### Streaming

The `/stream` endpoint returns `text/event-stream`. Each event contains a JSON object with a `token` field. A final event with `done: true` carries the complete metadata (sources, confidence, latency).

### Observability

- Query logs are written to a `QueryLog` table in SQLite on every request.
- Prometheus metrics are exposed via `prometheus-fastapi-instrumentator`.
- Rate limiting is applied via `slowapi`.
- All query-path events are emitted as structured logs via `structlog`.

---

## Evaluation Pipeline

`backend/evaluation/evaluator.py` runs offline evaluation against a knowledge base without making HTTP calls. It directly invokes the same retrieval and generation functions used in production.

### Usage

```bash
python backend/evaluation/evaluator.py <kb_id>
# or
EVAL_KB_ID=<kb_id> python backend/evaluation/evaluator.py
```

### Test Case Format

```python
{
  "query": "What is the annual leave policy?",
  "expected_keywords": ["20 days", "annual leave"],
  "relevant_doc_ids": ["hr_policy"]   # case-insensitive substring match
}
```

### Metrics

| Metric | Description |
|---|---|
| Precision@K | Fraction of retrieved chunks whose source filename matches a `relevant_doc_ids` substring |
| Keyword Coverage | Fraction of `expected_keywords` present in the generated answer |
| Confidence Warning | Flags cases where confidence is high but keyword coverage is low, or vice versa |
| Retrieval Latency | Time taken by Stage 1 + Stage 2 retrieval |
| Total Latency | End-to-end time including generation |

Evaluation outputs per-query results and aggregate statistics to stdout.

---

## Frontend

The frontend is a Next.js application written in TypeScript.

### Capabilities

- **Authentication**: Login form with JWT storage in `localStorage`.
- **Knowledge Base Management**: Initialize a knowledge base on first login; the KB ID is persisted across sessions.
- **Document Upload**: File upload via XHR with real-time progress tracking. Documents are polled until their indexing status transitions from `processing` to `ready`.
- **Document Selection**: Users select which indexed documents to include in a query. Newly indexed documents are auto-selected on first appearance.
- **Chat Interface**: Message thread with per-message metadata. New queries stream token-by-token via SSE.
- **Confidence Display**: Each assistant message shows a labeled confidence bar (High >= 0.7, Medium >= 0.4, Low < 0.4).
- **Source Attribution**: Collapsible source panel per message showing filename, chunk text, and retrieval score.
- **Answer Actions**: Copy-to-clipboard and regenerate buttons per message.
- **Fallback Detection**: Detects grounding-failure responses by string matching and marks them visually.

---

## Tech Stack

| Component | Technology |
|---|---|
| Backend framework | FastAPI |
| Async runtime | Uvicorn + asyncio |
| Embeddings | sentence-transformers (all-MiniLM-L6-v2) |
| Vector search | faiss-cpu |
| Lexical search | rank-bm25 |
| Reranking | scikit-learn (TF-IDF cosine) |
| LLM inference | Groq API (llama-3.1-8b-instant) |
| Tokenisation | tiktoken |
| Database | SQLAlchemy (async) + aiosqlite (SQLite) |
| Authentication | python-jose (JWT) + bcrypt |
| Caching | cachetools (TTLCache) |
| Structured logging | structlog |
| Metrics | prometheus-fastapi-instrumentator |
| Rate limiting | slowapi |
| Document parsing | pymupdf, python-docx |
| Frontend framework | Next.js (TypeScript) |
| Frontend styling | Tailwind CSS |
| Containerisation | Docker + docker-compose |

---

## Setup Instructions

### Prerequisites

- Python 3.10+
- Node.js 18+
- A Groq API key (free tier available)

### Backend

```bash
# Clone and enter the repository
cd "Enterprise Knowledge RAG"

# Create a virtual environment
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env — see Environment Variables section below

# Start the backend
uvicorn backend.api.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local   # if present, else create it
# Set NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev
```

The frontend is available at `http://localhost:3000`.

### Docker (Full Stack)

```bash
docker-compose up --build
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SECRET_KEY` | Yes | JWT signing secret (use a long random string) |
| `GROQ_API_KEY` | Yes | Groq API key for LLM inference |
| `DATABASE_URL` | No | Defaults to `sqlite+aiosqlite:///./enterprise_kb.db` |
| `UPLOAD_DIR` | No | Defaults to `backend/data/uploads` |
| `INDEX_DIR` | No | Defaults to `backend/data/indexes` |
| `EMBEDDING_MODEL` | No | Defaults to `all-MiniLM-L6-v2` |
| `TOP_N_DOCS` | No | Number of documents selected in Stage 1 (default: 5) |
| `CHUNK_SIZE_TOKENS` | No | Target chunk size (default: 400) |
| `CHUNK_OVERLAP_TOKENS` | No | Overlap between adjacent chunks (default: 50) |
| `CACHE_TTL_SECONDS` | No | Query cache TTL (default: 300) |
| `ENABLE_QUERY_REWRITING` | No | LLM-based query expansion, off by default |
| `LLM_MODEL` | No | Groq model ID (default: `llama-3.1-8b-instant`) |

---

## Example Query Flow

The following traces the complete path for a query against an existing knowledge base.

1. **Client** sends `POST /kb/{kb_id}/stream` with `{"query": "What is the annual leave policy?", "doc_ids": ["doc-abc"]}`.

2. **Auth middleware** validates the JWT token and resolves the user.

3. **Cache check**: The system computes a cache key from `(kb_id, query, sorted doc_ids)`. On a miss, processing continues.

4. **Query rewriting** (if `ENABLE_QUERY_REWRITING=true`): The query is sent to the LLM with a brevity-constrained prompt to produce an expanded version. Max tokens: 64.

5. **Stage 1 — Document selection**: The query is embedded. All chunks in the KB are scored with `0.7 * FAISS_similarity + 0.3 * BM25_score`. Scores are aggregated per document (max), and the top 5 documents are selected.

6. **Stage 2 — Chunk retrieval**: The hybrid search runs again, this time restricted to chunks from the 5 selected documents. The top 10 chunks are returned.

7. **Grounding check**: The system checks that at least one non-stopword query token appears in the chunks AND that the top hybrid score >= 0.25. If both fail, a fallback response is returned immediately with confidence 0.0.

8. **Reranking**: TF-IDF cosine similarity is computed between the query and each of the 10 chunks. Scores are fused at 60/40 with the hybrid scores and normalised. The top 3 chunks are selected.

9. **LLM generation**: The top 3 chunk texts are assembled as context. A system prompt enforces context-only answering. The Groq API streams tokens back.

10. **SSE streaming**: Each token is forwarded to the client as a JSON SSE event as it arrives.

11. **Final event**: After generation completes, confidence is computed, a `QueryLog` record is written to SQLite, and a final SSE event carries sources, confidence, and latency.

12. **Client** renders the streamed tokens, then displays the confidence bar and collapsible sources panel.

---

## Key Design Decisions

### Two-Stage Retrieval

A single-stage chunk search against a large knowledge base returns chunks from many documents, most of which are irrelevant. Stage 1 performs a coarse document-level selection (5 documents) before Stage 2 does fine-grained chunk retrieval. This significantly improves precision without sacrificing recall, because the document-level aggregation (max score per doc) is a reliable first filter.

### Hybrid Search (FAISS + BM25)

Dense vector search alone fails on exact-match queries (names, codes, numeric values) because embeddings conflate semantic proximity with lexical similarity. BM25 captures exact term overlap. The 70/30 fusion preserves semantic search quality while recovering precision on keyword-heavy queries.

### Grounding Check

Without an explicit grounding gate, the LLM will generate plausible-sounding answers even when retrieval returns entirely unrelated chunks. The dual heuristic (keyword overlap + score threshold) catches two failure modes: low-confidence retrieval (score < 0.25) and queries whose key terms do not appear in any retrieved chunk. Either condition alone can be noisy; requiring both to fail before triggering the fallback reduces false refusals.

---

## Limitations

- **Ingestion supports `.txt`, `.docx`, and `.pdf` only.** Other formats are not handled.
- **Chunking is token-boundary-based, not semantic.** A 400-token chunk may split mid-sentence or mid-table. No sentence or paragraph boundary detection is applied.
- **No full-document summarization.** The system retrieves and presents chunks, not document-level summaries. Queries requiring a global view of a document (e.g., "summarise this policy") will only return partial information.
- **BM25 index is rebuilt in memory on load.** For very large knowledge bases, this adds startup latency and increases memory usage.
- **Single-tenant SQLite by default.** The `DATABASE_URL` can be pointed at PostgreSQL for production deployments, but this requires schema migration.
- **No cross-KB search.** Each query targets exactly one knowledge base. There is no federated search across multiple KBs.
- **LLM latency is bound by Groq API.** There is no local inference option in the current implementation.
- **Evaluation test cases are hard-coded in `evaluator.py`.** There is no external test suite file or dataset management tooling.

---

## Future Improvements

- **Semantic chunking**: Split on sentence or paragraph boundaries to improve chunk coherence and retrieval precision.
- **PDF table and layout extraction**: The current PDF parser uses PyMuPDF for text extraction but does not handle tables or multi-column layouts.
- **Cross-encoder reranking**: Replace the TF-IDF reranker with a cross-encoder model for higher-quality relevance scoring.
- **PostgreSQL support with migrations**: Add Alembic migration scripts to make production database setup reproducible.
- **Evaluation dataset management**: Decouple test cases from `evaluator.py` into a versioned JSON file to support dataset growth and regression tracking.
- **Multi-KB federated search**: Allow queries that span more than one knowledge base with result merging.
