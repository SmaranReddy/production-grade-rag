"""
Lightweight re-ranker using TF-IDF cosine similarity.

Strategy:
  final_score = 0.6 * original_hybrid_score + 0.4 * tfidf_cosine_score

Falls back to normalised keyword-overlap if sklearn is unavailable.
Selects top_k=3 by default (re-rank from top-10 hybrid candidates).
"""

import logging

import numpy as np

logger = logging.getLogger(__name__)


class Reranker:
    def rerank(self, query: str, chunks: list, top_k: int = 3) -> list:
        """
        Re-rank chunks by combining hybrid retrieval score with TF-IDF cosine
        similarity, then return the top_k highest-scoring chunks with scores
        normalised to [0, 1].
        """
        if not chunks:
            return []

        cosine_scores = self._tfidf_cosine(query, chunks)

        scored = []
        for i, chunk in enumerate(chunks):
            # 60% retrieval score (FAISS+BM25 hybrid) + 40% lexical cosine
            final_score = 0.6 * chunk["score"] + 0.4 * float(cosine_scores[i])
            scored.append((chunk, final_score))

        ranked = sorted(scored, key=lambda x: x[1], reverse=True)[:top_k]

        # Normalise so the top chunk is always 1.0
        top_score = ranked[0][1] if ranked else 1.0
        if top_score <= 0:
            top_score = 1.0

        return [
            {**chunk, "score": round(score / top_score, 4)}
            for chunk, score in ranked
        ]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _tfidf_cosine(self, query: str, chunks: list) -> np.ndarray:
        """Return per-chunk cosine similarity scores against the query."""
        try:
            from sklearn.feature_extraction.text import TfidfVectorizer
            from sklearn.metrics.pairwise import cosine_similarity

            texts = [query] + [c["text"] for c in chunks]
            vec = TfidfVectorizer(
                stop_words="english",
                max_features=5000,
                sublinear_tf=True,   # log-normalise term frequencies
            )
            tfidf_matrix = vec.fit_transform(texts)
            scores = cosine_similarity(tfidf_matrix[0:1], tfidf_matrix[1:])[0]
            return scores.astype(float)
        except Exception as exc:
            logger.warning(
                "TF-IDF reranking unavailable, falling back to keyword overlap: %s", exc
            )
            return self._keyword_overlap(query, chunks)

    def _keyword_overlap(self, query: str, chunks: list) -> np.ndarray:
        """Normalised term-overlap fallback (no sklearn required)."""
        query_terms = set(query.lower().split())
        if not query_terms:
            return np.zeros(len(chunks))
        scores = []
        for chunk in chunks:
            chunk_terms = set(chunk["text"].lower().split())
            overlap = len(query_terms & chunk_terms)
            scores.append(overlap / len(query_terms))
        return np.array(scores)
