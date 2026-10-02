from ..config import Settings
from .base import LLMProvider
from .local_gpu import build_local_gpu
from .openai_compat import OpenAICompatibleProvider


def build_primary(settings: Settings) -> LLMProvider | None:
    if settings.llm_primary_provider == "local_gpu":
        return build_local_gpu(settings)
    if settings.llm_primary_provider == "openai_compatible":
        # Future migration path: cloud GPU / vLLM / managed API as the primary provider.
        return OpenAICompatibleProvider(settings.llm_fallback_base_url, settings.llm_fallback_api_key, external=True)
    raise ValueError(f"Unknown LLM_PRIMARY_PROVIDER '{settings.llm_primary_provider}'")


def build_fallback(settings: Settings) -> LLMProvider | None:
    if settings.llm_fallback_provider == "disabled":
        return None
    if settings.llm_fallback_provider == "openai_compatible":
        return OpenAICompatibleProvider(settings.llm_fallback_base_url, settings.llm_fallback_api_key, external=True)
    raise ValueError(f"Unknown LLM_FALLBACK_PROVIDER '{settings.llm_fallback_provider}'")
