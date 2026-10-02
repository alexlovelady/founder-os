"""Single-step job processor. Fail-closed: a GPU job never runs on an external provider unless
privacy.decide_fallback() says so for this matter, this job, and the budget."""
import logging
from datetime import timedelta

from ..config import Settings, get_settings
from ..db import session_scope
from ..models import GpuNode, Job, JobState as S, Matter, ProviderUsage
from ..privacy import BudgetExceeded, FallbackDecision, decide_fallback
from ..providers.base import LLMProvider, ProviderError, ProviderUnavailable
from ..providers.registry import build_fallback, build_primary
from .handlers import HANDLERS
from .queue import claim_next, now, reap_stale, transition
from ..audit import audit

log = logging.getLogger("legalai.worker")
LLM_JOB_TYPES = {"llm_complete", "research"}


async def _primary_online(provider: LLMProvider | None) -> bool:
    if provider is None:
        return False
    try:
        await provider.health()
        return True
    except (ProviderUnavailable, ProviderError):
        return False


def _wait(job: Job, settings: Settings, message: str, approval: bool = False) -> None:
    if job.state != S.WAITING_FOR_GPU.value:
        transition(job, S.WAITING_FOR_GPU, message)
    job.status_message = message
    job.needs_fallback_approval = approval
    job.next_attempt_at = now() + timedelta(seconds=settings.gpu_retry_interval_s)


def _record_usage(db, job: Job, provider: LLMProvider, result: dict, settings: Settings) -> None:
    toks = result.get("prompt_tokens", 0) + result.get("completion_tokens", 0)
    cost = toks / 1000 * settings.external_llm_price_per_1k_tokens_usd if provider.external else 0.0
    db.add(ProviderUsage(job_id=job.id, matter_id=job.matter_id, provider=provider.name, kind="llm",
                         model=result.get("model", ""), external=provider.external,
                         prompt_tokens=result.get("prompt_tokens", 0),
                         completion_tokens=result.get("completion_tokens", 0), cost_usd=cost))


async def process_one(settings: Settings | None = None, primary: LLMProvider | None = None,
                      fallback: LLMProvider | None = None) -> bool:
    """Process at most one job. Returns True if a job was touched."""
    settings = settings or get_settings()
    primary = primary if primary is not None else build_primary(settings)
    fallback = fallback if fallback is not None else build_fallback(settings)

    # Phase A: claim and decide routing inside one short transaction.
    with session_scope() as db:
        reap_stale(db, settings.gpu_request_timeout_s + 120)
        job = claim_next(db)
        if job is None:
            return False
        provider: LLMProvider | None = None
        if job.requires_gpu:
            if await _primary_online(primary):
                provider = primary
            else:
                matter = db.get(Matter, job.matter_id) if job.matter_id else None
                if job.job_type in LLM_JOB_TYPES:
                    d = decide_fallback(db, settings, matter, job.fallback_approved)
                else:  # e.g. local embeddings: there is no external substitute, ever
                    d = FallbackDecision(False, False, "no external fallback for this job type")
                if d.allowed and fallback is not None:
                    provider = fallback
                    audit(db, "job.external_fallback_used", matter_id=job.matter_id, object_type="job",
                          object_id=job.id, provider=fallback.name)
                else:
                    msg = "Waiting for private GPU node"
                    if d.needs_approval:
                        msg += " (external fallback needs your approval)"
                    _wait(job, settings, msg, approval=d.needs_approval)
                    return True
        job.attempts += 1
        job.started_at = now()
        job.needs_fallback_approval = False
        job.provider_used = provider.name if provider else None
        transition(job, S.RUNNING, "Running")
        job_id, jtype = job.id, job.job_type

    # Phase B: execute outside any lock.
    handler = HANDLERS.get(jtype)
    outcome, result, err = "ok", None, None
    try:
        if handler is None:
            raise ProviderError(f"No handler for job type '{jtype}'")
        with session_scope() as db:
            job = db.get(Job, job_id)
        result = await handler(job, provider, settings)
    except ProviderUnavailable as e:
        outcome, err = "unavailable", str(e)
    except BudgetExceeded as e:
        outcome, err = "permanent", str(e)
    except Exception as e:  # noqa: BLE001 - recorded on the job
        outcome, err = "error", f"{type(e).__name__}: {e}"
        log.exception("job %s failed", job_id)

    # Phase C: persist the outcome (respect cancellation that happened while running).
    with session_scope() as db:
        job = db.get(Job, job_id, with_for_update=True)
        if job.state == S.CANCELED.value:
            return True
        if outcome == "ok":
            transition(job, S.VALIDATING, "Validating")
            # Phase 4 plugs citation/quote validation in here.
            if provider is not None and jtype in LLM_JOB_TYPES:
                _record_usage(db, job, provider, result, settings)
                job.model_used = result.get("model", job.model_used)
            job.result, job.error = result, None
            transition(job, S.COMPLETE, "Complete")
            audit(db, "job.completed", matter_id=job.matter_id, object_type="job", object_id=job.id,
                  provider=job.provider_used, model=job.model_used)
        elif outcome == "unavailable":
            job.attempts -= 1  # an outage is not the job's fault
            _wait(job, settings, "Waiting for private GPU node" if job.requires_gpu
                  else f"Retrying shortly: {err}")
        else:
            job.error = err
            if outcome == "permanent" or job.attempts >= job.max_attempts:
                transition(job, S.FAILED, "Failed")
            else:
                transition(job, S.RETRYABLE, "Will retry")
                job.next_attempt_at = now() + timedelta(seconds=min(300, 10 * 2 ** job.attempts))
    return True


def mark_stale_nodes(settings: Settings) -> None:
    with session_scope() as db:
        cutoff = now() - timedelta(seconds=settings.gpu_heartbeat_stale_s)
        for n in db.query(GpuNode).filter(GpuNode.status == "online", GpuNode.last_heartbeat_at < cutoff):
            n.status = "offline"
