"""Private service-to-service endpoints. NOT part of the public API.

Account lifecycle (same token gate, same 404-when-unconfigured behaviour, see docs/ACCOUNTS.md):
  POST   /api/internal/users/lookup            {email, include_inactive?} -> {id} | 404   (shell only; generic, rate limited)
  POST   /api/internal/users/{id}/password     {password}  set a new password, revoke ALL sessions, MFA untouched
  POST   /api/internal/users/{id}/activate     activate an account created inactive (email verification)
  POST   /api/internal/users/{id}/verify-password {password} -> {ok}  re-authentication check, creates no session
  DELETE /api/internal/users/{id}[?only_inactive=true]  delete the account (see lifecycle.py for exactly what is removed)

`POST /api/internal/users` lets the FounderOS shell create an ordinary (non-admin) account for self-serve signup.
Security model:
  * Requires header `X-Internal-Token` equal (constant time) to the INTERNAL_PROVISION_TOKEN setting.
  * If the setting is empty or shorter than 32 characters the endpoint answers 404, as if it did not exist.
  * Browsers never have the token. It must live only in the two services' server environments and must never be sent to a browser.
  * Never creates a session, never accepts a role (the body forbids unknown fields), never returns anything but the new id.
  * Hidden from the OpenAPI schema. Rate limited (failed token attempts per IP, and an overall cap per source).
"""
import hmac
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..middleware import client_ip, heavy_limiter
from ..lifecycle import PurgeFailed, delete_account, is_last_admin, revoke_sessions
from ..models import User
from ..security import RateLimiter, hash_password, verify_password

router = APIRouter(prefix="/api/internal", tags=["internal"], include_in_schema=False)

MIN_TOKEN_LEN = 32
bad_token_limiter = RateLimiter(limit=20, window_s=300)     # wrong-token guesses per source IP
provision_limiter = RateLimiter(limit=60, window_s=600)     # accepted calls per source IP (the shell is one source; it also limits per user)
lookup_limiter = RateLimiter(limit=30, window_s=600)        # email lookups per source IP (the shell also limits per hashed ip and email)
verify_pw_limiter = RateLimiter(limit=5, window_s=300)      # password re-checks per user id


class InternalNewUser(BaseModel):
    model_config = ConfigDict(extra="forbid")  # a `role` (or anything else unexpected) is a 422, never silently ignored
    email: EmailStr
    password: str = Field(min_length=12, max_length=256)
    display_name: str = Field(default="", max_length=200)
    active: bool = True  # False: created inactive (cannot sign in) until /activate is called, used for email verification


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
    u = User(email=email, password_hash=hash_password(body.password), display_name=body.display_name.strip(), role="user", is_active=body.active)
    db.add(u)
    try:
        db.flush()
    except IntegrityError:  # concurrent signup with the same email
        db.rollback()
        raise HTTPException(409, "An account with this email already exists")
    audit(db, "auth.user_created_internal", user_id=u.id, object_type="user", object_id=u.id, role="user", active=body.active)
    db.commit()
    return {"id": str(u.id)}


# ---- account lifecycle -----------------------------------------------------------------------------------------
class Lookup(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    include_inactive: bool = False  # also find accounts that are not yet active (unverified signups); never finds deleted accounts


class NewPassword(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=12, max_length=256)


class PasswordCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=256)


def _user_or_404(db: DbSession, user_id: str) -> User:
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(404, "Not found")
    u = db.get(User, uid)
    if not u:
        raise HTTPException(404, "Not found")
    return u


@router.post("/users/lookup", dependencies=[Depends(gate)])
def lookup_user(body: Lookup, request: Request, db: DbSession = Depends(get_db)):
    """For the shell only. Answers {id} or a plain 404; the shell never forwards the difference to a visitor."""
    lookup_limiter.check(f"lk:{client_ip(request)}")
    q = select(User.id).where(User.email == body.email.lower(), User.deleted_at.is_(None))
    if not body.include_inactive:
        q = q.where(User.is_active.is_(True))
    uid = db.scalar(q)
    if not uid:
        raise HTTPException(404, "Not found")
    return {"id": str(uid)}


@router.post("/users/{user_id}/password", dependencies=[Depends(gate)])
def set_password(user_id: str, body: NewPassword, db: DbSession = Depends(get_db)):
    u = _user_or_404(db, user_id)
    if u.deleted_at:
        raise HTTPException(404, "Not found")
    u.password_hash = hash_password(body.password)
    n = revoke_sessions(db, u.id)  # whoever held the old password (or a stolen session) is signed out everywhere
    # MFA is deliberately untouched: a reset link must never be a way around the second factor.
    audit(db, "auth.password_reset_internal", user_id=u.id, object_type="user", object_id=u.id, sessions_revoked=n, mfa_enabled=u.mfa_enabled)
    db.commit()
    return {"ok": True}


@router.post("/users/{user_id}/activate", dependencies=[Depends(gate)])
def activate_user(user_id: str, db: DbSession = Depends(get_db)):
    u = _user_or_404(db, user_id)
    if u.deleted_at:
        raise HTTPException(404, "Not found")
    if not u.is_active:
        u.is_active = True
        audit(db, "auth.user_activated_internal", user_id=u.id, object_type="user", object_id=u.id)
        db.commit()
    return {"ok": True}


@router.post("/users/{user_id}/verify-password", dependencies=[Depends(gate)])
def verify_user_password(user_id: str, body: PasswordCheck, db: DbSession = Depends(get_db)):
    """Re-authentication for sensitive actions (account deletion). Creates no session and does not touch MFA state."""
    u = _user_or_404(db, user_id)
    verify_pw_limiter.check(f"vp:{u.id}")
    ok = bool(u.is_active and not u.deleted_at and verify_password(body.password, u.password_hash))
    if not ok:
        audit(db, "auth.reauth_failed_internal", user_id=u.id)
        db.commit()
    return {"ok": ok, "last_admin": bool(ok and is_last_admin(db, u))}  # lets the shell refuse before it removes anything on its side


@router.delete("/users/{user_id}", dependencies=[Depends(gate)])
def delete_user(user_id: str, only_inactive: bool = False, db: DbSession = Depends(get_db)):
    """`only_inactive=true` (used by the unverified-account cleanup) refuses with 409 if the account has become active."""
    u = _user_or_404(db, user_id)
    if only_inactive and u.is_active and not u.deleted_at:
        raise HTTPException(409, "Account is active")
    try:
        out = delete_account(db, u)
        db.commit()
    except ValueError:
        db.rollback()
        raise HTTPException(409, "This is the last administrator account and cannot be deleted")
    except PurgeFailed:
        db.rollback()
        raise HTTPException(500, "Could not remove stored files; try again")
    return out
