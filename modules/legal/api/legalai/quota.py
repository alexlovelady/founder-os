"""Plan metering for AI work started by a person inside LegalAI's own pages.

The FounderOS shell owns plans and limits. Before a user-initiated AI action is queued, `consume_ai_quota(user_id)` asks the shell
(`PLAN_QUOTA_URL`, authenticated with the shared INTERNAL_PROVISION_TOKEN) to count one `ai_request` for that user's business.

  * `plan_quota_url` empty: no-op (standalone LegalAI, or metering not wired yet).
  * Shell answers 402: raise HTTPException(402, <plain message>) so the page shows the plan message.
  * Anything else (timeout, network error, 5xx, bad JSON, 404 ...): FAIL OPEN. A shell outage must never block legal work.
  * Call it once per user action, before enqueuing. Child jobs spawned by a pipeline must not call it again.
"""
import hmac
import logging

import httpx
from fastapi import HTTPException

from .config import get_settings

log = logging.getLogger("legalai.quota")
TIMEOUT_S = 3.0
MIN_TOKEN_LEN = 32


def _post(url: str, token: str, user_id: str) -> tuple[int, str]:
    """One HTTP call to the shell. Returns (status, message). Raises on network errors (the caller fails open)."""
    r = httpx.post(url, json={"userId": user_id, "metric": "ai_request", "amount": 1}, headers={"X-Internal-Token": token},
                   timeout=TIMEOUT_S, follow_redirects=False)
    message = ""
    if r.status_code == 402:
        try:
            body = r.json()
            message = str(body.get("message") or "")
        except Exception:  # noqa: BLE001 - a non-JSON 402 still blocks, with a generic message
            message = ""
    return r.status_code, message


def consume_ai_quota(user_id) -> None:
    s = get_settings()
    url = (s.plan_quota_url or "").strip()
    if not url:
        return
    try:
        status, message = _post(url, s.internal_provision_token, str(user_id))
    except Exception as e:  # noqa: BLE001 - fail open on any transport problem; never log the URL query, token or body
        log.warning("plan quota check unavailable (%s); allowing the request", type(e).__name__)
        return
    if status == 402:
        raise HTTPException(402, message or "You have reached the AI request limit for your plan.")
    if status >= 300:
        log.warning("plan quota check answered HTTP %s; allowing the request", status)


def is_shell_metered(token: str | None) -> bool:
    """True when the caller proved it is the shell (internal token). The shell counts its own tool AI through ctx.useQuota, so
    LegalAI must not count that same request a second time."""
    expected = get_settings().internal_provision_token
    if not token or len(expected) < MIN_TOKEN_LEN:
        return False
    return hmac.compare_digest(token.encode("utf-8"), expected.encode("utf-8"))
