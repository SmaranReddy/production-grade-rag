import os
import logging
from groq import Groq


class AnswerGenerator:
    def __init__(self, api_key: str = None):

        self.api_key = api_key or os.getenv("GROQ_API_KEY")

        if not self.api_key:
            raise ValueError(
                "❌ GROQ API key not found. Set it in .env or pass it explicitly."
            )

        self.client = Groq(api_key=self.api_key)

    # ✅ NORMAL (non-streaming)
    def generate(self, query: str, retrieved_chunks: list[str]) -> str:

        context = "\n\n".join(retrieved_chunks)

        prompt = f"""
You are an enterprise knowledge assistant.

Rules:
- Answer ONLY using the provided context.
- If the answer is not present in the context, say:
  "I don't have enough information to answer this question."
- Be concise and precise.

Context:
{context}

Question:
{query}

Answer:
"""

        try:
            response = self.client.chat.completions.create(
                model="llama-3.1-8b-instant",
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
            )

            return response.choices[0].message.content.strip()

        except Exception as e:
            logging.error("❌ Error generating answer: %s", str(e))
            return "Error generating response. Please try again."

    # 🔥 STREAMING VERSION (NEW)
    def stream_generate(self, query: str, retrieved_chunks: list[str]):

        context = "\n\n".join(retrieved_chunks)

        prompt = f"""
You are an enterprise knowledge assistant.

Rules:
- Answer ONLY using the provided context.
- If the answer is not present in the context, say:
  "I don't have enough information to answer this question."
- Be concise and precise.

Context:
{context}

Question:
{query}

Answer:
"""

        try:
            stream = self.client.chat.completions.create(
                model="llama-3.1-8b-instant",
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                stream=True  # 🔥 KEY
            )

            for chunk in stream:
                if chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content

        except Exception as e:
            logging.error("❌ Streaming error: %s", str(e))
            yield "Error generating response."