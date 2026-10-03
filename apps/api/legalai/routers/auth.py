import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from .. import mfa
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
    return {"id": str(u.id), "email": u.email, "display_name": u.display_name, "role": u.role, "mfa_enabled": u.mfa_enabled}


def _set_cookie(resp: Response, token: str) -> None:
    s = get_settings()
    resp.set_cookie(SESSION_COOKIE, token, httponly=True, secure=s.cookie_secure, samesite="lax",
                    max_age=s.session_ttl_hours * 3600, path="/")


@router.get("/status")
def status(db: DbSession = Depends(get_db)):
    return {"initialized": bool(db.scalar(select(func.count()).select_from(User)))}


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
    if u.mfa_enabled:  # password was right; no session until the second factor is proven
        audit(db, "auth.mfa_challenge", user_id=u.id)
        db.commit()
        return {"mfa_required": True, "mfa_token": mfa.sign_token(str(u.id))}
    token, s = create_session(db, u)
    audit(db, "auth.login", user_id=u.id)
    db.commit()
    _set_cookie(response, token)
    return {"user": _user_out(u), "csrf_token": s.csrf_token}


class MfaLogin(BaseModel):
    mfa_token: str
    code: str = Field(min_length=4, max_length=32)


@router.post("/login/mfa")
def login_mfa(body: MfaLogin, request: Request, response: Response, db: DbSession = Depends(get_db)):
    uid = mfa.verify_token(body.mfa_token)
    login_limiter.check(f"mfa:{request.client.host if request.client else 'unknown'}:{uid or 'bad'}")
    u = db.get(User, uuid.UUID(uid)) if uid else None
    if not u or not u.is_active or u.deleted_at or not u.mfa_enabled:
        raise HTTPException(401, "Invalid or expired sign-in. Start again.")
    used_recovery = False
    if not mfa.verify_code(u, body.code):
        used_recovery = mfa.use_recovery_code(db, u, body.code)
        if not used_recovery:
            audit(db, "auth.mfa_failed", user_id=u.id)
            db.commit()
            raise HTTPException(401, "Invalid code")
    token, s = create_session(db, u)
    audit(db, "auth.login", user_id=u.id, mfa=True, recovery_code=used_recovery)
    left = mfa.recovery_codes_left(db, u)
    db.commit()
    _set_cookie(response, token)
    return {"user": _user_out(u), "csrf_token": s.csrf_token, "recovery_codes_left": left}


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


# ---- multi-factor authentication ------------------------------------------------------------------------------
class CodeBody(BaseModel):
    code: str = Field(min_length=4, max_length=32)


class DisableBody(BaseModel):
    password: str = Field(max_length=256)
    code: str = Field(min_length=4, max_length=32)


@router.post("/mfa/setup")
def mfa_setup(auth: AuthContext = Depends(current_auth), db: DbSession = Depends(get_db)):
    """Start enrollment: returns the secret and a QR code. MFA is not active until /mfa/enable confirms a code."""
    u = db.get(User, auth.user.id)
    if u.mfa_enabled:
        raise HTTPException(409, "MFA is already enabled; disable it first to re-enroll")
    secret = mfa.new_secret()
    u.mfa_secret_enc = mfa.encrypt_secret(secret)
    u.mfa_last_step = None
    audit(db, "auth.mfa_setup_started", user_id=u.id)
    db.commit()
    return mfa.provisioning(u, secret)


@router.post("/mfa/enable")
def mfa_enable(body: CodeBody, auth: AuthContext = Depends(current_auth), db: DbSession = Depends(get_db)):
    login_limiter.check(f"mfa-enable:{auth.user.id}")
    u = db.get(User, auth.user.id)
    if u.mfa_enabled or not u.mfa_secret_enc:
        raise HTTPException(409, "Start enrollment first")
    if not mfa.verify_code(u, body.code):
        raise HTTPException(401, "That code is not valid. Check your authenticator app's clock and try again.")
    u.mfa_enabled = True
    codes = mfa.make_recovery_codes(db, u)
    audit(db, "auth.mfa_enabled", user_id=u.id)
    db.commit()
    return {"enabled": True, "recovery_codes": codes}  # shown once; only hashes are stored


@router.post("/mfa/disable")
def mfa_disable(body: DisableBody, auth: AuthContext = Depends(current_auth), db: DbSession = Depends(get_db)):
    login_limiter.check(f"mfa-disable:{auth.user.id}")
    u = db.get(User, auth.user.id)
    if not u.mfa_enabled:
        raise HTTPException(409, "MFA is not enabled")
    if not verify_password(body.password, u.password_hash) or not (mfa.verify_code(u, body.code) or mfa.use_recovery_code(db, u, body.code)):
        raise HTTPException(401, "Password or code is wrong")
    u.mfa_enabled, u.mfa_secret_enc, u.mfa_last_step = False, None, None
    mfa.make_recovery_codes(db, u, 0)
    audit(db, "auth.mfa_disabled", user_id=u.id)
    db.commit()
    return {"enabled": False}


@router.get("/mfa/status")
def mfa_status(auth: AuthContext = Depends(current_auth), db: DbSession = Depends(get_db)):
    return {"enabled": auth.user.mfa_enabled, "recovery_codes_left": mfa.recovery_codes_left(db, auth.user) if auth.user.mfa_enabled else 0}


@router.post("/sessions/revoke-others")
def revoke_other_sessions(auth: AuthContext = Depends(current_auth), db: DbSession = Depends(get_db)):
    """'Sign out everywhere else'."""
    n = 0
    for s in db.scalars(select(Session).where(Session.user_id == auth.user.id, Session.id != auth.session.id)):
        db.delete(s)
        n += 1
    audit(db, "auth.sessions_revoked", user_id=auth.user.id, count=n)
    db.commit()
    return {"revoked": n}
