Enterprise Knowledge RAG

A Production-Grade Document-Grounded LLM System

1. Project Overview

This project implements a production-grade Retrieval-Augmented Generation (RAG) system that answers organization-specific questions using verified internal documentation.

Unlike generic chatbots, the system:

retrieves relevant information deterministically,

generates answers only from retrieved context, and

refuses to answer when the information is not present.

The focus of this project is reliability, correctness, and evaluation, not just response generation.

2. Problem Statement

Large Language Models (LLMs) often:

hallucinate facts,

lack access to internal organizational knowledge,

provide confident but incorrect answers.

This project addresses these issues by grounding LLM responses in pre-processed internal documents and enforcing explicit evaluation and refusal behavior.

3. System Architecture (High Level)
Internal Docs
     ↓
Offline Ingestion
     ↓
Chunked Knowledge Base
     ↓
Vector Index (FAISS)
     ↓
Online Retrieval
     ↓
LLM Answer Generation
     ↓
Evaluated & Safe Response


Key design principle:

Retrieval determines truth.
The LLM only explains retrieved truth.

4. Project Structure
enterprise-rag/
│
├── docs/                     # Raw internal documents (source of truth)
│   └── onboarding.md
│
├── backend/
│   ├── ingestion/            # Offline pipeline
│   │   ├── load_docs.py
│   │   ├── chunk_docs.py
│   │   └── build_embeddings.py
│   │
│   ├── retrieval/            # Deterministic retrieval
│   │   ├── vector_store.py
│   │   ├── search.py
│   │   └── rerank.py
│   │
│   ├── generation/           # Controlled LLM usage
│   │   ├── answer_generator.py
│   │   ├── citation_checker.py
│   │   └── confidence.py
│   │
│   ├── evaluation/           # Reliability evaluation
│   │   ├── datasets/
│   │   │   ├── retrieval_queries.json
│   │   │   └── generation_queries.json
│   │   ├── eval_retrieval.py
│   │   ├── eval_generation.py
│   │   └── metrics.py
│   │
│   ├── data/                 # Generated artifacts
│   │   ├── chunks/
│   │   ├── embeddings/
│   │   ├── faiss.index
│   │   └── metadata.json
│   │
│   ├── scripts/              # Execution helpers
│   │   ├── ingest.py
│   │   └── demo_search.py
│   │
│   └── main.py               # API entry point
│
├── requirements.txt
└── README.md

5. Pipeline Description
5.1 Offline Ingestion (Preprocessing Phase)

Executed once before serving queries.

Steps:

Load raw documents (docs/)

Chunk documents semantically

Generate embeddings

Build FAISS vector index

Why offline?

Low latency at runtime

Deterministic behavior

Cost-efficient and scalable

5.2 Retrieval (Online Phase)

For each user query:

Query is embedded

FAISS retrieves top-K relevant chunks

(Optional) Reranking improves relevance

No LLM is involved in retrieval.

5.3 Answer Generation

Uses a Groq-hosted LLM

LLM sees only retrieved chunks

Strict instructions:

Answer only from context

Refuse if answer is not present

The LLM acts as a verbalizer, not a knowledge source.

6. Evaluation Methodology

Evaluation is separate from production logic and is a core part of the system.

6.1 Retrieval Evaluation

Metric: Recall@K

Checks whether the correct chunk appears in top-K results

Helps improve chunking and retrieval strategies

6.2 Generation Evaluation

Tests for hallucinations

Tests refusal behavior for unanswerable queries

Ensures safety and trustworthiness

Evaluation ensures the system is reliable, not just functional.

7. Technologies Used
Component	Tool
Language	Python
Chunking	LangChain
Embeddings	Sentence-Transformers
Vector Search	FAISS
LLM	Groq
API	FastAPI
Evaluation	Custom Python scripts

Each tool is used for one clear responsibility.

8. Key Features

Offline ingestion pipeline

Deterministic retrieval

Grounded LLM responses

Explicit refusal handling

Independent evaluation framework

Modular and extensible architecture

9. Conclusion

This project demonstrates how LLMs can be used safely and reliably in enterprise environments by combining:

traditional information retrieval,

modern embedding techniques,

controlled language generation,

and systematic evaluation.

The system is designed to be production-ready, explainable, and extensible.