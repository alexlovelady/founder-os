from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "local"
    app_base_url: str = "http://localhost:8000"
    database_url: str = "postgresql+psycopg://legalai:legalai-dev@localhost:5442/legalai"
    session_secret: str = ""
    cookie_secure: bool = False
    session_ttl_hours: int = 24 * 7

    run_worker: bool = True  # embed the job worker in the API process
    storage_dir: str = "./data/storage"
    max_upload_mb: int = 50

    vector_store: str = "pgvector"
    llm_primary_provider: str = "local_gpu"
    llm_fallback_provider: str = "disabled"  # disabled | openai_compatible
    llm_fallback_base_url: str = ""
    llm_fallback_api_key: str = ""
    llm_fallback_model: str = ""
    external_llm_monthly_budget_usd: float = 0.0
    external_llm_price_per_1k_tokens_usd: float = 0.0

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

    default_privacy_mode: str = "private"

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
