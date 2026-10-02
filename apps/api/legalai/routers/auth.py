from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..models import Session, User
from ..security import (SESSION_COOKIE, AuthContext, create_session, current_auth, hash_password, login_limiter,
                        require_admin, verify_password, _token_hash)

router = APIRouter(prefix="/api/auth", tags=["auth"])
_DUMMY_HASH = hash_password("dummy-password-for-timing")


class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class NewUser(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=256)
    display_name: str = ""
    role: str = "user"


def _user_out(u: User) -> dict:
    return {"id": str(u.id), "email": u.email, "display_name": u.display_name, "role": u.role}


def _set_cookie(resp: Response, token: str) -> None:
    s = get_settings()
    resp.set_cookie(SESSION_COOKIE, token, httponly=True, secure=s.cookie_secure, samesite="lax",
                    max_age=s.session_ttl_hours * 3600, path="/")


@router.post("/bootstrap")
def bootstrap(body: NewUser, response: Response, db: DbSession = Depends(get_db)):
    """Create the first (admin) account. Only works while no users exist."""
    if db.scalar(select(func.count()).select_from(User)):
        raise HTTPException(403, "Already initialized")
    u = User(email=body.email.lower(), password_hash=hash_password(body.password),
             display_name=body.display_name, role="admin")
    db.add(u)
    db.flush()
    token, s = create_session(db, u)
    audit(db, "auth.bootstrap", user_id=u.id, object_type="user", object_id=u.id)
    db.commit()
    _set_cookie(response, token)
    return {"user": _user_out(u), "csrf_token": s.csrf_token}


@router.post("/login")
def login(body: Credentials, request: Request, response: Response, db: DbSession = Depends(get_db)):
    login_limiter.check(f"{request.client.host if request.client else 'unknown'}:{body.email.lower()}")
    u = db.scalar(select(User).where(User.email == body.email.lower()))
    ok = verify_password(body.password, u.password_hash if u else _DUMMY_HASH)  # constant-ish time
    if not u or not ok or not u.is_active or u.deleted_at:
        audit(db, "auth.login_failed", detail_email=body.email.lower())
        db.commit()
        raise HTTPException(401, "Invalid credentials")
    token, s = create_session(db, u)
    audit(db, "auth.login", user_id=u.id)
    db.commit()
    _set_cookie(response, token)
    return {"user": _user_out(u), "csrf_token": s.csrf_token}


@router.post("/logout")
def logout(response: Response, auth: AuthContext = Depends(current_auth), db: DbSession = Depends(get_db)):
    db.delete(db.get(Session, auth.session.id))
    audit(db, "auth.logout", user_id=auth.user.id)
    db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(auth: AuthContext = Depends(current_auth)):
    return {"user": _user_out(auth.user), "csrf_token": auth.session.csrf_token}


@router.post("/users", dependencies=[Depends(require_admin)])
def create_user(body: NewUser, auth: AuthContext = Depends(current_auth), db: DbSession = Depends(get_db)):
    if body.role not in ("user", "admin"):
        raise HTTPException(422, "role must be user or admin")
    if db.scalar(select(User).where(User.email == body.email.lower())):
        raise HTTPException(409, "Email already registered")
    u = User(email=body.email.lower(), password_hash=hash_password(body.password),
             display_name=body.display_name, role=body.role)
    db.add(u)
    db.flush()
    audit(db, "user.created", user_id=auth.user.id, object_type="user", object_id=u.id, role=u.role)
    db.commit()
    return _user_out(u)
