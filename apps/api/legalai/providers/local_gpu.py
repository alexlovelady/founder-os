from ..config import Settings
from .openai_compat import OpenAICompatibleProvider
from .signing import sign


class LocalGpuProvider(OpenAICompatibleProvider):
    """Talks to the authenticated GPU gateway (never directly to Ollama)."""

    name = "local_gpu"

    def __init__(self, base_url: str, token: str, timeout_s: float = 600):
        self._token = token
        super().__init__(base_url, api_key=token, external=False, timeout_s=timeout_s,
                         headers_fn=lambda m, p, b: sign(token, m, p, b))


def build_local_gpu(settings: Settings) -> LocalGpuProvider | None:
    if not settings.gpu_node_url or not settings.gpu_node_token:
        return None
    return LocalGpuProvider(settings.gpu_node_url, settings.gpu_node_token, settings.gpu_request_timeout_s)
