import numpy as np


class Reranker:
    def __init__(self):
        pass  # lightweight reranker loaded

    def rerank(self, query, chunks, top_k=3):
        """
        Simple reranker (no heavy models)
        Uses keyword overlap + original score
        """

        query_terms = set(query.lower().split())

        scored = []

        for chunk in chunks:
            text = chunk["text"].lower()
            chunk_terms = set(text.split())

            # 🔥 overlap score
            overlap = len(query_terms & chunk_terms)

            # 🔥 combine with existing score
            final_score = chunk["score"] + 0.1 * overlap

            scored.append((chunk, final_score))

        # sort
        ranked = sorted(scored, key=lambda x: x[1], reverse=True)[:top_k]

        # Normalize reranker scores to [0, 1] so the top chunk is 1.0
        # and others are relative to it.  Avoids scores > 1 from the overlap bonus.
        top_score = ranked[0][1] if ranked else 1.0
        if top_score <= 0:
            top_score = 1.0

        return [
            {**chunk, "score": round(score / top_score, 4)}
            for chunk, score in ranked
        ]