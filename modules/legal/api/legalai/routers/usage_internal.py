"""Private usage totals for the FounderOS admin page: GET /api/internal/usage?user_id=&since=  or  ?all=1&since=.

Same security model as routers/internal.py: X-Internal-Token must equal (constant time) INTERNAL_PROVISION_TOKEN; 404 when the setting is
empty or under 32 characters; hidden from OpenAPI. Totals only, never content. Requests are user-started AI jobs (not pipeline sub-steps);
tokens and cost come from provider_usage rows of those jobs. The local GPU has no per-token cost, so cost is 0 unless a paid fallback ran.
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..db import get_db
from ..middleware import client_ip
from ..models import Job, ProviderUsage
from ..quota import MIN_TOKEN_LEN, is_shell_metered
from ..security import RateLimiter

router = APIRouter(prefix="/api/internal", tags=["internal"], include_in_schema=False)
bad_token_limiter = RateLimiter(limit=20, window_s=300)

# Job types a person starts directly (one per metered action).
USER_AI_JOB_TYPES = ("llm_complete", "research", "contract_review", "draft", "redline_generation", "compare_summary")


def _gate(request: Request, x_internal_token: str | None = Header(default=None)) -> None:
    if len(get_settings().internal_provision_token) < MIN_TOKEN_LEN:
        raise HTTPException(404, "Not Found")
    if not is_shell_metered(x_internal_token):
        try:
            bad_token_limiter.check(f"ut:{client_ip(request)}")
        except HTTPException:
            raise HTTPException(429, "Too many requests", headers={"Retry-After": "60"})
        raise HTTPException(401, "Invalid token")


def _since(value: str | None) -> datetime:
    if value:
        try:
            d = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except ValueError:
            raise HTTPException(422, "since must be an ISO date or time")
    n = datetime.now(timezone.utc)
    return n.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


@router.get("/usage", dependencies=[Depends(_gate)])
def usage(user_id: uuid.UUID | None = None, all: int = 0, since: str | None = None, db: DbSession = Depends(get_db)):
    if user_id is None and not all:
        raise HTTPException(422, "Pass user_id, or all=1 for the platform total")
    start = _since(since)
    req_q = select(func.count()).select_from(Job).where(Job.job_type.in_(USER_AI_JOB_TYPES), Job.created_at >= start)
    tok_q = (select(func.coalesce(func.sum(ProviderUsage.prompt_tokens), 0), func.coalesce(func.sum(ProviderUsage.completion_tokens), 0),
                    func.coalesce(func.sum(ProviderUsage.cost_usd), 0.0))
             .select_from(ProviderUsage).join(Job, Job.id == ProviderUsage.job_id)
             .where(ProviderUsage.kind == "llm", ProviderUsage.created_at >= start))
    if user_id is not None:
        req_q = req_q.where(Job.created_by == user_id)
        tok_q = tok_q.where(Job.created_by == user_id)
    else:
        tok_q = tok_q.where(Job.created_by.isnot(None))  # skip system jobs (backups, library refresh)
        req_q = req_q.where(Job.created_by.isnot(None))
    requests = db.scalar(req_q) or 0
    prompt, completion, cost = db.execute(tok_q).one()
    return {"since": start.isoformat(), "requests": int(requests), "prompt_tokens": int(prompt), "completion_tokens": int(completion),
            "tokens": int(prompt) + int(completion), "cost_usd": float(cost)}
