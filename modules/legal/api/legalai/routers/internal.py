"""Private service-to-service endpoints. NOT part of the public API.

`POST /api/internal/users` lets the FounderOS shell create an ordinary (non-admin) account for self-serve signup.
Security model:
  * Requires header `X-Internal-Token` equal (constant time) to the INTERNAL_PROVISION_TOKEN setting.
  * If the setting is empty or shorter than 32 characters the endpoint answers 404, as if it did not exist.
  * Browsers never have the token. It must live only in the two services' server environments and must never be sent to a browser.
  * Never creates a session, never accepts a role (the body forbids unknown fields), never returns anything but the new id.
  * Hidden from the OpenAPI schema. Rate limited (failed token attempts per IP, and an overall cap per source).
"""
import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..middleware import client_ip, heavy_limiter
from ..models import User
from ..security import RateLimiter, hash_password

router = APIRouter(prefix="/api/internal", tags=["internal"], include_in_schema=False)

MIN_TOKEN_LEN = 32
bad_token_limiter = RateLimiter(limit=20, window_s=300)     # wrong-token guesses per source IP
provision_limiter = RateLimiter(limit=60, window_s=600)     # accepted calls per source IP (the shell is one source; it also limits per user)


class InternalNewUser(BaseModel):
    model_config = ConfigDict(extra="forbid")  # a `role` (or anything else unexpected) is a 422, never silently ignored
    email: EmailStr
    password: str = Field(min_length=12, max_length=256)
    display_name: str = Field(default="", max_length=200)


def _token_ok(sent: str | None) -> bool:
    expected = get_settings().internal_provision_token
    if not sent:
        return False
    # compare_digest on bytes handles non-ASCII input without raising
    return hmac.compare_digest(sent.encode("utf-8"), expected.encode("utf-8"))


def gate(request: Request, x_internal_token: str | None = Header(default=None)) -> None:
    """Runs before the body is parsed, so an unconfigured endpoint answers 404 even to a malformed body (never 422)."""
    if len(get_settings().internal_provision_token) < MIN_TOKEN_LEN:
        raise HTTPException(404, "Not Found")  # feature off: indistinguishable from an unknown route
    ip = client_ip(request)
    if not _token_ok(x_internal_token):
        try:
            bad_token_limiter.check(f"bt:{ip}")
        except HTTPException:
            raise HTTPException(429, "Too many requests", headers={"Retry-After": "60"})
        raise HTTPException(401, "Invalid token")
    heavy_limiter.check(f"internal:{ip}")
    provision_limiter.check(f"p:{ip}")


@router.post("/users", dependencies=[Depends(gate)])
def provision_user(body: InternalNewUser, db: DbSession = Depends(get_db)):
    email = body.email.lower()
    # Signup flows inevitably reveal "already registered"; the message is generic and the shell rate limits per email and IP.
    if db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(409, "An account with this email already exists")
    u = User(email=email, password_hash=hash_password(body.password), display_name=body.display_name.strip(), role="user")
    db.add(u)
    try:
        db.flush()
    except IntegrityError:  # concurrent signup with the same email
        db.rollback()
        raise HTTPException(409, "An account with this email already exists")
    audit(db, "auth.user_created_internal", user_id=u.id, object_type="user", object_id=u.id, role="user")
    db.commit()
    return {"id": str(u.id)}
