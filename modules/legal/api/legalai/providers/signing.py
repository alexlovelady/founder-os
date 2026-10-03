"""Request signing shared (by copy) with services/gpu-gateway/signing.py.
signature = HMAC-SHA256(secret, f"{timestamp}\n{METHOD}\n{path}\n{sha256(body)}")"""
import hashlib
import hmac
import time


def sign(secret: str, method: str, path: str, body: bytes, timestamp: int | None = None) -> dict[str, str]:
    ts = str(timestamp if timestamp is not None else int(time.time()))
    msg = f"{ts}\n{method.upper()}\n{path}\n{hashlib.sha256(body).hexdigest()}"
    sig = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()
    return {"X-Timestamp": ts, "X-Signature": sig}


def verify(secret: str, method: str, path: str, body: bytes, ts: str, sig: str, max_skew_s: int = 60) -> bool:
    try:
        if abs(time.time() - int(ts)) > max_skew_s:
            return False
    except ValueError:
        return False
    expected = sign(secret, method, path, body, int(ts))["X-Signature"]
    return hmac.compare_digest(expected, sig)
