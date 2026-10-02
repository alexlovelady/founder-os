"""Backend privacy-mode enforcement. Every code path that could send matter text to an external
service MUST go through these functions; the UI is never the enforcement point."""
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from .config import Settings
from .models import FallbackMode, Matter, PrivacyMode, ProviderUsage


class PrivacyViolation(Exception):
    pass


def external_embedding_allowed(matter: Matter) -> bool:
    if matter.privacy_mode == PrivacyMode.local_only.value:
        return False
    if matter.privacy_mode == PrivacyMode.private.value:
        return bool(matter.external_embedding_enabled)
    return True  # standard


def assert_external_embedding_allowed(matter: Matter) -> None:
    if not external_embedding_allowed(matter):
        raise PrivacyViolation(f"Matter privacy mode '{matter.privacy_mode}' forbids external embeddings")


def effective_fallback_mode(matter: Matter | None) -> str:
    """local_only forces fallback off regardless of the stored setting."""
    if matter is None or matter.privacy_mode == PrivacyMode.local_only.value:
        return FallbackMode.disabled.value
    return matter.llm_fallback_mode


def validate_matter_settings(privacy_mode: str, fallback_mode: str, external_embedding_enabled: bool) -> None:
    if privacy_mode == PrivacyMode.local_only.value and (fallback_mode != "disabled" or external_embedding_enabled):
        raise PrivacyViolation("local_only matters cannot enable external fallback or external embeddings")


def month_start() -> datetime:
    n = datetime.now(timezone.utc)
    return n.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def external_llm_spend(db: DbSession) -> float:
    return float(db.scalar(select(func.coalesce(func.sum(ProviderUsage.cost_usd), 0.0)).where(
        ProviderUsage.kind == "llm", ProviderUsage.external.is_(True),
        ProviderUsage.created_at >= month_start())) or 0.0)


@dataclass
class FallbackDecision:
    allowed: bool          # may run on the external provider right now
    needs_approval: bool   # user must approve this job first
    reason: str


def decide_fallback(db: DbSession, settings: Settings, matter: Matter | None, job_approved: bool) -> FallbackDecision:
    """Fail closed: every condition must hold before any private text goes to an external LLM."""
    if settings.llm_fallback_provider == "disabled" or not settings.llm_fallback_base_url:
        return FallbackDecision(False, False, "external fallback provider not configured")
    mode = effective_fallback_mode(matter)
    if mode == FallbackMode.disabled.value:
        return FallbackDecision(False, False, "external fallback disabled for this matter")
    if settings.external_llm_monthly_budget_usd <= 0:
        return FallbackDecision(False, False, "external LLM budget is $0")
    if external_llm_spend(db) >= settings.external_llm_monthly_budget_usd:
        return FallbackDecision(False, False, "external LLM monthly budget exhausted")
    if mode == FallbackMode.ask.value and not job_approved:
        return FallbackDecision(False, True, "waiting for user approval to use external fallback")
    return FallbackDecision(True, False, "external fallback permitted")


# ---- embeddings -----------------------------------------------------------------------------------------
class BudgetExceeded(Exception):
    """Permanent: retrying will not help until the budget is raised or the month rolls over."""


def embedding_route(matter: Matter, settings: Settings) -> str:
    """'external' only when the matter's privacy mode permits it AND an external provider is configured.
    Everything else is embedded locally on the private GPU (fail closed: never the reverse)."""
    if (settings.embedding_provider == "external" and settings.embedding_api_key
            and external_embedding_allowed(matter)):
        return "external"
    return "local"


def embedding_model_id(matter: Matter, settings: Settings) -> str:
    return (f"voyage:{settings.embedding_model}" if embedding_route(matter, settings) == "external"
            else f"local:{settings.local_embedding_model}")


def embedding_spend(db: DbSession) -> float:
    return float(db.scalar(select(func.coalesce(func.sum(ProviderUsage.cost_usd), 0.0)).where(
        ProviderUsage.kind == "embedding", ProviderUsage.external.is_(True),
        ProviderUsage.created_at >= month_start())) or 0.0)


def assert_embedding_budget(db: DbSession, settings: Settings) -> None:
    cap = settings.embedding_monthly_budget_usd
    if cap is not None and embedding_spend(db) >= cap:
        raise BudgetExceeded("Embedding monthly budget exhausted")
