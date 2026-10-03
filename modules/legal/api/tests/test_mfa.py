import time

import pyotp

from legalai import mfa
from legalai.db import session_scope
from legalai.models import User


def totp_for(secret, offset=0):
    return pyotp.TOTP(secret).at(int(time.time()) + offset * 30)


def enroll(a):
    s = a.post("/api/auth/mfa/setup").json()
    assert "<svg" in s["qr_svg"] and s["otpauth_uri"].startswith("otpauth://totp/") and "Legal%20AI" in s["otpauth_uri"]
    r = a.post("/api/auth/mfa/enable", json={"code": totp_for(s["secret"])})
    assert r.status_code == 200, r.text
    return s["secret"], r.json()["recovery_codes"]


def login_start(client, email="admin@example.com"):
    return client.post("/api/auth/login", json={"email": email, "password": "correct horse battery"})


def test_enrollment_requires_valid_code_and_gives_recovery_codes(make_api):
    a = make_api("admin@example.com")
    s = a.post("/api/auth/mfa/setup").json()
    assert a.post("/api/auth/mfa/enable", json={"code": "000000"}).status_code == 401
    assert a.get("/api/auth/mfa/status").json()["enabled"] is False
    r = a.post("/api/auth/mfa/enable", json={"code": totp_for(s["secret"])}).json()
    assert len(r["recovery_codes"]) == 10 and all(len(c) == 11 and c[5] == "-" for c in r["recovery_codes"])
    assert a.get("/api/auth/mfa/status").json() == {"enabled": True, "recovery_codes_left": 10}
    assert a.post("/api/auth/mfa/setup").status_code == 409                    # cannot silently re-enroll
    with session_scope() as db:                                                # secret is encrypted, recovery codes hashed
        u = db.query(User).one()
        assert s["secret"] not in u.mfa_secret_enc and mfa.decrypt_secret(u.mfa_secret_enc) == s["secret"]


def test_login_needs_second_factor_and_no_session_before_it(make_api):
    from fastapi.testclient import TestClient
    from legalai.main import create_app
    a = make_api("admin@example.com")
    secret, _ = enroll(a)
    c = TestClient(create_app())
    r = login_start(c).json()
    assert r["mfa_required"] is True and "user" not in r and not c.cookies
    assert c.get("/api/matters").status_code == 401                              # password alone gives nothing
    assert c.post("/api/auth/login/mfa", json={"mfa_token": r["mfa_token"], "code": "123456"}).status_code == 401
    assert c.get("/api/matters").status_code == 401
    ok = c.post("/api/auth/login/mfa", json={"mfa_token": r["mfa_token"], "code": totp_for(secret, 1)})
    assert ok.status_code == 200 and ok.json()["user"]["mfa_enabled"] is True
    assert c.get("/api/matters").status_code == 200


def test_totp_code_cannot_be_replayed(make_api):
    from fastapi.testclient import TestClient
    from legalai.main import create_app
    a = make_api("admin@example.com")
    secret, _ = enroll(a)
    code = totp_for(secret, 1)                                                   # a step the enrollment code has not used
    c1, c2 = TestClient(create_app()), TestClient(create_app())
    assert c1.post("/api/auth/login/mfa", json={"mfa_token": login_start(c1).json()["mfa_token"], "code": code}).status_code == 200
    assert c2.post("/api/auth/login/mfa", json={"mfa_token": login_start(c2).json()["mfa_token"], "code": code}).status_code == 401


def test_recovery_code_works_once(make_api):
    from fastapi.testclient import TestClient
    from legalai.main import create_app
    a = make_api("admin@example.com")
    _, codes = enroll(a)
    for attempt, expect in ((1, 200), (2, 401)):
        c = TestClient(create_app())
        r = c.post("/api/auth/login/mfa", json={"mfa_token": login_start(c).json()["mfa_token"], "code": codes[0]})
        assert r.status_code == expect
    assert a.get("/api/auth/mfa/status").json()["recovery_codes_left"] == 9


def test_mfa_token_is_signed_expiring_and_user_bound():
    tok = mfa.sign_token("user-1", ttl=60)
    assert mfa.verify_token(tok) == "user-1"
    assert mfa.verify_token(tok[:-2] + "00") is None and mfa.verify_token("garbage") is None
    assert mfa.verify_token(mfa.sign_token("user-1", ttl=-5)) is None
    payload, sig = tok.rsplit(".", 1)
    forged = mfa.sign_token("admin").split(".")[0] + "." + sig
    assert mfa.verify_token(forged) is None


def test_disable_requires_password_and_code_and_admin_can_reset(make_api):
    admin, bob = make_api("admin@example.com"), make_api("bob@example.com")
    secret, _ = enroll(bob)
    assert bob.post("/api/auth/mfa/disable", json={"password": "wrong password!!", "code": totp_for(secret, 1)}).status_code == 401
    assert bob.post("/api/auth/mfa/disable", json={"password": "correct horse battery", "code": "000000"}).status_code == 401
    assert bob.post("/api/auth/mfa/disable", json={"password": "correct horse battery", "code": totp_for(secret, 1)}).json()["enabled"] is False
    secret2, _ = enroll(bob)
    uid = next(u["id"] for u in admin.get("/api/admin/users").json() if u["email"] == "bob@example.com")
    assert bob.get("/api/matters").status_code == 200
    assert admin.post(f"/api/admin/users/{uid}/mfa-reset").status_code == 200
    assert bob.get("/api/matters").status_code == 401                            # reset also ends their sessions
    assert bob.post("/api/admin/users/%s/mfa-reset" % uid).status_code in (401, 403)
    from fastapi.testclient import TestClient
    from legalai.main import create_app
    c = TestClient(create_app())
    assert "mfa_required" not in login_start(c, "bob@example.com").json()


def test_revoke_other_sessions(make_api):
    from fastapi.testclient import TestClient
    from legalai.main import create_app
    a = make_api("admin@example.com")
    other = TestClient(create_app())
    assert login_start(other).status_code == 200 and other.get("/api/matters").status_code == 200
    assert a.post("/api/auth/sessions/revoke-others").json()["revoked"] >= 1
    assert other.get("/api/matters").status_code == 401 and a.get("/api/matters").status_code == 200


def test_mfa_attempts_are_rate_limited(make_api):
    from fastapi.testclient import TestClient
    from legalai.main import create_app
    a = make_api("admin@example.com")
    enroll(a)
    c = TestClient(create_app())
    tok = login_start(c).json()["mfa_token"]
    codes = [c.post("/api/auth/login/mfa", json={"mfa_token": tok, "code": "111111"}).status_code for _ in range(12)]
    assert codes[0] == 401 and 429 in codes
