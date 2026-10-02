import hashlib
import hmac
import secrets
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from .config import get_settings
from .db import get_db
from .models import Session, User, Matter, MatterMember

SESSION_COOKIE = "legalai_session"
CSRF_HEADER = "x-csrf-token"
ROLE_RANK = {"viewer": 1, "editor": 2, "owner": 3}

_ph = PasswordHasher()


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, pw)
    except (VerifyMismatchError, InvalidHashError):
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db: DbSession, user: User) -> tuple[str, Session]:
    token = secrets.token_urlsafe(48)
    s = Session(
        user_id=user.id,
        token_hash=_token_hash(token),
        csrf_token=secrets.token_urlsafe(32),
        expires_at=datetime.now(timezone.utc) + timedelta(hours=get_settings().session_ttl_hours),
    )
    db.add(s)
    db.flush()
    return token, s


class RateLimiter:
    """In-process sliding window. Adequate for a single API instance; move to the DB/Redis if scaled out."""

    def __init__(self, limit: int, window_s: int):
        self.limit, self.window = limit, window_s
        self.hits: dict[str, deque] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.monotonic()
        q = self.hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.limit:
            raise HTTPException(429, "Too many requests")
        q.append(now)

    def reset(self):
        self.hits.clear()


login_limiter = RateLimiter(limit=10, window_s=300)


class AuthContext:
    def __init__(self, user: User, session: Session):
        self.user, self.session = user, session


def current_auth(request: Request, db: DbSession = Depends(get_db)) -> AuthContext:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(401, "Not authenticated")
    s = db.scalar(select(Session).where(Session.token_hash == _token_hash(token)))
    if not s or s.expires_at < datetime.now(timezone.utc):
        raise HTTPException(401, "Session expired")
    user = db.get(User, s.user_id)
    if not user or not user.is_active or user.deleted_at:
        raise HTTPException(401, "Not authenticated")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        sent = request.headers.get(CSRF_HEADER, "")
        if not hmac.compare_digest(sent, s.csrf_token):
            raise HTTPException(403, "CSRF token missing or invalid")
    return AuthContext(user, s)


def current_user(auth: AuthContext = Depends(current_auth)) -> User:
    return auth.user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "Admin only")
    return user


def get_matter_access(db: DbSession, user: User, matter_id: uuid.UUID, min_role: str = "viewer") -> tuple[Matter, str]:
    """Matter-level authorization. Admins get NO implicit access to matter content.
    Returns 404 (not 403) for matters the user cannot see, to avoid leaking existence."""
    m = db.get(Matter, matter_id)
    mem = None
    if m and not m.deleted_at:
        mem = db.scalar(select(MatterMember).where(MatterMember.matter_id == matter_id, MatterMember.user_id == user.id))
    if not m or m.deleted_at or not mem:
        raise HTTPException(404, "Matter not found")
    if ROLE_RANK[mem.role] < ROLE_RANK[min_role]:
        raise HTTPException(403, "Insufficient matter permission")
    return m, mem.role


def node_auth_ok(authorization: str | None) -> bool:
    expected = get_settings().gpu_node_token
    if not expected or not authorization or not authorization.startswith("Bearer "):
        return False
    return hmac.compare_digest(authorization[7:], expected)
