"""TOTP multi-factor authentication (RFC 6238): enrollment, verification with replay protection, recovery codes,
and short-lived signed tokens that carry a half-finished login between the password and code steps."""
import base64
import hashlib
import hmac
import json
import secrets
import time

import pyotp
import segno
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from .config import get_settings
from .models import MfaRecoveryCode, User

ISSUER = "Legal AI"
STEP = 30
MFA_TOKEN_TTL_S = 300


def _key() -> bytes:
    secret = get_settings().session_secret or "legalai-local-development-only"
    return hashlib.sha256(b"mfa-encryption|" + secret.encode()).digest()


def _fernet() -> Fernet:
    return Fernet(base64.urlsafe_b64encode(_key()))


def encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def decrypt_secret(blob: str) -> str | None:
    try:
        return _fernet().decrypt(blob.encode()).decode()
    except InvalidToken:
        return None


def new_secret() -> str:
    return pyotp.random_base32()


def provisioning(user: User, secret: str) -> dict:
    uri = pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name=ISSUER)
    svg = segno.make(uri, error="m").svg_inline(scale=5, dark="#000", light="#fff", border=2)
    return {"secret": secret, "otpauth_uri": uri, "qr_svg": svg}


def verify_code(user: User, code: str) -> bool:
    """Accept a code from the current or adjacent time step, but never one that was already used (replay)."""
    if not user.mfa_secret_enc:
        return False
    secret = decrypt_secret(user.mfa_secret_enc)
    code = "".join(ch for ch in (code or "") if ch.isdigit())
    if not secret or len(code) != 6:
        return False
    totp = pyotp.TOTP(secret, interval=STEP)
    now = int(time.time() // STEP)
    for step in (now, now - 1, now + 1):
        if hmac.compare_digest(totp.at(step * STEP), code):
            if user.mfa_last_step is not None and step <= user.mfa_last_step:
                return False
            user.mfa_last_step = step
            return True
    return False


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.strip().replace("-", "").lower().encode()).hexdigest()


def make_recovery_codes(db: DbSession, user: User, n: int = 10) -> list[str]:
    for r in db.scalars(select(MfaRecoveryCode).where(MfaRecoveryCode.user_id == user.id)):
        db.delete(r)
    codes = []
    for _ in range(n):
        raw = secrets.token_hex(5)  # 10 hex chars
        codes.append(f"{raw[:5]}-{raw[5:]}")
        db.add(MfaRecoveryCode(user_id=user.id, code_hash=_hash_code(raw)))
    return codes


def use_recovery_code(db: DbSession, user: User, code: str) -> bool:
    h = _hash_code(code)
    rec = db.scalar(select(MfaRecoveryCode).where(MfaRecoveryCode.user_id == user.id, MfaRecoveryCode.code_hash == h,
                                                  MfaRecoveryCode.used_at.is_(None)))
    if not rec:
        return False
    from datetime import datetime, timezone
    rec.used_at = datetime.now(timezone.utc)
    return True


def recovery_codes_left(db: DbSession, user: User) -> int:
    return len(db.scalars(select(MfaRecoveryCode).where(MfaRecoveryCode.user_id == user.id, MfaRecoveryCode.used_at.is_(None))).all())


# ---- signed half-login token ----------------------------------------------------------------------------------
def sign_token(user_id: str, ttl: int = MFA_TOKEN_TTL_S) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"u": user_id, "exp": int(time.time()) + ttl}).encode()).decode().rstrip("=")
    sig = hmac.new(_key(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def verify_token(token: str) -> str | None:
    try:
        payload, sig = token.rsplit(".", 1)
        if not hmac.compare_digest(hmac.new(_key(), payload.encode(), hashlib.sha256).hexdigest(), sig):
            return None
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return data["u"] if data["exp"] >= time.time() else None
    except (ValueError, KeyError, TypeError):
        return None
