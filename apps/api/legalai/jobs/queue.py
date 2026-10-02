import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..models import Job, JobState as S

TRANSITIONS: dict[str, set[str]] = {
    S.NEW.value: {S.QUEUED.value, S.CANCELED.value},
    S.QUEUED.value: {S.WAITING_FOR_GPU.value, S.RUNNING.value, S.CANCELED.value, S.FAILED.value},
    S.WAITING_FOR_GPU.value: {S.RUNNING.value, S.CANCELED.value, S.FAILED.value, S.WAITING_FOR_GPU.value},
    S.RUNNING.value: {S.VALIDATING.value, S.COMPLETE.value, S.RETRYABLE.value, S.FAILED.value,
                      S.WAITING_FOR_GPU.value, S.CANCELED.value},
    S.VALIDATING.value: {S.COMPLETE.value, S.RETRYABLE.value, S.FAILED.value, S.CANCELED.value},
    S.RETRYABLE.value: {S.RUNNING.value, S.WAITING_FOR_GPU.value, S.CANCELED.value, S.FAILED.value},
    S.COMPLETE.value: set(),
    S.FAILED.value: {S.QUEUED.value},  # manual retry
    S.CANCELED.value: set(),
}
TERMINAL = {S.COMPLETE.value, S.FAILED.value, S.CANCELED.value}
RUNNABLE = (S.QUEUED.value, S.WAITING_FOR_GPU.value, S.RETRYABLE.value)

# Logical task -> model role ("Auto" routing, spec section 27).
AUTO_ROLE = {
    "extraction": "fast", "classification": "fast", "query_rewrite": "fast",
    "contract_review": "deep", "research": "deep", "drafting": "deep", "critic": "fast",
}


class InvalidTransition(Exception):
    pass


def now() -> datetime:
    return datetime.now(timezone.utc)


def transition(job: Job, new_state: str, message: str | None = None) -> None:
    new_state = getattr(new_state, "value", new_state)
    if new_state not in TRANSITIONS[job.state]:
        raise InvalidTransition(f"{job.state} -> {new_state}")
    job.state = new_state
    if message is not None:
        job.status_message = message
    if new_state in TERMINAL:
        job.finished_at = now()


def enqueue(db: DbSession, job_type: str, *, matter_id: uuid.UUID | None, user_id: uuid.UUID | None,
            payload: dict, requires_gpu: bool = False, max_attempts: int = 5) -> Job:
    job = Job(job_type=job_type, matter_id=matter_id, created_by=user_id, payload=payload,
              requires_gpu=requires_gpu, max_attempts=max_attempts, state=S.NEW.value)
    db.add(job)
    db.flush()
    transition(job, S.QUEUED.value, "Queued")
    audit(db, "job.enqueued", user_id=user_id, matter_id=matter_id, object_type="job", object_id=job.id,
          job_type=job_type, requires_gpu=requires_gpu)
    return job


def cancel(db: DbSession, job: Job, user_id: uuid.UUID) -> None:
    if job.state in TERMINAL:
        raise InvalidTransition(f"Job already {job.state}")
    transition(job, S.CANCELED.value, "Canceled by user")
    audit(db, "job.canceled", user_id=user_id, matter_id=job.matter_id, object_type="job", object_id=job.id)


def claim_next(db: DbSession) -> Job | None:
    """Lock one runnable job (SKIP LOCKED so multiple workers are safe). Caller commits."""
    return db.scalar(
        select(Job)
        .where(Job.state.in_(RUNNABLE), or_(Job.next_attempt_at.is_(None), Job.next_attempt_at <= now()))
        .order_by(Job.created_at)
        .with_for_update(skip_locked=True)
        .limit(1)
    )


def reap_stale(db: DbSession, stale_after_s: int) -> int:
    """RUNNING jobs whose worker died go back to RETRYABLE."""
    cutoff = now() - timedelta(seconds=stale_after_s)
    stale = db.scalars(select(Job).where(Job.state == S.RUNNING.value, Job.started_at < cutoff)
                       .with_for_update(skip_locked=True)).all()
    for j in stale:
        transition(j, S.RETRYABLE.value, "Worker lost; will retry")
        j.next_attempt_at = now()
    return len(stale)
