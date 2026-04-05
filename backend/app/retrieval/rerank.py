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

        # 🔥 sort
        ranked = sorted(scored, key=lambda x: x[1], reverse=True)

        return [c[0] for c in ranked[:top_k]]