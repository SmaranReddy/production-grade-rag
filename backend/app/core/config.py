import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # App
    APP_NAME: str = "Enterprise Knowledge Platform"
    DEBUG: bool = False

    # Database — SQLite by default, override with postgresql+asyncpg://... for prod
    DATABASE_URL: str = "sqlite+aiosqlite:///./enterprise_kb.db"

    # Auth
    SECRET_KEY: str = "change-me-in-production-use-openssl-rand-hex-32"
    ACCESS_TOKEN_EXPIRE_HOURS: int = 8
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    ALGORITHM: str = "HS256"

    # Groq
    GROQ_API_KEY: str = ""

    # Storage — local filesystem path for uploaded documents
    UPLOAD_DIR: str = "backend/data/uploads"

    # Index storage — per-KB FAISS + BM25 indexes
    INDEX_DIR: str = "backend/data/indexes"

    # Embedding model (must match the model used to build existing FAISS index)
    EMBEDDING_MODEL: str = "all-MiniLM-L6-v2"
    EMBEDDING_DIM: int = 384

    # Ingestion defaults
    CHUNK_SIZE_TOKENS: int = 500
    CHUNK_OVERLAP_TOKENS: int = 64
    MAX_UPLOAD_MB: int = 50

    # Rate limiting defaults (requests per minute)
    DEFAULT_RATE_LIMIT_RPM: int = 60

    # Query result cache
    CACHE_TTL_SECONDS: int = 300
    CACHE_MAX_SIZE: int = 500

    # LLM
    LLM_MODEL: str = "llama-3.1-8b-instant"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()

# Ensure storage directories exist at import time
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
os.makedirs(settings.INDEX_DIR, exist_ok=True)
