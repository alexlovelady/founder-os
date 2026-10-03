"""Private shell-to-LegalAI signup endpoint: POST /api/internal/users."""
import hmac

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from legalai import db as dbmod

TOKEN = "t" * 40
H = {"X-Internal-Token": TOKEN}
GOOD = {"email": "New.Person@Example.com", "password": "a long enough password", "display_name": "New Person"}


@pytest.fixture
def app_client(monkeypatch):
    monkeypatch.setenv("INTERNAL_PROVISION_TOKEN", TOKEN)
    from legalai.config import get_settings
    get_settings.cache_clear()
    from legalai.routers import internal
    internal.bad_token_limiter.reset()
    internal.provision_limiter.reset()
    from legalai.main import create_app
    return TestClient(create_app())


def test_404_when_token_unset(monkeypatch):
    monkeypatch.setenv("INTERNAL_PROVISION_TOKEN", "")
    from legalai.config import get_settings
    get_settings.cache_clear()
    from legalai.main import create_app
    c = TestClient(create_app())
    assert c.post("/api/internal/users", json=GOOD, headers=H).status_code == 404
    assert c.post("/api/internal/users", content=b"not json", headers=H).status_code == 404  # never 422: does not reveal itself
    assert c.post("/api/internal/users", json=GOOD).status_code == 404


def test_404_when_token_too_short(monkeypatch):
    monkeypatch.setenv("INTERNAL_PROVISION_TOKEN", "short")
    from legalai.config import get_settings
    get_settings.cache_clear()
    from legalai.main import create_app
    c = TestClient(create_app())
    assert c.post("/api/internal/users", json=GOOD, headers={"X-Internal-Token": "short"}).status_code == 404


def test_token_required(app_client):
    assert app_client.post("/api/internal/users", json=GOOD).status_code == 401
    assert app_client.post("/api/internal/users", json=GOOD, headers={"X-Internal-Token": "wrong"}).status_code == 401
    assert app_client.post("/api/internal/users", json=GOOD, headers={"X-Internal-Token": TOKEN[:-1]}).status_code == 401
    assert app_client.post("/api/internal/users", json=GOOD, headers={"X-Internal-Token": TOKEN + "x"}).status_code == 401
    with dbmod.engine().connect() as c:
        assert c.execute(text("SELECT count(*) FROM users")).scalar() == 0


def test_token_comparison_is_constant_time(monkeypatch):
    """The comparison goes through hmac.compare_digest (not ==), and non-ASCII input does not blow up."""
    calls = []
    real = hmac.compare_digest
    monkeypatch.setattr(hmac, "compare_digest", lambda a, b: (calls.append(1), real(a, b))[1])
    monkeypatch.setenv("INTERNAL_PROVISION_TOKEN", TOKEN)
    from legalai.config import get_settings
    get_settings.cache_clear()
    from legalai.main import create_app
    c = TestClient(create_app())
    assert c.post("/api/internal/users", json=GOOD, headers={"X-Internal-Token": "wrong"}).status_code == 401
    assert calls
    r = c.post("/api/internal/users", json=GOOD, headers={"X-Internal-Token".encode(): "é".encode("latin-1")})
    assert r.status_code == 401


def test_bad_token_attempts_are_rate_limited(app_client):
    codes = [app_client.post("/api/internal/users", json=GOOD, headers={"X-Internal-Token": "nope"}).status_code for _ in range(25)]
    assert codes[0] == 401 and codes[-1] == 429
    # the right token from the same source is not blocked by guesses (they only throttle further wrong guesses)
    assert app_client.post("/api/internal/users", json=GOOD, headers=H).status_code == 200


@pytest.mark.parametrize("body", [
    {"email": "not-an-email", "password": "a long enough password"},
    {"email": "a@example.com", "password": "short"},
    {"email": "a@example.com"},
    {"email": "a@example.com", "password": "a long enough password", "role": "admin"},
    {"email": "a@example.com", "password": "a long enough password", "is_active": True},
    {"email": "a@example.com", "password": "a long enough password", "display_name": "x" * 201},
])
def test_validation(app_client, body):
    assert app_client.post("/api/internal/users", json=body, headers=H).status_code == 422


def test_creates_non_admin_who_can_log_in_and_no_session_is_created(app_client):
    r = app_client.post("/api/internal/users", json=GOOD, headers=H)
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"id"}
    assert "set-cookie" not in r.headers
    assert not r.cookies
    with dbmod.engine().connect() as c:
        assert c.execute(text("SELECT count(*) FROM sessions")).scalar() == 0
        row = c.execute(text("SELECT email, role, is_active, password_hash, display_name FROM users")).one()
    assert row.email == "new.person@example.com" and row.role == "user" and row.is_active
    assert row.password_hash.startswith("$argon2") and "long enough" not in row.password_hash
    assert row.display_name == "New Person"
    # normal login works (case-insensitive email) and the account is not an admin
    lr = app_client.post("/api/auth/login", json={"email": "NEW.person@example.com", "password": GOOD["password"]})
    assert lr.status_code == 200, lr.text
    assert lr.json()["user"]["role"] == "user"
    # and cannot use admin endpoints
    assert app_client.post("/api/auth/users", json={"email": "x@example.com", "password": "another long password"},
                           headers={"x-csrf-token": lr.json()["csrf_token"]}).status_code == 403


def test_duplicate_email_is_409_and_case_insensitive(app_client):
    assert app_client.post("/api/internal/users", json=GOOD, headers=H).status_code == 200
    r = app_client.post("/api/internal/users", json={**GOOD, "email": "new.person@example.com"}, headers=H)
    assert r.status_code == 409
    assert "already exists" in r.json()["detail"]
    with dbmod.engine().connect() as c:
        assert c.execute(text("SELECT count(*) FROM users")).scalar() == 1


def test_audit_event_written_without_secrets(app_client):
    uid = app_client.post("/api/internal/users", json=GOOD, headers=H).json()["id"]
    with dbmod.engine().connect() as c:
        rows = c.execute(text("SELECT action, object_type, object_id, detail::text AS d FROM audit_events WHERE action = 'auth.user_created_internal'")).all()
    assert len(rows) == 1
    assert rows[0].object_id == uid and rows[0].object_type == "user"
    assert GOOD["password"] not in rows[0].d and GOOD["email"].lower() not in rows[0].d


def test_not_in_openapi_schema(monkeypatch):
    monkeypatch.setenv("APP_ENV", "local")
    monkeypatch.setenv("INTERNAL_PROVISION_TOKEN", TOKEN)
    from legalai.config import get_settings
    get_settings.cache_clear()
    from legalai.main import create_app
    app = create_app()
    assert not any("/internal" in p for p in app.openapi()["paths"])
