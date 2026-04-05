"""
Chunk text pages and add them to a KB's FAISS + BM25 index.
"""

import uuid
from typing import List

import tiktoken

from app.ingestion.parsers.base import ParsedPage
from app.kb.manager import kb_manager
from app.core.config import settings

_tokenizer = tiktoken.get_encoding("cl100k_base")


def _chunk_text(text: str, max_tokens: int, overlap: int) -> List[str]:
    """Split text into token-bounded chunks with overlap."""
    tokens = _tokenizer.encode(text)
    chunks = []
    step = max(1, max_tokens - overlap)
    for i in range(0, len(tokens), step):
        chunk_tokens = tokens[i: i + max_tokens]
        if len(chunk_tokens) < 10:
            continue
        chunks.append(_tokenizer.decode(chunk_tokens))
    return chunks


def index_document(
    kb_id: str,
    doc_id: str,
    filename: str,
    pages: List[ParsedPage],
) -> int:
    """
    Chunk pages, embed, and add to KB index.
    Returns the number of chunks created.
    """
    raw_chunks = []

    for page in pages:
        text_chunks = _chunk_text(
            page.text,
            max_tokens=settings.CHUNK_SIZE_TOKENS,
            overlap=settings.CHUNK_OVERLAP_TOKENS,
        )
        for chunk_text in text_chunks:
            raw_chunks.append({
                "id": str(uuid.uuid4()),
                "text": chunk_text,
                "source": filename,
                "doc_id": doc_id,
                "kb_id": kb_id,
                "page_num": page.page_num,
                "section": page.section,
            })

    if not raw_chunks:
        return 0

    texts = [c["text"] for c in raw_chunks]
    embeddings = kb_manager.embed_texts(texts)

    kb_manager.add_chunks(kb_id, raw_chunks, embeddings)

    return len(raw_chunks)
