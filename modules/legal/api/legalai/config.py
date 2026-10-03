from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "local"
    app_base_url: str = "http://localhost:8000"
    embed_origins: str = ""     # comma-separated https origins allowed to frame this app (the FounderOS shell); empty = never
    database_url: str = "postgresql+psycopg://legalai:legalai-dev@localhost:5442/legalai"
    session_secret: str = ""
    cookie_secure: bool = False
    session_ttl_hours: int = 24 * 7
    trust_proxy: bool = False  # honour X-Forwarded-For (set true behind Railway's proxy)

    run_worker: bool = True  # embed the job worker in the API process
    storage_dir: str = "./data/storage"
    max_upload_mb: int = 50
    backup_enabled: bool = False  # scheduled in-app backups (needs pg_dump in the image)
    backup_dir: str = ""  # default: <storage_dir parent>/backups
    backup_interval_hours: int = 24
    backup_include_storage: bool = False  # also tar documents into the backup (doubles volume use)
    backup_verify: bool = True
    backup_token: str = ""  # lets the off-site puller read backups without an admin session
    ocr_enabled: bool = True
    ocr_lang: str = "eng"
    ocr_dpi: int = 200
    ocr_max_pages: int = 150
    tesseract_cmd: str = ""
    courtlistener_token: str = ""
    clamav_host: str = ""  # optional clamd service for signature scanning
    clamav_port: int = 3310
    clamav_required: bool = False  # true: reject uploads when the scanner is unreachable

    vector_store: str = "pgvector"
    llm_primary_provider: str = "local_gpu"
    llm_fallback_provider: str = "disabled"  # disabled | openai_compatible
    llm_fallback_base_url: str = ""
    llm_fallback_api_key: str = ""
    llm_fallback_model: str = ""
    external_llm_monthly_budget_usd: float = 0.0
    external_llm_price_per_1k_tokens_usd: float = 0.0

    gpu_mode: str = "pull"  # pull: home node polls this API (no inbound exposure) | push: API calls a gateway URL
    gpu_claim_timeout_s: int = 90
    gpu_node_url: str = ""
    gpu_node_token: str = ""
    gpu_node_id: str = "home-gpu"
    gpu_request_timeout_s: int = 600
    gpu_retry_interval_s: int = 30
    gpu_heartbeat_stale_s: int = 120

    fast_model: str = ""
    deep_model: str = ""
    critic_model: str = ""
    extraction_model: str = ""

    embedding_provider: str = "external"
    embedding_api_key: str = ""
    embedding_model: str = "voyage-law-2"
    embedding_monthly_budget_usd: float | None = None

    local_embedding_model: str = "qwen3-embedding:0.6b"  # must produce 1024-dim vectors
    voyage_base_url: str = "https://api.voyageai.com/v1"
    embedding_price_per_1m_tokens_usd: float = 0.12
    embedding_batch_size: int = 32

    # Hybrid retrieval weights (benchmark and tune; see spec section 13)
    w_semantic: float = 10.0  # natural-language questions; tuned on the benchmark (see benchmarks/results/fusion-sweep-*.json)
    w_semantic_exact: float = 1.5  # questions containing digits, section signs or quotes keep the lexical path strong
    w_lexical: float = 1.0
    rrf_k: int = 60
    max_chunks_per_document: int = 3
    authority_scale: float = 1.0  # 0 disables authority-aware scoring
    currentness_days: int = 30    # external authority older than this is reported as 'currentness not verified'

    default_privacy_mode: str = "private"

    def backup_root(self) -> str:
        import os
        return self.backup_dir or os.path.join(os.path.dirname(os.path.abspath(self.storage_dir)), "backups")

    def model_for_role(self, role: str) -> str:
        m = {
            "fast": self.fast_model,
            "deep": self.deep_model,
            "critic": self.critic_model or self.fast_model,
            "extraction": self.extraction_model or self.fast_model,
        }.get(role, "")
        if not m:
            raise ValueError(f"No model configured for role '{role}'")
        return m


@lru_cache
def get_settings() -> Settings:
    return Settings()
