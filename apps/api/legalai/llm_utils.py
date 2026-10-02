"""Small helpers shared by the LLM-driven pipelines."""
import json
import re

from .config import Settings
from .providers.base import LLMProvider


def _model(provider: LLMProvider, settings: Settings, role: str) -> str:
    return settings.llm_fallback_model if provider.external and settings.llm_fallback_model else settings.model_for_role(role)

def _json_array(text: str):
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
        return v if isinstance(v, list) else None
    except ValueError:
        return None


def _strip_think(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()

class Usage:
    def __init__(self):
        self.prompt = self.completion = 0

    def add(self, r):
        self.prompt += r.prompt_tokens
        self.completion += r.completion_tokens
