"""Private shell-to-LegalAI account lifecycle endpoints: lookup, set password, activate, verify password, delete."""
import time
import uuid
from pathlib import Path

import pyotp
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from legalai import db as dbmod
from legalai import mfa
from legalai.config import get_settings

TOKEN = "t" * 40
H = {"X-Internal-Token": TOKEN}
PW = "a long enough password"
NEWPW = "another long password!"


@pytest.fixture
def app_client(monkeypatch):
    monkeypatch.setenv("INTERNAL_PROVISION_TOKEN", TOKEN)
    get_settings.cache_clear()
    from legalai.routers import internal
    for lim in (internal.bad_token_limiter, internal.provision_limiter, internal.lookup_limiter, internal.verify_pw_limiter):
        lim.reset()
    from legalai.main import create_app
    return TestClient(create_app())


def mk(c, email="a@example.com", active=True, pw=PW):
    r = c.post("/api/internal/users", json={"email": email, "password": pw, "display_name": "A", "active": active}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def login(c, email="a@example.com", pw=PW):
    from legalai.main import create_app
    cl = TestClient(create_app())
    return cl, cl.post("/api/auth/login", json={"email": email, "password": pw})


def sql(q, **kw):
    with dbmod.engine().begin() as c:
        return c.execute(text(q), kw)


# ---- gate -----------------------------------------------------------------------------------------------------
ENDPOINTS = [
    ("post", "/api/internal/users/lookup", {"email": "a@example.com"}),
    ("post", f"/api/internal/users/{uuid.uuid4()}/password", {"password": NEWPW}),
    ("post", f"/api/internal/users/{uuid.uuid4()}/activate", None),
    ("post", f"/api/internal/users/{uuid.uuid4()}/verify-password", {"password": "x"}),
    ("delete", f"/api/internal/users/{uuid.uuid4()}", None),
]


@pytest.mark.parametrize("method,path,body", ENDPOINTS)
def test_404_when_unconfigured(monkeypatch, method, path, body):
    monkeypatch.setenv("INTERNAL_PROVISION_TOKEN", "")
    get_settings.cache_clear()
    from legalai.main import create_app
    c = TestClient(create_app())
    assert c.request(method, path, json=body, headers=H).status_code == 404
    assert c.request(method, path, content=b"not json", headers=H).status_code == 404


@pytest.mark.parametrize("method,path,body", ENDPOINTS)
def test_token_required(app_client, method, path, body):
    assert app_client.request(method, path, json=body).status_code == 401
    assert app_client.request(method, path, json=body, headers={"X-Internal-Token": "wrong"}).status_code == 401


def test_not_in_openapi(monkeypatch):
    monkeypatch.setenv("APP_ENV", "local")
    monkeypatch.setenv("INTERNAL_PROVISION_TOKEN", TOKEN)
    get_settings.cache_clear()
    from legalai.main import create_app
    assert not any("/internal" in p for p in create_app().openapi()["paths"])


# ---- lookup ---------------------------------------------------------------------------------------------------
def test_lookup_known_unknown_and_inactive(app_client):
    uid = mk(app_client)
    r = app_client.post("/api/internal/users/lookup", json={"email": "A@Example.com"}, headers=H)
    assert r.status_code == 200 and r.json() == {"id": uid}
    nope = app_client.post("/api/internal/users/lookup", json={"email": "nobody@example.com"}, headers=H)
    assert nope.status_code == 404 and nope.json() == {"detail": "Not found"}
    pend = mk(app_client, "pending@example.com", active=False)
    assert app_client.post("/api/internal/users/lookup", json={"email": "pending@example.com"}, headers=H).status_code == 404
    r = app_client.post("/api/internal/users/lookup", json={"email": "pending@example.com", "include_inactive": True}, headers=H)
    assert r.json() == {"id": pend}


def test_lookup_is_rate_limited_and_validates(app_client):
    assert app_client.post("/api/internal/users/lookup", json={"email": "bad"}, headers=H).status_code == 422
    assert app_client.post("/api/internal/users/lookup", json={"email": "a@example.com", "role": "admin"}, headers=H).status_code == 422
    codes = [app_client.post("/api/internal/users/lookup", json={"email": f"u{i}@example.com"}, headers=H).status_code for i in range(35)]
    assert codes[0] == 404 and codes[-1] == 429


# ---- set password ---------------------------------------------------------------------------------------------
def test_set_password_revokes_sessions_and_swaps_login(app_client):
    uid = mk(app_client)
    cl, r = login(app_client)
    assert r.status_code == 200 and cl.get("/api/auth/me").status_code == 200
    r = app_client.post(f"/api/internal/users/{uid}/password", json={"password": NEWPW}, headers=H)
    assert r.status_code == 200 and r.json() == {"ok": True} and NEWPW not in r.text
    assert cl.get("/api/auth/me").status_code == 401          # old session is gone
    assert login(app_client, pw=PW)[1].status_code == 401     # old password refused
    assert login(app_client, pw=NEWPW)[1].status_code == 200  # new one works
    row = sql("SELECT password_hash FROM users").one()
    assert row.password_hash.startswith("$argon2") and NEWPW not in row.password_hash
    ev = sql("SELECT detail::text AS d FROM audit_events WHERE action = 'auth.password_reset_internal'").all()
    assert len(ev) == 1 and NEWPW not in ev[0].d and "example.com" not in ev[0].d


def test_set_password_validation_and_unknown_user(app_client):
    uid = mk(app_client)
    assert app_client.post(f"/api/internal/users/{uid}/password", json={"password": "short"}, headers=H).status_code == 422
    assert app_client.post(f"/api/internal/users/{uid}/password", json={"password": NEWPW, "role": "admin"}, headers=H).status_code == 422
    assert app_client.post(f"/api/internal/users/{uuid.uuid4()}/password", json={"password": NEWPW}, headers=H).status_code == 404
    assert app_client.post("/api/internal/users/not-a-uuid/password", json={"password": NEWPW}, headers=H).status_code == 404
    assert login(app_client, pw=PW)[1].status_code == 200  # unchanged


def test_set_password_keeps_mfa(app_client):
    uid = mk(app_client)
    secret = pyotp.random_base32()
    with dbmod.session_scope() as db:
        from legalai.models import User
        u = db.get(User, uuid.UUID(uid))
        u.mfa_secret_enc, u.mfa_enabled = mfa.encrypt_secret(secret), True
        mfa.make_recovery_codes(db, u)
    assert app_client.post(f"/api/internal/users/{uid}/password", json={"password": NEWPW}, headers=H).status_code == 200
    row = sql("SELECT mfa_enabled, mfa_secret_enc FROM users").one()
    assert row.mfa_enabled and row.mfa_secret_enc
    assert sql("SELECT count(*) FROM mfa_recovery_codes").scalar() == 10
    cl, r = login(app_client, pw=NEWPW)
    assert r.json()["mfa_required"] is True and not cl.cookies   # still needs the second factor
    code = pyotp.TOTP(secret).at(int(time.time()))
    assert cl.post("/api/auth/login/mfa", json={"mfa_token": r.json()["mfa_token"], "code": code}).status_code == 200


# ---- activate / inactive login ----------------------------------------------------------------------------------
def test_inactive_cannot_log_in_until_activated(app_client):
    uid = mk(app_client, active=False)
    assert sql("SELECT is_active FROM users").scalar() is False
    assert login(app_client)[1].status_code == 401
    assert app_client.post(f"/api/internal/users/{uid}/activate", headers=H).json() == {"ok": True}
    assert login(app_client)[1].status_code == 200
    assert app_client.post(f"/api/internal/users/{uid}/activate", headers=H).status_code == 200  # idempotent
    assert app_client.post(f"/api/internal/users/{uuid.uuid4()}/activate", headers=H).status_code == 404
    assert sql("SELECT count(*) FROM audit_events WHERE action = 'auth.user_activated_internal'").scalar() == 1


def test_active_flag_only_through_gated_endpoint(app_client):
    # the public admin-only endpoint has no such field, and the internal one still rejects other unknown fields
    r = app_client.post("/api/internal/users", json={"email": "z@example.com", "password": PW, "is_active": False}, headers=H)
    assert r.status_code == 422


# ---- verify password --------------------------------------------------------------------------------------------
def test_verify_password_has_no_side_effects_and_is_limited(app_client):
    uid = mk(app_client)
    ok = app_client.post(f"/api/internal/users/{uid}/verify-password", json={"password": PW}, headers=H)
    assert ok.json() == {"ok": True, "last_admin": False} and "set-cookie" not in ok.headers
    assert sql("SELECT count(*) FROM sessions").scalar() == 0
    assert app_client.post(f"/api/internal/users/{uid}/verify-password", json={"password": "nope"}, headers=H).json() == {"ok": False, "last_admin": False}
    codes = [app_client.post(f"/api/internal/users/{uid}/verify-password", json={"password": "nope"}, headers=H).status_code for _ in range(6)]
    assert codes[-1] == 429


# ---- delete -----------------------------------------------------------------------------------------------------
def _matter(uid, name, role="owner", extra_member=None, files=1):
    """Create a matter with a document file, version, chunk and job; returns (matter_id, [storage keys])."""
    from legalai.models import Document, DocumentChunk, DocumentVersion, Job, Matter, MatterMember
    from legalai.storage import get_storage
    uid = uuid.UUID(str(uid))
    keys = []
    with dbmod.session_scope() as db:
        m = Matter(name=name)
        db.add(m)
        db.flush()
        db.add(MatterMember(matter_id=m.id, user_id=uid, role=role))
        if extra_member:
            db.add(MatterMember(matter_id=m.id, user_id=uuid.UUID(str(extra_member)), role="editor"))
        d = Document(matter_id=m.id, title="Doc")
        db.add(d)
        db.flush()
        vid = uuid.uuid4()
        for n in range(files):
            key = f"matters/{m.id}/documents/{d.id}/{vid if n == 0 else uuid.uuid4()}/f{n}.txt"
            get_storage().put(key, b"secret contents")
            keys.append(key)
        db.add(DocumentVersion(id=vid, document_id=d.id, version_number=1, original_filename="f0.txt", content_type="text/plain",
                               size_bytes=15, sha256="abc", storage_key=keys[0]))
        db.flush()
        db.add(DocumentChunk(matter_id=m.id, document_id=d.id, version_id=vid, chunk_index=0, text="secret contents", text_hash="h",
                             char_start=0, char_end=15))
        db.add(Job(matter_id=m.id, job_type="ingest_document", state="COMPLETE"))
        mid = m.id
    return mid, keys


def test_delete_purges_owned_matter_but_not_shared_ones(app_client):
    from legalai.storage import get_storage
    a = mk(app_client, "a@example.com")
    b = mk(app_client, "b@example.com")
    sole, sole_keys = _matter(a, "Solo", files=2)
    shared, shared_keys = _matter(a, "Shared", extra_member=b)
    theirs, theirs_keys = _matter(b, "Theirs")
    cl, _ = login(app_client, "a@example.com")
    with dbmod.session_scope() as db:
        from legalai.models import AuditEvent
        db.add(AuditEvent(action="auth.login_failed", detail={"detail_email": "a@example.com"}))
    assert cl.get("/api/auth/me").status_code == 200

    r = app_client.delete(f"/api/internal/users/{a}", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["matters_purged"] == 1 and r.json()["files_removed"] == 1  # the orphan file is swept with the matter folder and r.json()["sessions_revoked"] == 1

    # the address is scrubbed from audit detail (checked before the post-deletion login attempt below writes a new failed-login row)
    assert sql("SELECT count(*) FROM audit_events WHERE detail::text LIKE '%a@example.com%'").scalar() == 0
    st = get_storage()
    assert not any(st.exists(k) for k in sole_keys)                                         # files gone
    assert all(st.exists(k) for k in shared_keys + theirs_keys)                             # shared and others' files intact
    assert not (st.root / "matters" / str(sole)).exists()
    for tbl in ("matters", "documents", "document_chunks", "jobs"):
        col = "id" if tbl == "matters" else "matter_id"
        assert sql(f"SELECT count(*) FROM {tbl} WHERE {col} = :m", m=sole).scalar() == 0, tbl
        assert sql(f"SELECT count(*) FROM {tbl} WHERE {col} = :m", m=shared).scalar() == 1, tbl
        assert sql(f"SELECT count(*) FROM {tbl} WHERE {col} = :m", m=theirs).scalar() == 1, tbl
    assert sql("SELECT count(*) FROM document_versions WHERE storage_key = ANY(:k)", k=sole_keys[:1]).scalar() == 0
    # B kept access to the shared matter; A's membership there was dropped (A was the only owner so it stays traceable)
    members = sql("SELECT user_id::text, role FROM matter_members WHERE matter_id = :m", m=shared).all()
    assert {m.user_id for m in members} >= {b}

    u = sql("SELECT email, display_name, is_active, deleted_at, mfa_enabled, mfa_secret_enc FROM users WHERE id = :i", i=a).one()
    assert u.email.startswith("deleted-") and u.email.endswith("@invalid") and "a@example.com" not in u.email
    assert u.display_name == "Deleted user" and u.is_active is False and u.deleted_at is not None
    assert cl.get("/api/auth/me").status_code == 401                                        # session revoked
    assert login(app_client, "a@example.com")[1].status_code == 401
    assert sql("SELECT count(*) FROM sessions WHERE user_id = :i", i=a).scalar() == 0
    # email scrubbed from audit detail; deletion + purge audited; other user untouched
    assert sql("SELECT count(*) FROM audit_events WHERE action = 'auth.user_deleted_internal'").scalar() == 1
    assert sql("SELECT count(*) FROM audit_events WHERE action = 'matter.purged'").scalar() == 1
    assert login(app_client, "b@example.com")[1].status_code == 200
    # the address can be registered again
    assert app_client.post("/api/internal/users", json={"email": "a@example.com", "password": PW}, headers=H).status_code == 200


def test_delete_removes_mfa_and_is_idempotent(app_client):
    uid = mk(app_client)
    with dbmod.session_scope() as db:
        from legalai.models import User
        u = db.get(User, uuid.UUID(uid))
        u.mfa_secret_enc, u.mfa_enabled = mfa.encrypt_secret(pyotp.random_base32()), True
        mfa.make_recovery_codes(db, u)
    with dbmod.session_scope() as db:
        from legalai.models import Playbook
        db.add(Playbook(owner_id=uuid.UUID(uid), name="p"))
    assert app_client.delete(f"/api/internal/users/{uid}", headers=H).status_code == 200
    assert sql("SELECT count(*) FROM mfa_recovery_codes").scalar() == 0
    assert sql("SELECT count(*) FROM playbooks").scalar() == 0
    assert sql("SELECT mfa_enabled, mfa_secret_enc FROM users").one() == (False, None)
    assert app_client.delete(f"/api/internal/users/{uid}", headers=H).status_code == 200
    assert sql("SELECT count(*) FROM audit_events WHERE action = 'auth.user_deleted_internal'").scalar() == 1
    assert app_client.delete(f"/api/internal/users/{uuid.uuid4()}", headers=H).status_code == 404
    # lookup no longer finds the old address, and the deleted account cannot be reset or activated
    assert app_client.post("/api/internal/users/lookup", json={"email": "a@example.com", "include_inactive": True}, headers=H).status_code == 404
    assert app_client.post(f"/api/internal/users/{uid}/password", json={"password": NEWPW}, headers=H).status_code == 404
    assert app_client.post(f"/api/internal/users/{uid}/activate", headers=H).status_code == 404


def test_only_inactive_delete_refuses_active_accounts(app_client):
    active, pending = mk(app_client, "act@example.com"), mk(app_client, "pend@example.com", active=False)
    assert app_client.delete(f"/api/internal/users/{active}?only_inactive=true", headers=H).status_code == 409
    assert sql("SELECT deleted_at FROM users WHERE id = :i", i=active).scalar() is None
    assert app_client.delete(f"/api/internal/users/{pending}?only_inactive=true", headers=H).status_code == 200
    assert sql("SELECT deleted_at FROM users WHERE id = :i", i=pending).scalar() is not None


def test_delete_refuses_last_admin(app_client):
    uid = mk(app_client)
    sql("UPDATE users SET role = 'admin'")
    assert app_client.post(f"/api/internal/users/{uid}/verify-password", json={"password": PW}, headers=H).json()["last_admin"] is True
    assert app_client.delete(f"/api/internal/users/{uid}", headers=H).status_code == 409
    assert sql("SELECT deleted_at FROM users").scalar() is None


def test_delete_leaves_rows_when_a_file_cannot_be_removed(app_client, monkeypatch):
    uid = mk(app_client)
    mid, keys = _matter(uid, "Solo")
    from legalai import storage
    monkeypatch.setattr(storage.LocalVolumeStorage, "delete", lambda self, key: (_ for _ in ()).throw(OSError("disk")))
    r = app_client.delete(f"/api/internal/users/{uid}", headers=H)
    assert r.status_code == 500
    assert sql("SELECT count(*) FROM matters WHERE id = :m", m=mid).scalar() == 1      # nothing half-purged in the database
    assert sql("SELECT deleted_at FROM users").scalar() is None
    monkeypatch.undo()
    monkeypatch.setenv("INTERNAL_PROVISION_TOKEN", TOKEN)
    get_settings.cache_clear()
    assert app_client.delete(f"/api/internal/users/{uid}", headers=H).status_code == 200  # retry succeeds
    assert sql("SELECT count(*) FROM matters WHERE id = :m", m=mid).scalar() == 0
    assert not Path(get_settings().storage_dir, keys[0]).exists()
